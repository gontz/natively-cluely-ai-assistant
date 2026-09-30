// electron/services/__tests__/MeetingScreenshotHistory2026_09_30.test.mjs
//
// Screenshots taken during a meeting are saved with the meeting.
//
// Captures land in a rolling 5-file queue under <userData>/screenshots that
// is also cleared on reset-queues and on quit, so the saved meeting keeps its
// own COPY under <userData>/meeting-screenshots/<sessionKey>/ and the DB row
// points at the copy. Covered here:
//   1. path logic (containment, session folder, export name) under BOTH
//      path.win32 and path.posix, whatever the host OS;
//   2. the file store against a real temp dir (copy, delete, empty-folder
//      cleanup, refusing paths outside the root);
//   3. the SQL in db/meetingScreenshotsRepo against in-memory better-sqlite3
//      (idempotent additive table, replace/read, FK cascade, old DBs intact);
//   4. SessionTracker's per-session list and key rotation on reset();
//   5. DatabaseManager end to end: save → details → delete removes the files.
//
// Runs on the compiled output under the Electron ABI (better-sqlite3):
//   NATIVELY_CORE_SMOKE=1 node scripts/build-electron.js
//   node scripts/run-with-env.mjs --default-tmpdir NATIVELY_TEST_USERDATA=... \
//     --set ELECTRON_RUN_AS_NODE=1 -- electron --test <this file>

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '../../..');
const dist = (rel) => pathToFileURL(path.join(repoRoot, 'dist-electron/electron', rel)).href;

const store = await import(dist('services/meeting/MeetingScreenshotStore.js'));
const repo = await import(dist('db/meetingScreenshotsRepo.js'));

const PNG_BYTES = Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex');

function tempDir(label) {
  return fs.mkdtempSync(path.join(os.tmpdir(), `natively-shot-${label}-`));
}

