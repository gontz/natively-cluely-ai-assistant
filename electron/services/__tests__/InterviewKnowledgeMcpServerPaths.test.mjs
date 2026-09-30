// electron/services/__tests__/InterviewKnowledgeMcpServerPaths.test.mjs
//
// mcp-server/ runs as plain `node`, outside the app build, and writes into the
// app's own natively.db. Two things it must get right on every platform:
//  • WHERE that database is (userDataPath.mjs), for win32, darwin and linux,
//    exercised by injecting the platform (never by mutating process.platform);
//  • WHAT the tables look like (schema.mjs), which duplicates
//    DatabaseManager.ensureInterviewKnowledgeSchema and must not drift from it.
// Neither module imports the server's npm dependencies, so this runs without
// `npm install` inside mcp-server/.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const paths = await import(pathToFileURL(path.join(root, 'mcp-server/userDataPath.mjs')).href);
const schema = await import(pathToFileURL(path.join(root, 'mcp-server/schema.mjs')).href);

describe('mcp-server userData resolution', () => {
  test('win32: %APPDATA%\\Natively with backslashes, matching Electron userData for the packaged app', () => {
    const env = { APPDATA: 'C:\\Users\\ana\\AppData\\Roaming' };
    assert.equal(paths.resolveUserDataPath({ platform: 'win32', env, homedir: 'C:\\Users\\ana' }), 'C:\\Users\\ana\\AppData\\Roaming\\Natively');
    assert.equal(paths.resolveDbPath({ platform: 'win32', env, homedir: 'C:\\Users\\ana' }), 'C:\\Users\\ana\\AppData\\Roaming\\Natively\\natively.db');
  });

  test('win32 without APPDATA falls back to <home>\\AppData\\Roaming', () => {
    assert.equal(paths.resolveUserDataPath({ platform: 'win32', env: {}, homedir: 'C:\\Users\\ana' }), 'C:\\Users\\ana\\AppData\\Roaming\\Natively');
  });

  test('darwin: ~/Library/Application Support/Natively', () => {
    assert.equal(paths.resolveDbPath({ platform: 'darwin', env: {}, homedir: '/Users/ana' }), '/Users/ana/Library/Application Support/Natively/natively.db');
  });

  test('linux: XDG_CONFIG_HOME, else ~/.config', () => {
    assert.equal(paths.resolveUserDataPath({ platform: 'linux', env: {}, homedir: '/home/ana' }), '/home/ana/.config/Natively');
    assert.equal(paths.resolveUserDataPath({ platform: 'linux', env: { XDG_CONFIG_HOME: '/xdg' }, homedir: '/home/ana' }), '/xdg/Natively');
  });

  test('overrides win on every platform: the test variable the app honours, then NATIVELY_USER_DATA_DIR', () => {
    for (const platform of ['win32', 'darwin', 'linux']) {
      assert.equal(paths.resolveUserDataPath({ platform, env: { NATIVELY_USER_DATA_DIR: 'X:\\profile', APPDATA: 'C:\\a' }, homedir: 'h' }), 'X:\\profile');
      assert.equal(paths.resolveUserDataPath({ platform, env: { NATIVELY_TEST_USERDATA: '/t', NATIVELY_USER_DATA_DIR: '/u' }, homedir: 'h' }), '/t');
    }
  });

  test('the resolved app name matches electron-builder productName', () => {
    const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
    assert.equal(paths.PRODUCT_NAME, pkg.build.productName);
  });
});

describe('mcp-server schema parity with DatabaseManager', () => {
  const columnsOf = (sql, table) => {
    const m = sql.match(new RegExp(`CREATE TABLE IF NOT EXISTS ${table} \\(([\\s\\S]*?)\\n\\s*\\);`));
    assert.ok(m, `${table} not found`);
    return m[1].split('\n').map((l) => l.trim().split(/\s+/)[0]).filter(Boolean).sort();
  };
  const dm = fs.readFileSync(path.join(root, 'electron/db/DatabaseManager.ts'), 'utf8');
  const start = dm.indexOf('private ensureInterviewKnowledgeSchema(');
  const appSql = dm.slice(start, dm.indexOf('private runMigrations()', start));
  const mcpSql = schema.SCHEMA_SQL + schema.INDEX_AND_STATE_SQL;

  for (const table of ['interview_knowledge_docs', 'interview_knowledge_collections', 'interview_knowledge_state']) {
    test(`${table} has the same columns on both sides`, () => {
      assert.deepEqual(columnsOf(mcpSql, table), columnsOf(appSql, table));
    });
  }

  test('both sides upgrade an older docs table with the same ALTERs', () => {
    for (const alter of schema.UPGRADE_ALTERS) assert.ok(appSql.includes(alter), `app is missing: ${alter}`);
  });

  test('docType vocabulary matches the app', () => {
    const affinity = fs.readFileSync(path.join(root, 'electron/services/interviewKnowledge/docTypeAffinity.ts'), 'utf8');
    const m = affinity.match(/KNOWLEDGE_DOC_TYPES: readonly KnowledgeDocType\[\] = \[([^\]]*)\]/);
    assert.deepEqual(schema.DOC_TYPES, [...m[1].matchAll(/'([a-z]+)'/g)].map((x) => x[1]));
  });

  test('ensureSchema applies create, upgrade and index steps in order and tolerates existing columns', () => {
    const calls = [];
    schema.ensureSchema({ exec: (sql) => { calls.push(sql); if (sql.startsWith('ALTER')) throw new Error('duplicate column name'); } });
    assert.equal(calls[0], schema.SCHEMA_SQL);
    assert.equal(calls.at(-1), schema.INDEX_AND_STATE_SQL);
    assert.equal(calls.length, 2 + schema.UPGRADE_ALTERS.length);
  });
});
