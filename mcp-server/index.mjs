#!/usr/bin/env node
// mcp-server/index.mjs
//
// Local MCP server for Natively's free-tier "Interview Knowledge" feature
// (electron/services/interviewKnowledge/). Lets any MCP client — Claude
// Desktop, Claude Code, another agent doing company research — add
// companies and documents directly into the same SQLite database Natively
// itself reads from, without going through the app's UI.
//
// WHY A SEPARATE PACKAGE. This process is launched by the MCP client as a
// plain `node` process, not through Electron. The main app's better-sqlite3
// is rebuilt against Electron's Node ABI (scripts/rebuild-native-electron.js,
// run from postinstall) — loading THAT build from plain Node throws a
// NODE_MODULE_VERSION mismatch. This package's own `npm install` builds its
// own better-sqlite3 against whatever Node runs it, so the two never touch.
//
// WHY DIRECT SQLITE ACCESS INSTEAD OF CALLING INTO THE APP. Natively may not
// be running when this server is asked to add something (an agent doing
// research at 2am with the app closed should still be able to file the
// result away). SQLite's WAL journal mode (already the mode Natively sets —
// electron/db/DatabaseManager.ts) is specifically designed for safe
// multi-process access: this connection can read and write the same file
// concurrently with a running Natively instance. What this server does NOT
// do is chunk/embed a newly added document itself — that requires the same
// heavyweight EmbeddingPipeline/ONNX machinery the main app already owns
// (electron/services/interviewKnowledge/InterviewKnowledgeRetriever.ts).
// Instead, a doc inserted here lands with no vectors yet; the next time
// Natively starts (main.ts kicks ensureAllIndexed() once the embedding
// pipeline is ready) or answers a question (interviewKnowledgeContext.ts
// kicks it again in the background), the un-indexed row is embedded. So: this server is a thin, always-
// available WRITER; the running app is the only INDEXER. A document added
// while Natively is closed simply gets indexed the next time it's opened
// and asked a question.
//
// SCHEMA. schema.mjs mirrors DatabaseManager.ensureInterviewKnowledgeSchema
// (a parity test pins the column sets). The server refuses to CREATE
// natively.db: a missing file almost always means the path resolved wrong
// (a dev profile, a custom location), and a stray database there would
// silently swallow every document. Launch Natively once, or set
// NATIVELY_USER_DATA_DIR.

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import Database from 'better-sqlite3';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import { resolveDbPath } from './userDataPath.mjs';
import { DOC_TYPES, ensureSchema } from './schema.mjs';

function openDb() {
    const opts = { platform: process.platform, env: process.env, homedir: os.homedir() };
    const dbPath = resolveDbPath(opts);
    if (!fs.existsSync(dbPath)) {
        throw new Error(`Natively database not found at ${dbPath}. Launch Natively once to create it, or set NATIVELY_USER_DATA_DIR to the folder that contains natively.db.`);
    }
    const db = new Database(dbPath);
    db.pragma('journal_mode = WAL');
    db.pragma('busy_timeout = 5000');
    // The app enables foreign keys per connection too; without this a doc
    // could be filed under a collection id that does not exist.
    db.pragma('foreign_keys = ON');
    ensureSchema(db);
    return db;
}

const db = openDb();

function findCollectionByName(name) {
    return db.prepare('SELECT * FROM interview_knowledge_collections WHERE name = ? COLLATE NOCASE').get(name);
}

function createCollection({ name, interviewerName, contextNotes }) {
    const id = `ikc_${crypto.randomUUID()}`;
    const createdAt = new Date().toISOString();
    db.prepare(`
        INSERT INTO interview_knowledge_collections (id, name, interviewer_name, context_notes, created_at)
        VALUES (?, ?, ?, ?, ?)
    `).run(id, name.trim(), interviewerName?.trim() || null, contextNotes?.trim() || null, createdAt);
    return { id, name: name.trim(), interviewerName: interviewerName?.trim() || null, contextNotes: contextNotes?.trim() || null, createdAt };
}

const server = new McpServer({ name: 'natively-interview-knowledge', version: '1.0.0' });