describe('path logic (both platform flavours)', () => {
  test('win32: containment, case-insensitive drive, other drive and .. escapes', () => {
    const p = path.win32;
    const root = store.meetingScreenshotsRoot('C:\\Users\\a\\AppData\\Roaming\\Natively', p);
    assert.equal(root, 'C:\\Users\\a\\AppData\\Roaming\\Natively\\meeting-screenshots');
    assert.equal(store.isPathInside(root, `${root}\\abc\\1.png`, p), true);
    assert.equal(store.isPathInside(root, 'c:\\users\\A\\appdata\\roaming\\natively\\meeting-screenshots\\abc\\1.png', p), true);
    assert.equal(store.isPathInside(root, root, p), false);
    assert.equal(store.isPathInside(root, `${root}\\..\\natively.db`, p), false);
    assert.equal(store.isPathInside(root, 'D:\\meeting-screenshots\\abc\\1.png', p), false);
    assert.equal(store.isStoredScreenshotPath(root, `${root}\\abc\\1.PNG`, p), true);
    assert.equal(store.isStoredScreenshotPath(root, `${root}\\abc\\1.exe`, p), false);
    assert.equal(store.sessionScreenshotDir(root, 'abc-123', p), `${root}\\abc-123`);
  });

  test('posix: containment and .. escapes', () => {
    const p = path.posix;
    const root = store.meetingScreenshotsRoot('/Users/a/Library/Application Support/Natively', p);
    assert.equal(root, '/Users/a/Library/Application Support/Natively/meeting-screenshots');
    assert.equal(store.isPathInside(root, `${root}/abc/1.png`, p), true);
    assert.equal(store.isPathInside(root, `${root}/../natively.db`, p), false);
    assert.equal(store.isPathInside(root, '/Users/a/meeting-screenshots-evil/1.png', p), false);
    assert.equal(store.isStoredScreenshotPath(root, `${root}/abc/1.jpeg`, p), true);
    assert.equal(store.sessionScreenshotDir(root, 'abc_123', p), `${root}/abc_123`);
  });

  test('session keys that could escape the root are rejected', () => {
    for (const bad of ['..', '../x', 'a/b', 'a\\b', '', 'C:']) {
      assert.throws(() => store.sessionScreenshotDir('/root', bad, path.posix), /Invalid screenshot session key/);
      assert.throws(() => store.sessionScreenshotDir('C:\\root', bad, path.win32), /Invalid screenshot session key/);
    }
  });

  test('export file name has no characters Windows rejects and keeps the extension', () => {
    const name = store.defaultScreenshotExportName(Date.UTC(2026, 8, 30, 12, 5, 9), '/x/y/abc.PNG', path.posix);
    assert.match(name, /^Natively screenshot \d{4}-\d{2}-\d{2} \d{2}\.\d{2}\.\d{2}\.png$/);
    assert.doesNotMatch(name, /[<>:"/\\|?*]/);
    assert.match(store.defaultScreenshotExportName(NaN, 'C:\\a\\b.jpg', path.win32), /\.jpg$/);
    assert.equal(store.screenshotMimeType('a.JPG'), 'image/jpeg');
    assert.equal(store.screenshotMimeType('a.png'), 'image/png');
  });
});

describe('file store (real temp dir, host path flavour)', () => {
  test('copy into session folder, then delete removes the file and the empty folder', async () => {
    const userData = tempDir('store');
    const root = store.meetingScreenshotsRoot(userData);
    const queueFile = path.join(userData, 'screenshots', 'q1.png');
    fs.mkdirSync(path.dirname(queueFile), { recursive: true });
    fs.writeFileSync(queueFile, PNG_BYTES);

    const copy = await store.copyScreenshotIntoSession(root, 'sess-1', queueFile);
    assert.equal(copy, path.join(root, 'sess-1', 'q1.png'));
    // The queue may delete its file at any time; the copy must not depend on it.
    fs.unlinkSync(queueFile);
    assert.deepEqual(fs.readFileSync(copy), PNG_BYTES);

    assert.equal(store.removeStoredScreenshots(root, [copy]), 1);
    assert.equal(fs.existsSync(copy), false);
    assert.equal(fs.existsSync(path.join(root, 'sess-1')), false);
    fs.rmSync(userData, { recursive: true, force: true });
  });

  test('never deletes a path outside the root, tolerates already-missing files', () => {
    const userData = tempDir('outside');
    const root = store.meetingScreenshotsRoot(userData);
    const outside = path.join(userData, 'natively.png');
    fs.writeFileSync(outside, PNG_BYTES);
    const missing = path.join(root, 's', 'gone.png');
    assert.equal(store.removeStoredScreenshots(root, [outside, missing, path.join(root, '..', 'natively.png')]), 0);
    assert.equal(fs.existsSync(outside), true);
    fs.rmSync(userData, { recursive: true, force: true });
  });

  test('refuses to copy a non-image source', async () => {
    const userData = tempDir('nonimage');
    await assert.rejects(
      store.copyScreenshotIntoSession(store.meetingScreenshotsRoot(userData), 's', path.join(userData, 'x.txt')),
      /Not a screenshot image/,
    );
    fs.rmSync(userData, { recursive: true, force: true });
  });

  test('removeSessionScreenshots drops one session folder only', async () => {
    const userData = tempDir('session');
    const root = store.meetingScreenshotsRoot(userData);
    const src = path.join(userData, 'a.png');
    fs.writeFileSync(src, PNG_BYTES);
    await store.copyScreenshotIntoSession(root, 'keep', src);
    await store.copyScreenshotIntoSession(root, 'drop', src);
    store.removeSessionScreenshots(root, 'drop');
    assert.equal(fs.existsSync(path.join(root, 'drop')), false);
    assert.equal(fs.existsSync(path.join(root, 'keep', 'a.png')), true);
    store.removeAllStoredScreenshots(root);
    assert.equal(fs.existsSync(root), false);
    fs.rmSync(userData, { recursive: true, force: true });
  });
});

describe('meetingScreenshotsRepo (in-memory SQLite, production SQL)', async () => {
  const { default: Database } = await import('better-sqlite3');

  function oldSchemaDb() {
    const db = new Database(':memory:');
    db.pragma('foreign_keys = ON');
    // A pre-feature DB: meetings + transcripts, no meeting_screenshots.
    db.exec(`
      CREATE TABLE meetings (id TEXT PRIMARY KEY, title TEXT);
      CREATE TABLE transcripts (id INTEGER PRIMARY KEY AUTOINCREMENT, meeting_id TEXT, content TEXT,
        FOREIGN KEY(meeting_id) REFERENCES meetings(id) ON DELETE CASCADE);
      INSERT INTO meetings (id, title) VALUES ('m1', 'Old meeting'), ('m2', 'Other');
      INSERT INTO transcripts (meeting_id, content) VALUES ('m1', 'hello');
    `);
    return db;
  }

  test('table creation is additive and idempotent; existing rows are untouched', () => {
    const db = oldSchemaDb();
    repo.ensureMeetingScreenshotsTable(db);
    repo.ensureMeetingScreenshotsTable(db);
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM meetings').get().n, 2);
    assert.equal(db.prepare('SELECT content FROM transcripts').get().content, 'hello');
    assert.deepEqual(repo.getMeetingScreenshots(db, 'm1'), []);
  });

  test('replace + read, ordered by capture time, junk entries skipped, kind normalized', () => {
    const db = oldSchemaDb();
    repo.ensureMeetingScreenshotsTable(db);
    repo.replaceMeetingScreenshots(db, 'm1', [
      { path: '/r/s/b.png', timestamp: 2000, captureKind: 'selective' },
      { path: '/r/s/a.png', timestamp: 1000, captureKind: 'full' },
      { path: '', timestamp: 3000, captureKind: 'full' },
      { path: '/r/s/c.png', timestamp: Number.NaN, captureKind: 'full' },
      { path: '/r/s/d.png', timestamp: 4000, captureKind: 'weird' },
    ]);
    assert.deepEqual(repo.getMeetingScreenshots(db, 'm1'), [
      { path: '/r/s/a.png', timestamp: 1000, captureKind: 'full' },
      { path: '/r/s/b.png', timestamp: 2000, captureKind: 'selective' },
      { path: '/r/s/d.png', timestamp: 4000, captureKind: 'full' },
    ]);
    // Re-save replaces instead of appending (placeholder → final save).
    repo.replaceMeetingScreenshots(db, 'm1', [{ path: '/r/s/a.png', timestamp: 1000, captureKind: 'full' }]);
    assert.equal(repo.getMeetingScreenshots(db, 'm1').length, 1);
    assert.equal(repo.isRecordedMeetingScreenshot(db, '/r/s/a.png'), true);
    assert.equal(repo.isRecordedMeetingScreenshot(db, '/r/s/b.png'), false);
  });

  test('deleting the meeting cascades its screenshot rows only', () => {
    const db = oldSchemaDb();
    repo.ensureMeetingScreenshotsTable(db);
    repo.replaceMeetingScreenshots(db, 'm1', [{ path: '/r/1.png', timestamp: 1, captureKind: 'full' }]);
    repo.replaceMeetingScreenshots(db, 'm2', [{ path: '/r/2.png', timestamp: 1, captureKind: 'full' }]);
    db.prepare('DELETE FROM meetings WHERE id = ?').run('m1');
    assert.deepEqual(repo.getMeetingScreenshotPaths(db), ['/r/2.png']);
    assert.deepEqual(repo.getMeetingScreenshotPaths(db, 'm2'), ['/r/2.png']);
  });
});

describe('SessionTracker screenshot list', async () => {
  const { SessionTracker } = await import(dist('SessionTracker.js'));

  test('records under the current key, refuses a stale key after reset()', () => {
    const s = new SessionTracker();
    const key = s.getScreenshotSessionKey();
    assert.match(key, /^[A-Za-z0-9-]+$/);
    assert.equal(s.addSessionScreenshot(key, { path: '/r/a.png', timestamp: 1, captureKind: 'full' }), true);
    assert.equal(s.getSessionScreenshots().length, 1);
    s.reset();
    assert.notEqual(s.getScreenshotSessionKey(), key);
    assert.equal(s.getSessionScreenshots().length, 0);
    // A copy that finished after the meeting stopped must not join the next session.
    assert.equal(s.addSessionScreenshot(key, { path: '/r/late.png', timestamp: 2, captureKind: 'full' }), false);
    assert.equal(s.getSessionScreenshots().length, 0);
  });
});

describe('DatabaseManager end to end', async () => {
  // Fresh userData so this test owns its DB. Read in the DatabaseManager
  // constructor, which has not run yet in this process.
  const userData = tempDir('dbm');
  process.env.NATIVELY_TEST_USERDATA = userData;
  const { DatabaseManager } = await import(dist('db/DatabaseManager.js'));
  const db = DatabaseManager.getInstance();

  test('save → details → delete removes rows and files; undefined list leaves rows alone', async () => {
    const root = db.getMeetingScreenshotsRoot();
    assert.equal(root, path.join(userData, 'meeting-screenshots'));
    const src = path.join(userData, 'q.png');
    fs.writeFileSync(src, PNG_BYTES);
    const copy = await store.copyScreenshotIntoSession(root, 'sess-e2e', src);

    const meeting = {
      id: 'shot-meeting', title: 'With screenshots', date: new Date().toISOString(), duration: '0:05',
      summary: '', detailedSummary: { actionItems: [], keyPoints: [] }, transcript: [], usage: [],
      screenshots: [{ path: copy, timestamp: 1234, captureKind: 'selective' }],
      isProcessed: true, summaryStatus: 'completed',
    };
    db.saveMeeting(meeting, Date.now(), 5000);
    assert.deepEqual(db.getMeetingDetails('shot-meeting').screenshots, [{ path: copy, timestamp: 1234, captureKind: 'selective' }]);
    assert.equal(db.isRecordedMeetingScreenshot(copy), true);

    // A re-save without a screenshot list (recovery path) keeps them.
    const { screenshots, ...withoutShots } = meeting;
    db.saveMeeting(withoutShots, Date.now(), 5000);
    assert.equal(db.getMeetingDetails('shot-meeting').screenshots.length, 1);

    assert.equal(db.deleteMeeting('shot-meeting'), true);
    assert.equal(fs.existsSync(copy), false);
    assert.equal(fs.existsSync(path.join(root, 'sess-e2e')), false);
    assert.equal(db.isRecordedMeetingScreenshot(copy), false);
  });

  test('meetings without screenshots still load with an empty list', () => {
    db.saveMeeting({
      id: 'plain-meeting', title: 'Plain', date: new Date().toISOString(), duration: '0:05',
      summary: '', detailedSummary: { actionItems: [], keyPoints: [] }, transcript: [], usage: [],
      isProcessed: true, summaryStatus: 'completed',
    }, Date.now(), 5000);
    assert.deepEqual(db.getMeetingDetails('plain-meeting').screenshots, []);
    db.deleteMeeting('plain-meeting');
  });
});
