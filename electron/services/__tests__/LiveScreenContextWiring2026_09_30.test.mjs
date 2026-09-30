// electron/services/__tests__/LiveScreenContextWiring2026_09_30.test.mjs
//
// Live screen context, the parts that sit outside the controller:
//   1. ScreenUnderstandingService: hasUnansweredQuestion comes back from the
//      structured-extraction call, and providerPreference 'gemini_first'
//      really changes which rung is tried first (with fallback intact).
//   2. Settings plumbing: SettingsManager keys, the two IPC handlers (incl. the
//      R-24 refused-write contract), preload + renderer types, the Settings tab.
//   3. main.ts wiring: start after the session is marked active, stop on
//      session end and on quit, background capture kept out of the user's queue.
//
// Run: `ELECTRON_RUN_AS_NODE=1 electron --test` after
// `NATIVELY_CORE_SMOKE=1 node scripts/build-electron.js`.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import Module, { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '../../..');
const read = (p) => fs.readFileSync(path.join(root, p), 'utf8');

// Stub electron before the service loads (same approach as
// ScreenUnderstandingFencedJson2026_09_30.test.mjs).
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'live-screen-userdata-'));
process.env.NATIVELY_TEST_USER_DATA = tmp;
const cjs = createRequire(path.join(root, 'package.json'));
const stub = new Module('electron');
stub.exports = {
  app: { isReady: () => true, getPath: (n) => (n === 'userData' ? tmp : os.tmpdir()), getName: () => 'natively-test', getVersion: () => '0.0.0-test', isPackaged: false },
  shell: { openPath: async () => '' },
  safeStorage: { isEncryptionAvailable: () => false },
  ipcMain: { on: () => {}, handle: () => {}, removeAllListeners: () => {} },
  BrowserWindow: { getAllWindows: () => [] },
  desktopCapturer: { getSources: async () => [] },
};
stub.loaded = true;
cjs.cache[cjs.resolve('electron')] = stub;

const { ScreenUnderstandingService } = cjs(path.join(root, 'dist-electron/electron/services/screen/ScreenUnderstandingService.js'));

let n = 0;
function fixture() {
  // A distinct 1x1 PNG per call, inside userData (validateImagePath requires it).
  const png = Buffer.from(
    '89504E470D0A1A0A0000000D49484452000000010000000108020000009077' +
    '53DE0000000C4944415478DA6364F800000200010001ACFCC8AF0000000049' +
    '454E44AE426082',
    'hex',
  );
  const p = path.join(tmp, `live-${++n}.png`);
  fs.writeFileSync(p, png);
  return p;
}

function rung(id, hint, reply, calls) {
  return {
    id, displayName: id, modelId: `${id}-model`, isLocal: false, isConfigured: true,
    supportsVision: true, scopeAllowsScreenshots: true, hint,
    invoke: async () => { calls.push(id); if (reply instanceof Error) throw reply; return reply; },
  };
}

const JSON_REPLY = (has) => JSON.stringify({
  screenType: 'code', visibleSummary: 'A coding problem', extractedText: 'Implement an LRU cache.',
  codeBlocks: [], tables: [], errors: [], taskDetected: 'coding', hasUnansweredQuestion: has, confidence: 0.9,
});

async function understand({ preference, providers }) {
  const service = new ScreenUnderstandingService();
  return service.understand({
    modeId: 'live-screen-context',
    userAction: 'transcribe',
    qualityMode: 'fast',
    imagePaths: [fixture()],
    screenUnderstandingMode: 'vision_first',
    providerPolicy: { localOnly: false, allowScreenshots: true, visionAvailable: true, localVisionAvailable: false, __providersOverride: providers },
    ...(preference ? { providerPreference: preference } : {}),
    totalDeadlineMsOverride: 30_000,
  });
}

describe('ScreenUnderstandingService: live-screen-context request fields', () => {
  test('hasUnansweredQuestion is carried from the vision reply (true and false)', async () => {
    for (const has of [true, false]) {
      const calls = [];
      const r = await understand({ providers: [rung('openai', 'openai', JSON_REPLY(has), calls)] });
      assert.equal(r.status, 'available');
      assert.equal(r.hasUnansweredQuestion, has);
    }
  });

  test('a reply without the field leaves it undefined (consumers treat that as false)', async () => {
    const calls = [];
    const r = await understand({ providers: [rung('openai', 'openai', 'The screen shows a code editor.', calls)] });
    assert.equal(r.status, 'available');
    assert.equal(r.hasUnansweredQuestion, undefined);
  });

  test("'gemini_first' tries Gemini before the default leader", async () => {
    const calls = [];
    await understand({
      preference: 'gemini_first',
      providers: [rung('openai', 'openai', JSON_REPLY(false), calls), rung('gemini_flash_lite', 'gemini', JSON_REPLY(false), calls)],
    });
    assert.deepEqual(calls, ['gemini_flash_lite']);
  });

  test("'gemini_first' still falls back when Gemini fails", async () => {
    const calls = [];
    const r = await understand({
      preference: 'gemini_first',
      providers: [rung('openai', 'openai', JSON_REPLY(true), calls), rung('gemini_flash_lite', 'gemini', new Error('503 unavailable'), calls)],
    });
    assert.deepEqual(calls, ['gemini_flash_lite', 'openai']);
    assert.equal(r.status, 'available');
    assert.equal(r.providerUsed, 'openai');
  });

  test('without a preference the order is untouched', async () => {
    const calls = [];
    await understand({
      providers: [rung('openai', 'openai', JSON_REPLY(false), calls), rung('gemini_flash_lite', 'gemini', JSON_REPLY(false), calls)],
    });
    assert.deepEqual(calls, ['openai']);
  });

  test('the extraction prompt asks for the verdict', () => {
    assert.match(read('electron/services/screen/visionPrompts.ts'), /"hasUnansweredQuestion":/);
  });
});

