// mcp-server/schema.mjs
//
// The Interview Knowledge tables, duplicated from
// electron/db/DatabaseManager.ts's ensureInterviewKnowledgeSchema(). This
// package runs as plain `node` and cannot import the app's Electron-only
// TypeScript, so the SQL is copied; a parity test
// (electron/services/__tests__/InterviewKnowledgeMcpServerPaths.test.mjs)
// fails if the two column sets drift. CREATE IF NOT EXISTS on both sides
// makes whichever runs first a no-op for the other.

export const SCHEMA_SQL = `
    CREATE TABLE IF NOT EXISTS interview_knowledge_collections (
        id                TEXT PRIMARY KEY,
        name              TEXT NOT NULL,
        interviewer_name  TEXT,
        context_notes     TEXT,
        created_at        TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE IF NOT EXISTS interview_knowledge_docs (
        id              TEXT PRIMARY KEY,
        title           TEXT NOT NULL,
        content         TEXT NOT NULL,
        content_sha256  TEXT NOT NULL,
        source          TEXT NOT NULL DEFAULT 'paste',
        created_at      TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        collection_id   TEXT REFERENCES interview_knowledge_collections(id) ON DELETE CASCADE,
        doc_type        TEXT NOT NULL DEFAULT 'other'
    );
`;

/** Columns an older build's table may lack. Each is applied with the duplicate-column error swallowed. */
export const UPGRADE_ALTERS = [
    'ALTER TABLE interview_knowledge_docs ADD COLUMN collection_id TEXT REFERENCES interview_knowledge_collections(id) ON DELETE CASCADE',
    "ALTER TABLE interview_knowledge_docs ADD COLUMN doc_type TEXT NOT NULL DEFAULT 'other'",
];

export const INDEX_AND_STATE_SQL = `
    CREATE INDEX IF NOT EXISTS idx_interview_knowledge_docs_created ON interview_knowledge_docs(created_at);
    CREATE INDEX IF NOT EXISTS idx_interview_knowledge_docs_collection ON interview_knowledge_docs(collection_id);
    CREATE TABLE IF NOT EXISTS interview_knowledge_state (
        id                    INTEGER PRIMARY KEY CHECK (id = 1),
        active_collection_id  TEXT REFERENCES interview_knowledge_collections(id) ON DELETE SET NULL
    );
`;

export const DOC_TYPES = ['resume', 'company', 'interviewer', 'role', 'other'];

/** @param {{ exec(sql: string): unknown }} db */
export function ensureSchema(db) {
    db.exec(SCHEMA_SQL);
    for (const alter of UPGRADE_ALTERS) {
        try { db.exec(alter); } catch { /* column already exists */ }
    }
    db.exec(INDEX_AND_STATE_SQL);
}
