// electron/services/__tests__/InterviewKnowledgeStore.test.mjs
//
// The Interview Knowledge tables and store against a REAL sqlite database:
// DatabaseManager.ensureInterviewKnowledgeSchema on a fresh profile, on a
// profile carrying the rishikeshl0510 fork's older v32 table shape, and on a
// profile whose user_version was stamped past this schema by another branch;
// then the store's SQL (collections, active pointer, cascades). Runs under the
// electron runner because better-sqlite3 is built for Electron's ABI.
//
// No embedding pipeline is injected, so indexing degrades to "stored, not yet
// indexed" (the startup-race path). Retrieval itself is covered by
// InterviewKnowledgeAgenticRetrieve.test.mjs.

import { test, describe, before } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');

// A private profile: this suite drops and recreates tables, so it must never
// share a userData dir with another suite (or another package's run).
process.env.NATIVELY_TEST_USERDATA = fs.mkdtempSync(path.join(os.tmpdir(), 'interview-knowledge-store-'));

const { DatabaseManager } = require(path.join(root, 'dist-electron/electron/db/DatabaseManager.js'));
const { InterviewKnowledgeRetriever } = require(path.join(root, 'dist-electron/electron/services/interviewKnowledge/InterviewKnowledgeRetriever.js'));

const tableExists = (db, name) => Boolean(db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?").get(name));
const columns = (db, table) => db.prepare(`PRAGMA table_info(${table})`).all().map((c) => c.name);
const dropAll = (db) => db.exec(`
  DROP TABLE IF EXISTS interview_knowledge_state;
  DROP TABLE IF EXISTS interview_knowledge_docs;
  DROP TABLE IF EXISTS interview_knowledge_collections;
`);

let dm;
let db;
before(() => {
  dm = DatabaseManager.getInstance();
  assert.equal(dm.isAvailable(), true, dm.getInitError()?.message ?? 'database unavailable');
  db = dm.getDb();
});

describe('ensureInterviewKnowledgeSchema', () => {
  test('a fresh profile gets all three tables with the full column set', () => {
    for (const t of ['interview_knowledge_docs', 'interview_knowledge_collections', 'interview_knowledge_state']) {
      assert.ok(tableExists(db, t), `${t} missing after boot`);
    }
    const docCols = columns(db, 'interview_knowledge_docs');
    for (const c of ['id', 'title', 'content', 'content_sha256', 'source', 'created_at', 'collection_id', 'doc_type']) {
      assert.ok(docCols.includes(c), `interview_knowledge_docs.${c} missing`);
    }
  });

  test('re-running it is a no-op on an up-to-date profile (idempotent)', () => {
    db.prepare("INSERT INTO interview_knowledge_docs (id, title, content, content_sha256) VALUES ('ik_keep', 't', 'c', 'h')").run();
    dm.ensureInterviewKnowledgeSchema();
    dm.ensureInterviewKnowledgeSchema();
    assert.equal(db.prepare("SELECT COUNT(*) c FROM interview_knowledge_docs WHERE id = 'ik_keep'").get().c, 1);
    db.prepare("DELETE FROM interview_knowledge_docs WHERE id = 'ik_keep'").run();
  });

  test("the fork's older v32 table shape is upgraded in place and its rows survive", () => {
    dropAll(db);
    // Exactly the rishikeshl0510 fork's v32 CREATE: no collection_id, no doc_type.
    db.exec(`
      CREATE TABLE interview_knowledge_docs (
        id TEXT PRIMARY KEY, title TEXT NOT NULL, content TEXT NOT NULL,
        content_sha256 TEXT NOT NULL, source TEXT NOT NULL DEFAULT 'paste',
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
      );
    `);
    db.prepare("INSERT INTO interview_knowledge_docs (id, title, content, content_sha256) VALUES ('ik_old', 'Old resume', 'Rust, Go', 'h')").run();

    dm.ensureInterviewKnowledgeSchema();

    const docCols = columns(db, 'interview_knowledge_docs');
    assert.ok(docCols.includes('collection_id') && docCols.includes('doc_type'));
    const row = db.prepare("SELECT * FROM interview_knowledge_docs WHERE id = 'ik_old'").get();
    assert.equal(row.content, 'Rust, Go', 'existing user content must survive the upgrade');
    assert.equal(row.collection_id, null, 'a pre-collections doc is Unfiled, not lost');
    assert.equal(row.doc_type, 'other', 'an untyped doc is neither boosted nor penalized');
    assert.ok(tableExists(db, 'interview_knowledge_collections'));
    assert.ok(tableExists(db, 'interview_knowledge_state'));
  });

  test('does not depend on user_version: a profile stamped past it by another branch still gets the tables', () => {
    const original = db.pragma('user_version', { simple: true });
    try {
      dropAll(db);
      db.pragma('user_version = 99');
      dm.ensureInterviewKnowledgeSchema();
      assert.ok(tableExists(db, 'interview_knowledge_docs'));
      assert.equal(db.pragma('user_version', { simple: true }), 99, 'the schema ensure must never stamp user_version');
    } finally {
      db.pragma(`user_version = ${original}`);
    }
  });
});

describe('InterviewKnowledgeRetriever store', () => {
  before(() => {
    dropAll(db);
    dm.ensureInterviewKnowledgeSchema();
    InterviewKnowledgeRetriever.__resetForTests();
  });

  test('docs, collections and the active pointer round-trip, and retrieval scope follows the active collection', () => {
    const ik = InterviewKnowledgeRetriever.getInstance();
    assert.equal(ik.hasAnyDocs(), false);

    const acme = ik.createCollection({ name: '  Acme onsite ', interviewerName: 'Dana' });
    assert.match(acme.id, /^ikc_/);
    assert.equal(acme.name, 'Acme onsite');

    const resume = ik.addText({ title: 'Resume', content: 'Led the payments team.', docType: 'resume' });
    const jd = ik.addText({ title: 'Acme JD', content: 'Own the ledger service.', collectionId: acme.id, docType: 'role' });
    assert.match(resume.id, /^ik_/, 'ik_ prefix keeps doc ids disjoint from Modes reference-file ids in the shared chunk tables');
    assert.equal(resume.collectionId, null);

    assert.equal(ik.list().length, 2);
    assert.deepEqual(ik.list(null).map((d) => d.id), [resume.id]);
    assert.deepEqual(ik.list(acme.id).map((d) => d.id), [jd.id]);
    assert.equal(ik.getById(jd.id).content, 'Own the ledger service.');
    assert.equal(ik.getById('ik_missing'), null);

    // No active collection = every document.
    assert.equal(ik.getActiveCollectionId(), null);
    assert.equal(ik.getReferenceFiles().length, 2);

    ik.setActiveCollectionId(acme.id);
    assert.equal(ik.getActiveCollectionId(), acme.id);
    assert.deepEqual(ik.getReferenceFiles().map((f) => f.id), [jd.id]);
    assert.equal(ik.getDocTypeMap().get(jd.id), 'role');
    assert.equal(ik.getDocTypeMap().has(resume.id), false, 'the docType map only covers what is searched this turn');

    // Without a pipeline, status reports pending instead of throwing.
    assert.deepEqual(ik.getStatus(jd.id), { status: 'pending', chunkCount: 0 });
  });

  test('empty content is refused and a non-existent collection id is rejected by the foreign key', () => {
    const ik = InterviewKnowledgeRetriever.getInstance();
    assert.throws(() => ik.addText({ title: 'x', content: '   ' }), /Empty content/);
    assert.throws(() => ik.addText({ title: 'x', content: 'y', collectionId: 'ikc_nope' }), /FOREIGN KEY/);
    assert.throws(() => ik.createCollection({ name: '  ' }), /name is required/);
  });

  test('deleting a collection removes its docs and clears the active pointer', () => {
    const ik = InterviewKnowledgeRetriever.getInstance();
    const acme = ik.listCollections().find((c) => c.name === 'Acme onsite');
    ik.updateCollection(acme.id, { contextNotes: 'Systems design round' });
    assert.equal(ik.listCollections().find((c) => c.id === acme.id).contextNotes, 'Systems design round');

    ik.deleteCollection(acme.id);
    assert.equal(ik.list(acme.id).length, 0);
    assert.equal(ik.getActiveCollectionId(), null);
    assert.equal(ik.list().length, 1, 'unfiled docs are untouched by a collection delete');
  });

  test('addFolder skips unsupported files and hidden folders without aborting the scan', async () => {
    const ik = InterviewKnowledgeRetriever.getInstance();
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ik-folder-'));
    fs.writeFileSync(path.join(dir, 'notes.md'), '# Interviewer\nLikes Kafka questions.');
    fs.writeFileSync(path.join(dir, 'photo.bin'), Buffer.from([0, 1, 2]));
    fs.mkdirSync(path.join(dir, 'sub'));
    fs.writeFileSync(path.join(dir, 'sub', 'company.txt'), 'Acme sells ledgers.');
    fs.mkdirSync(path.join(dir, '.git'));
    fs.writeFileSync(path.join(dir, '.git', 'HEAD.txt'), 'ref: refs/heads/main');

    const result = await ik.addFolder(dir, null);
    assert.equal(result.added, 2);
    assert.equal(result.skipped, 1);
    assert.equal(path.basename(result.errors[0].path), 'photo.bin');
    const titles = ik.list(null).map((d) => d.title);
    assert.ok(titles.includes('notes.md') && titles.includes('company.txt'));
    assert.ok(!titles.includes('HEAD.txt'), 'hidden folders are never ingested');
  });
});