describe('settings plumbing', () => {
  const ipc = read('electron/ipcHandlers.ts');
  const handler = (name) => {
    const i = ipc.indexOf(`safeHandle('${name}'`);
    assert.notEqual(i, -1, `${name} handler must exist`);
    const next = ipc.indexOf("safeHandle('", i + 12);
    return ipc.slice(i, next);
  };

  test('SettingsManager declares the three keys', () => {
    const sm = read('electron/services/SettingsManager.ts');
    assert.match(sm, /liveScreenContextEnabled\?: boolean;/);
    assert.match(sm, /screenOnlyAutoAnswerEnabled\?: boolean;/);
    assert.match(sm, /liveScreenContextIntervalMs\?: number;/);
  });

  test('get reads through the same resolver the runtime uses (so unset = off)', () => {
    const body = handler('screen-context:get-settings');
    assert.match(body, /resolveLiveScreenContextSettings\(/);
  });

  test('set clamps the interval, honours a refused write before telling the runtime, then re-arms', () => {
    const body = handler('screen-context:set-settings');
    assert.match(body, /clampLiveScreenContextInterval\(patch\.intervalMs\)/);
    const refused = body.indexOf("error: 'settings_store_degraded'");
    const notify = body.indexOf('onLiveScreenContextSettingsChanged');
    const ok = body.indexOf('success: true');
    assert.ok(refused !== -1 && notify !== -1 && ok !== -1);
    assert.ok(refused < notify && notify < ok, 'refusal short-circuits before the runtime is told anything changed');
  });

  test('preload and renderer types expose both calls', () => {
    const preload = read('electron/preload.ts');
    assert.match(preload, /screenContextGetSettings: \(\) => ipcRenderer\.invoke\('screen-context:get-settings'\)/);
    assert.match(preload, /ipcRenderer\.invoke\('screen-context:set-settings', patch\)/);
    const types = read('src/types/electron.d.ts');
    assert.match(types, /screenContextGetSettings: \(\) => Promise</);
    assert.match(types, /screenContextSetSettings: \(patch:/);
  });

  test('Settings mounts the Screen & Vision tab', () => {
    const overlay = read('src/components/SettingsOverlay.tsx');
    assert.match(overlay, /import \{ ScreenVisionSettings \} from '\.\/settings\/ScreenVisionSettings'/);
    assert.match(overlay, /'screen-vision',/);
    assert.match(overlay, /activeTab === 'screen-vision' && \(\s*<ScreenVisionSettings \/>/);
    const tab = read('src/components/settings/ScreenVisionSettings.tsx');
    assert.match(tab, /screenContextSetSettings\(patch\)/);
    assert.match(tab, /vision calls per minute/);
  });
});

describe('main.ts wiring', () => {
  const main = read('electron/main.ts');

  test('starts only after the session is marked active', () => {
    const active = main.indexOf('this.isMeetingActive = true;\n    this.broadcastMeetingState()\n    this.liveScreenContext.start();');
    assert.notEqual(active, -1);
  });

  test('stops on session end and on quit', () => {
    assert.match(main, /this\.cancelAutoAnswer\(\);\n    this\.stopLiveScreenContext\(\);/);
    const dispose = main.slice(main.indexOf('public disposeAutoAnswerForShutdown(): void {'));
    assert.match(dispose.slice(0, 120), /this\.stopLiveScreenContext\(\);/);
    assert.match(main, /appState\.disposeAutoAnswerForShutdown\?\.\(\);/);
  });

  test('capture goes through the shared capture session, outside the user queue', () => {
    const block = main.slice(main.indexOf('private readonly liveScreenContext = new LiveScreenContextController('));
    const capture = block.slice(block.indexOf('capture: () =>'), block.indexOf('describe: (imagePath)'));
    assert.match(capture, /withScreenshotCaptureSession\('full', false/);
    assert.match(capture, /takeBackgroundScreenshot\(/);
    assert.doesNotMatch(capture, /this\.takeScreenshot\(/, 'takeScreenshot would enter the user queue and meeting history');
    const helper = read('electron/ScreenshotHelper.ts');
    const bg = helper.slice(helper.indexOf('public async takeBackgroundScreenshot'), helper.indexOf('public async clearBackgroundScreenshots'));
    assert.match(bg, /captureWithDesktopCapturer\(/, 'same desktopCapturer path (and macOS permission check) as takeScreenshot');
    assert.doesNotMatch(bg, /screenshotQueue/);
  });

  test('describe uses the manual path\'s privacy policy, Gemini-first and the background deadline', () => {
    const d = main.slice(main.indexOf('private async describeLiveScreen('), main.indexOf('private stopLiveScreenContext('));
    assert.match(d, /localOnly: mode === 'private_vision'/);
    assert.match(d, /allowScreenshots: providerScopes\.screenshots !== false/);
    assert.match(d, /providerPreference: 'gemini_first'/);
    assert.match(d, /totalDeadlineMsOverride: LIVE_SCREEN_CONTEXT_DESCRIBE_DEADLINE_MS/);
    assert.match(d, /userAction: 'transcribe'/);
  });

  test('auto-answer dispatch reads the live context without waiting on a reused stream', () => {
    assert.match(main, /const screenContext = reuseSpeculative\s*\? undefined\s*: await this\.liveScreenContext\.resolveForAnswer\(\)/);
    const engine = read('electron/IntelligenceEngine.ts');
    assert.match(engine, /trigger\.screenContext \? \{ screenContext: trigger\.screenContext \} : undefined/);
  });
});
