// electron/services/__tests__/PhoneMirrorAnswersOnly2026_09_30.test.mjs
//
// "Only mirror answers" (phoneMirrorAnswersOnly): the phone must never receive
// the user's own questions, only the AI answers. Loads the REAL compiled
// PhoneMirrorService (dist-electron) and drives it with a real `ws` phone
// client on loopback, covering:
//
//   1. setting off  → user message is broadcast live and replayed in history.
//   2. setting on   → publishUserMessage() is dropped (no live frame, no
//                     history entry) while answers still flow.
//   3. turning it on purges questions already buffered for replay, so a phone
//                     that (re)connects afterwards never sees them.
//   4. snapshot() reports the persisted flag.
//
// No platform branch exists in this path (loopback bind on both darwin and
// win32), so there is nothing platform-specific to inject.
//
// Pattern (per repo memory): stub electron app/BrowserWindow/safeStorage via a
// Module._load hook BEFORE importing the compiled CJS bundle.

import { test, describe, before, after, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';
import Module from 'node:module';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '../../../');
const require = createRequire(path.join(repoRoot, 'package.json'));
const WS = require('ws').WebSocket;

const compiledServicePath = path.resolve(
  repoRoot,
  'dist-electron/electron/services/PhoneMirrorService.js',
);
const compiledSettingsPath = path.resolve(
  repoRoot,
  'dist-electron/electron/services/SettingsManager.js',
);

const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'natively-pm-answers-only-'));

const electronStub = {
  app: {
    isReady: () => true,
    getPath: () => userDataDir,
    whenReady: () => Promise.resolve(),
    on: () => {},
  },
  BrowserWindow: class {
    static getFocusedWindow() {
      return null;
    }
    static getAllWindows() {
      return [];
    }
  },
  safeStorage: {
    isEncryptionAvailable: () => true,
    encryptString: (s) => Buffer.from('enc:' + s, 'utf8'),
    decryptString: (buf) => Buffer.from(buf).toString('utf8').replace(/^enc:/, ''),
  },
};

const originalLoad = Module._load;
Module._load = function (request, parent, isMain) {
  if (request === 'electron') return electronStub;
  return originalLoad.call(this, request, parent, isMain);
};

let PhoneMirrorService;
let SettingsManager;

before(async () => {
  PhoneMirrorService = (await import(pathToFileURL(compiledServicePath).href)).PhoneMirrorService;
  SettingsManager = (await import(pathToFileURL(compiledSettingsPath).href)).SettingsManager;
});

afterEach(async () => {
  const svc = PhoneMirrorService.getInstance();
  if (svc.isRunning()) await svc.stop({ persist: false });
  SettingsManager.getInstance().set('phoneMirrorAnswersOnly', false);
  // The replay buffer outlives stop/start on the singleton; reset it so each
  // test asserts only its own messages.
  svc.history = [];
});

after(() => {
  Module._load = originalLoad;
  try {
    fs.rmSync(userDataDir, { recursive: true, force: true });
  } catch {}
});

async function freshService() {
  const svc = PhoneMirrorService.getInstance();
  if (svc.isRunning()) await svc.stop({ persist: false });
  const info = await svc.start({ exposeOnLan: false, persist: false });
  return { svc, info };
}

function connectPhone(port, token) {
  return new Promise((resolve, reject) => {
    const ws = new WS(`ws://127.0.0.1:${port}/ws?t=${encodeURIComponent(token)}`);
    const frames = [];
    ws.on('message', (d) => {
      try {
        frames.push(JSON.parse(d.toString()));
      } catch {}
    });
    ws.on('error', reject);
    ws.on('open', () => setTimeout(() => resolve({ ws, frames }), 60));
  });
}

const settle = () => new Promise((r) => setTimeout(r, 60));
const historyOf = (frames) => frames.find((f) => f.type === 'history')?.messages ?? [];

describe('PhoneMirror — only mirror answers', () => {
  test('setting off: the question is broadcast live and replayed', async () => {
    const { svc, info } = await freshService();
    const live = await connectPhone(info.port, info.token);
    svc.publishUserMessage('s1', 'what is a monad?');
    svc.publishDone('s1', 'A monoid in the category of endofunctors.');
    await settle();
    assert.ok(live.frames.some((f) => f.type === 'user' && f.content === 'what is a monad?'));
    assert.ok(live.frames.some((f) => f.type === 'done'));
    live.ws.close();

    const late = await connectPhone(info.port, info.token);
    const roles = historyOf(late.frames).map((m) => m.role);
    assert.deepEqual(roles, ['user', 'assistant']);
    late.ws.close();
  });

  test('setting on: the question never reaches the phone, the answer does', async () => {
    const { svc, info } = await freshService();
    const snap = await svc.setAnswersOnly(true);
    assert.equal(snap.answersOnly, true);
    assert.equal(SettingsManager.getInstance().get('phoneMirrorAnswersOnly'), true);

    const live = await connectPhone(info.port, info.token);
    svc.publishUserMessage('s2', 'secret question');
    svc.publishToken('s2', 'An ');
    svc.publishDone('s2', 'An answer.');
    await settle();
    assert.equal(live.frames.filter((f) => f.type === 'user').length, 0);
    assert.ok(!JSON.stringify(live.frames).includes('secret question'));
    assert.ok(live.frames.some((f) => f.type === 'done' && f.content === 'An answer.'));
    live.ws.close();

    const late = await connectPhone(info.port, info.token);
    const history = historyOf(late.frames);
    assert.deepEqual(history.map((m) => m.role), ['assistant']);
    late.ws.close();
  });

  test('turning it on purges questions already buffered for replay', async () => {
    const { svc, info } = await freshService();
    svc.publishUserMessage('s3', 'earlier question');
    svc.publishDone('s3', 'earlier answer');
    await svc.setAnswersOnly(true);

    const late = await connectPhone(info.port, info.token);
    const history = historyOf(late.frames);
    assert.deepEqual(history.map((m) => m.content), ['earlier answer']);
    late.ws.close();

    // Turning it back off resumes mirroring questions going forward.
    const off = await svc.setAnswersOnly(false);
    assert.equal(off.answersOnly, false);
    svc.publishUserMessage('s4', 'new question');
    const again = await connectPhone(info.port, info.token);
    assert.deepEqual(
      historyOf(again.frames).map((m) => m.content),
      ['earlier answer', 'new question'],
    );
    again.ws.close();
  });

  test('snapshot reports the persisted flag while stopped', async () => {
    const svc = PhoneMirrorService.getInstance();
    if (svc.isRunning()) await svc.stop({ persist: false });
    assert.equal((await svc.snapshot()).answersOnly, false);
    const info = await svc.setAnswersOnly(true);
    assert.equal(info.running, false);
    assert.equal(info.answersOnly, true);
  });
});