server.tool(
    'create_knowledge_company',
    'Create a new company/interview grouping in Natively\'s Interview Knowledge base (e.g. "Acme Corp, onsite loop"). Documents added under this company retrieve together, scoped to it.',
    {
        name: z.string().min(1).describe('Company or interview name, e.g. "Acme Corp"'),
        interviewerName: z.string().optional().describe('Name of the person interviewing, if known'),
        contextNotes: z.string().optional().describe('Free-text notes about this interview (round type, focus areas, etc.)'),
    },
    async ({ name, interviewerName, contextNotes }) => {
        const existing = findCollectionByName(name);
        if (existing) {
            return { content: [{ type: 'text', text: `A company named "${existing.name}" already exists (id: ${existing.id}). Use add_knowledge_document with companyName to add to it.` }] };
        }
        const created = createCollection({ name, interviewerName, contextNotes });
        return { content: [{ type: 'text', text: `Created company "${created.name}" (id: ${created.id}).` }] };
    },
);

server.tool(
    'add_knowledge_document',
    'Add a document (resume, job description, company research, interviewer notes, etc.) into Natively\'s Interview Knowledge base. If companyName is given and no company with that name exists yet, it is created automatically. The app indexes the document for retrieval the next time Natively is running and answers a question — this call does not require Natively to be open.',
    {
        title: z.string().min(1).describe('Short title, e.g. "Acme Corp — Q3 earnings summary"'),
        content: z.string().min(1).describe('Full text content of the document'),
        companyName: z.string().optional().describe('Company/interview name to file this under. Created automatically if it does not already exist. Omit to leave the document unfiled.'),
        docType: z.enum(DOC_TYPES).optional().describe('What kind of document this is — helps Natively prioritize it for matching questions (e.g. a "company" question favors company-typed docs). Defaults to "other".'),
    },
    async ({ title, content, companyName, docType }) => {
        let collectionId = null;
        if (companyName) {
            const existing = findCollectionByName(companyName);
            collectionId = existing ? existing.id : createCollection({ name: companyName }).id;
        }
        const id = `ik_${crypto.randomUUID()}`;
        const contentSha256 = crypto.createHash('sha256').update(content.trim()).digest('hex');
        const createdAt = new Date().toISOString();
        db.prepare(`
            INSERT INTO interview_knowledge_docs (id, title, content, content_sha256, source, created_at, collection_id, doc_type)
            VALUES (?, ?, ?, ?, 'mcp', ?, ?, ?)
        `).run(id, title.trim(), content.trim(), contentSha256, createdAt, collectionId, docType || 'other');
        const filedNote = companyName ? ` under "${companyName}"` : ' (unfiled)';
        return { content: [{ type: 'text', text: `Added "${title.trim()}"${filedNote} (id: ${id}). It will be indexed the next time Natively answers a question.` }] };
    },
);

server.tool(
    'list_knowledge_companies',
    'List every company/interview grouping currently in Natively\'s Interview Knowledge base.',
    {},
    async () => {
        const rows = db.prepare('SELECT id, name, interviewer_name, context_notes, created_at FROM interview_knowledge_collections ORDER BY created_at ASC').all();
        if (rows.length === 0) return { content: [{ type: 'text', text: 'No companies yet.' }] };
        const lines = rows.map((r) => `- ${r.name} (id: ${r.id})${r.interviewer_name ? `, interviewer: ${r.interviewer_name}` : ''}`);
        return { content: [{ type: 'text', text: lines.join('\n') }] };
    },
);

server.tool(
    'list_knowledge_documents',
    'List documents in Natively\'s Interview Knowledge base, optionally scoped to one company.',
    {
        companyName: z.string().optional().describe('Only list documents filed under this company. Omit to list every document.'),
    },
    async ({ companyName }) => {
        let rows;
        if (companyName) {
            const collection = findCollectionByName(companyName);
            if (!collection) return { content: [{ type: 'text', text: `No company named "${companyName}" found.` }] };
            rows = db.prepare('SELECT id, title, doc_type, created_at FROM interview_knowledge_docs WHERE collection_id = ? ORDER BY created_at ASC').all(collection.id);
        } else {
            rows = db.prepare('SELECT id, title, doc_type, created_at FROM interview_knowledge_docs ORDER BY created_at ASC').all();
        }
        if (rows.length === 0) return { content: [{ type: 'text', text: 'No documents found.' }] };
        const lines = rows.map((r) => `- ${r.title} [${r.doc_type}] (id: ${r.id})`);
        return { content: [{ type: 'text', text: lines.join('\n') }] };
    },
);

async function main() {
    const transport = new StdioServerTransport();
    await server.connect(transport);
}

main().catch((err) => {
    console.error('[natively-interview-knowledge-mcp] Fatal error:', err);
    process.exit(1);
});
