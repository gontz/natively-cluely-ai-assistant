// electron/services/__tests__/LiveScreenContextController2026_09_30.test.mjs
//
// Live screen context (ported from rishikeshl0510's fork, 0a4b3de / d61a740):
// the periodic capture scheduler, the tiered freshness policy an answer reads
// through, the settings normalization, and the screen-only auto-answer gate.
// Fake clock, fake host, no Electron.
//
// Run: `ELECTRON_RUN_AS_NODE=1 electron --test` (or plain node --test) after
// `NATIVELY_CORE_SMOKE=1 node scripts/build-electron.js`.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { FakeClock } from '../../intelligence/autoAnswer/__tests__/fakeClock.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const mod = require(path.resolve(__dirname, '../../../dist-electron/electron/services/screen/LiveScreenContextController.js'));
const {
  LiveScreenContextController,
  ScreenOnlyAutoAnswerGate,
  resolveLiveScreenContextSettings,
  clampLiveScreenContextInterval,
  isScreenPermissionError,
  LIVE_SCREEN_CONTEXT_DEFAULT_INTERVAL_MS,
  LIVE_SCREEN_CONTEXT_MIN_INTERVAL_MS,
  LIVE_SCREEN_CONTEXT_MAX_INTERVAL_MS,
  LIVE_SCREEN_CONTEXT_INFLIGHT_WAIT_MS,
} = mod;
const { orderVisionProvidersGeminiFirst } = require(path.resolve(__dirname, '../../../dist-electron/electron/services/screen/visionProviderOrder.js'));

const flush = async () => { for (let i = 0; i < 5; i++) await new Promise((r) => setImmediate(r)); };
const INTERVAL = 15_000;

function deferred() {
  let resolve, reject;
  const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

function available(over = {}) {
  return { status: 'available', extractedText: 'Given an array nums, return two indices that add up to target.', hasUnansweredQuestion: false, capturedAt: 0, ...over };
}

function makeHost(over = {}) {
  const state = {
    settings: { enabled: true, screenOnlyAutoAnswer: false, intervalMs: INTERVAL },
    sessionActive: true,
    allowed: { ok: true },
    captures: 0,
    describes: 0,
    dispatched: [],
    logs: [],
    captureImpl: async () => `/tmp/live-${state.captures}.png`,
    describeImpl: async () => available(),
    env: { autoAnswerEnabled: true, sessionActive: true, engineAccepting: true, answerStreaming: false, interviewerSpeechPending: false },
    ...over,
  };
  const host = {
    settings: () => state.settings,
    sessionActive: () => state.sessionActive,
    captureAllowed: () => state.allowed,
    capture: () => { state.captures++; return state.captureImpl(); },
    describe: (p) => { state.describes++; return state.describeImpl(p); },
    screenOnlyEnv: () => state.env,
    dispatchScreenQuestion: (text, result) => { state.dispatched.push({ text, result }); },
    log: (l) => state.logs.push(l),
  };
  return { state, host };
}

describe('settings: off by default, interval clamped', () => {
  test('unset, false, or non-boolean values are off', () => {
    for (const raw of [undefined, null, {}, { liveScreenContextEnabled: false }, { liveScreenContextEnabled: 'true' }, { liveScreenContextEnabled: 1 }]) {
      const s = resolveLiveScreenContextSettings(raw);
      assert.equal(s.enabled, false, JSON.stringify(raw));
      assert.equal(s.screenOnlyAutoAnswer, false, JSON.stringify(raw));
    }
  });

  test('screen-only answer needs live screen context itself', () => {
    assert.equal(resolveLiveScreenContextSettings({ screenOnlyAutoAnswerEnabled: true }).screenOnlyAutoAnswer, false);
    assert.equal(resolveLiveScreenContextSettings({ liveScreenContextEnabled: true, screenOnlyAutoAnswerEnabled: true }).screenOnlyAutoAnswer, true);
  });

  test('default interval is no shorter than the fork default (10s), and bounds hold', () => {
    assert.ok(LIVE_SCREEN_CONTEXT_DEFAULT_INTERVAL_MS >= 10_000);
    assert.equal(resolveLiveScreenContextSettings({}).intervalMs, LIVE_SCREEN_CONTEXT_DEFAULT_INTERVAL_MS);
    assert.equal(clampLiveScreenContextInterval(1_000), LIVE_SCREEN_CONTEXT_MIN_INTERVAL_MS);
    assert.equal(clampLiveScreenContextInterval(10 * 60_000), LIVE_SCREEN_CONTEXT_MAX_INTERVAL_MS);
    assert.equal(clampLiveScreenContextInterval('20000'), LIVE_SCREEN_CONTEXT_DEFAULT_INTERVAL_MS);
    assert.equal(clampLiveScreenContextInterval(Number.NaN), LIVE_SCREEN_CONTEXT_DEFAULT_INTERVAL_MS);
    assert.equal(clampLiveScreenContextInterval(30_000), 30_000);
  });
});

describe('scheduler', () => {
  test('off: start() captures nothing and arms no timer', async () => {
    const clock = new FakeClock();
    const { state, host } = makeHost();
    state.settings = resolveLiveScreenContextSettings({});
    const c = new LiveScreenContextController(host, clock);
    c.start();
    clock.advance(10 * INTERVAL);
    await flush();
    assert.equal(state.captures, 0);
    assert.equal(clock.pendingCount(), 0);
    assert.equal(c.isRunning(), false);
    assert.equal(await c.resolveForAnswer(), undefined);
  });

  test('no live session: nothing runs even when enabled', async () => {
    const clock = new FakeClock();
    const { state, host } = makeHost({ sessionActive: false });
    const c = new LiveScreenContextController(host, clock);
    c.start();
    await c.refresh();
    assert.equal(state.captures, 0);
    assert.equal(clock.pendingCount(), 0);
  });

  test('on: captures at start, then once per interval', async () => {
    const clock = new FakeClock();
    const { state, host } = makeHost();
    const c = new LiveScreenContextController(host, clock);
    c.start();
    await flush();
    assert.equal(state.captures, 1, 'first capture at session start');
    clock.advance(INTERVAL); await flush();
    assert.equal(state.captures, 2);
    clock.advance(INTERVAL); await flush();
    assert.equal(state.captures, 3);
    assert.equal(state.describes, 3);
  });

  test('never overlaps: a tick while the previous capture runs is skipped', async () => {
    const clock = new FakeClock();
    const slow = deferred();
    const { state, host } = makeHost({ describeImpl: () => slow.promise });
    const c = new LiveScreenContextController(host, clock);
    c.start();
    await flush();
    assert.equal(state.captures, 1);
    clock.advance(INTERVAL); await flush();
    clock.advance(INTERVAL); await flush();
    assert.equal(state.captures, 1, 'no second capture while the first describe is pending');
    assert.ok(state.logs.some((l) => l.includes('tick skipped')));
    // A prefetch-signal refresh joins the running one instead of starting another.
    const joined = c.refresh();
    assert.equal(state.captures, 1);
    slow.resolve(available());
    await joined;
    clock.advance(INTERVAL); await flush();
    assert.equal(state.captures, 2, 'the next tick after it settles captures again');
  });

  test('refresh inside the interval of a fresh description is free', async () => {
    const clock = new FakeClock();
    const { state, host } = makeHost();
    const c = new LiveScreenContextController(host, clock);
    c.start();
    await flush();
    await c.refresh();
    await c.refresh();
    assert.equal(state.captures, 1);
  });

  test('stop() on session end clears the timer and drops the description', async () => {
    const clock = new FakeClock();
    const { state, host } = makeHost();
    const c = new LiveScreenContextController(host, clock);
    c.start();
    await flush();
    c.stop();
    assert.equal(clock.pendingCount(), 0);
    clock.advance(10 * INTERVAL); await flush();
    assert.equal(state.captures, 1);
    assert.equal(await c.resolveForAnswer(), undefined);
    c.stop(); // idempotent
  });

  test('session ending without stop(): the next tick stops the loop', async () => {
    const clock = new FakeClock();
    const { state, host } = makeHost();
    const c = new LiveScreenContextController(host, clock);
    c.start();
    await flush();
    state.sessionActive = false;
    clock.advance(INTERVAL); await flush();
    assert.equal(state.captures, 1);
    assert.equal(c.isRunning(), false);
    assert.equal(clock.pendingCount(), 0);
  });

  test('a describe that finishes after stop() is discarded', async () => {
    const clock = new FakeClock();
    const slow = deferred();
    const { state, host } = makeHost({ describeImpl: () => slow.promise, settings: { enabled: true, screenOnlyAutoAnswer: true, intervalMs: INTERVAL } });
    const c = new LiveScreenContextController(host, clock);
    c.start();
    await flush();
    c.stop();
    slow.resolve(available({ hasUnansweredQuestion: true }));
    await flush();
    assert.equal(state.dispatched.length, 0);
    assert.equal(await c.resolveForAnswer(), undefined);
  });

  test('toggle off mid-session stops at once; toggle on mid-session starts', async () => {
    const clock = new FakeClock();
    const { state, host } = makeHost();
    const c = new LiveScreenContextController(host, clock);
    c.start();
    await flush();
    state.settings = { ...state.settings, enabled: false };
    c.settingsChanged();
    assert.equal(c.isRunning(), false);
    assert.equal(clock.pendingCount(), 0);
    state.settings = { ...state.settings, enabled: true };
    c.settingsChanged();
    await flush();
    assert.equal(c.isRunning(), true);
    assert.equal(state.captures, 2);
  });

  test('toggle off without settingsChanged(): the next tick stops', async () => {
    const clock = new FakeClock();
    const { state, host } = makeHost();
    const c = new LiveScreenContextController(host, clock);
    c.start();
    await flush();
    state.settings = { ...state.settings, enabled: false };
    clock.advance(INTERVAL); await flush();
    assert.equal(state.captures, 1);
    assert.equal(clock.pendingCount(), 0);
  });

  test('interval change re-arms on the new interval', async () => {
    const clock = new FakeClock();
    const { state, host } = makeHost();
    const c = new LiveScreenContextController(host, clock);
    c.start();
    await flush();
    state.settings = { ...state.settings, intervalMs: 60_000 };
    c.settingsChanged();
    clock.advance(INTERVAL); await flush();
    assert.equal(state.captures, 1);
    clock.advance(60_000 - INTERVAL); await flush();
    assert.equal(state.captures, 2);
  });

  test('capture not allowed (scope off, overlay hidden) skips without capturing', async () => {
    const clock = new FakeClock();
    const { state, host } = makeHost({ allowed: { ok: false, reason: 'screenshots data scope is off' } });
    const c = new LiveScreenContextController(host, clock);
    c.start();
    clock.advance(3 * INTERVAL); await flush();
    assert.equal(state.captures, 0);
    state.allowed = { ok: true };
    clock.advance(INTERVAL); await flush();
    assert.equal(state.captures, 1, 'resumes once the gate opens');
  });

  for (const [platform, message] of [
    ['darwin', 'Failed to take screenshot: Screen Recording permission is denied. Enable it in System Settings > Privacy & Security > Screen Recording, then restart Natively.'],
    ['darwin', 'Screen Recording permission has not been granted yet. Please restart Natively — you will be prompted to grant access on next launch.'],
    ['win32', 'Screen capture permission denied by the OS. Please try again or restart Natively.'],
  ]) {
    test(`permission failure (${platform} message) pauses the session instead of retrying on the timer`, async () => {
      const clock = new FakeClock();
      const { state, host } = makeHost({ captureImpl: async () => { throw new Error(message); } });
      const c = new LiveScreenContextController(host, clock);
      c.start();
      await flush();
      assert.equal(state.captures, 1);
      clock.advance(10 * INTERVAL); await flush();
      await c.refresh();
      assert.equal(state.captures, 1, 'no repeated capture attempts after a permission failure');
      assert.equal(clock.pendingCount(), 0);
      // A new session tries again (the user may have granted it meanwhile).
      state.captureImpl = async () => '/tmp/ok.png';
      c.start();
      await flush();
      assert.equal(state.captures, 2);
    });
  }

  test('an ordinary capture failure keeps the timer running', async () => {
    const clock = new FakeClock();
    let fail = true;
    const { state, host } = makeHost({ captureImpl: async () => { if (fail) throw new Error('Screenshot capture already in progress'); return '/tmp/x.png'; } });
    const c = new LiveScreenContextController(host, clock);
    c.start();
    await flush();
    fail = false;
    clock.advance(INTERVAL); await flush();
    assert.equal(state.captures, 2);
    assert.equal(state.describes, 1);
    assert.equal(isScreenPermissionError(new Error('Screenshot capture already in progress')), false);
  });
});

describe('resolveForAnswer: tiered freshness', () => {
  test('fresh → the description, immediately', async () => {
    const clock = new FakeClock();
    const { host } = makeHost();
    const c = new LiveScreenContextController(host, clock);
    c.start();
    await flush();
    const r = await c.resolveForAnswer();
    assert.equal(r?.status, 'available');
  });

  test('in flight → waits at most the bounded window', async () => {
    const clock = new FakeClock();
    const slow = deferred();
    const { state, host } = makeHost();
    const c = new LiveScreenContextController(host, clock);
    c.start();
    await flush();
    state.describeImpl = () => slow.promise;
    clock.advance(INTERVAL); await flush();
    assert.equal(c.isCaptureInFlight(), true);
    let settled = false;
    const p = c.resolveForAnswer().then((r) => { settled = true; return r; });
    await flush();
    assert.equal(settled, false, 'waits for the running capture');
    clock.advance(LIVE_SCREEN_CONTEXT_INFLIGHT_WAIT_MS); await flush();
    assert.equal(settled, true, 'but never past the bound');
    const r = await p;
    assert.equal(r?.status, 'available', 'stale-but-recent description still used');
    slow.resolve(available());
  });

  test('too old → none (no synchronous capture)', async () => {
    const clock = new FakeClock();
    const { state, host } = makeHost();
    const c = new LiveScreenContextController(host, clock);
    c.start();
    await flush();
    state.allowed = { ok: false, reason: 'overlay not shown' };
    clock.advance(5 * 60_000); await flush();
    const before = state.captures;
    assert.equal(await c.resolveForAnswer(), undefined);
    assert.equal(state.captures, before);
  });
});

describe('screen-only auto-answer gate (vision-model classified)', () => {
  const env = { autoAnswerEnabled: true, sessionActive: true, engineAccepting: true, answerStreaming: false, interviewerSpeechPending: false };
  const q = (text, has = true) => available({ extractedText: text, hasUnansweredQuestion: has });

  test('fires only when the vision model says there is an unanswered question', () => {
    const g = new ScreenOnlyAutoAnswerGate();
    assert.deepEqual(g.evaluate(q('A list of problems: Two Sum, Three Sum, Valid Parentheses', false), env), { fire: false, reason: 'no_question_on_screen' });
    // undefined (non-transcribe path, or the model omitted it) counts as false
    assert.equal(g.evaluate(available({ extractedText: 'Something', hasUnansweredQuestion: undefined }), env).fire, false);
    const d = g.evaluate(q('Implement an LRU cache with get and put in O(1).'), env);
    assert.equal(d.fire, true);
  });

  test('no regex: a question-shaped text the model rejects never fires', () => {
    const g = new ScreenOnlyAutoAnswerGate();
    assert.equal(g.evaluate(q('What is the time complexity of this?', false), env).fire, false);
  });

  test('each environment gate blocks it', () => {
    for (const [key, value, reason] of [
      ['autoAnswerEnabled', false, 'auto_answer_off'],
      ['sessionActive', false, 'no_session'],
      ['engineAccepting', false, 'engine_busy'],
      ['answerStreaming', true, 'answer_streaming'],
      ['interviewerSpeechPending', true, 'interviewer_speaking'],
    ]) {
      const g = new ScreenOnlyAutoAnswerGate();
      assert.deepEqual(g.evaluate(q('Reverse a linked list in place.'), { ...env, [key]: value }), { fire: false, reason }, key);
    }
    const g = new ScreenOnlyAutoAnswerGate();
    assert.equal(g.evaluate({ status: 'failed' }, env).reason, 'no_screen_context');
    assert.equal(g.evaluate(available({ extractedText: '  ', visibleSummary: '' }), env).reason, 'no_text');
  });

  test('the same question (with OCR noise) does not fire twice; a new one does', () => {
    const g = new ScreenOnlyAutoAnswerGate();
    assert.equal(g.evaluate(q('Design a rate limiter for an API gateway. AI traffic 10k rps.'), env).fire, true);
    assert.deepEqual(g.evaluate(q('Design a rate limiter for an API gateway. Al traffic 10k rps.'), env), { fire: false, reason: 'already_answered' });
    const next = g.evaluate(q('Write SQL to find the second highest salary per department.'), env);
    assert.equal(next.fire, true);
    assert.equal(next.text, 'Write SQL to find the second highest salary per department.', 'the answered question is not merged into the next one');
  });

  test('scrolled captures are merged, oldest first', () => {
    const g = new ScreenOnlyAutoAnswerGate();
    g.evaluate(q('Part one of the problem statement', false), env);
    const d = g.evaluate(q('Part two with the constraints'), env);
    assert.equal(d.fire, true);
    assert.equal(d.text, 'Part one of the problem statement\n---\nPart two with the constraints');
  });

  test('controller: dispatches only with the screen-only toggle on', async () => {
    for (const screenOnly of [false, true]) {
      const clock = new FakeClock();
      const { state, host } = makeHost({
        settings: { enabled: true, screenOnlyAutoAnswer: screenOnly, intervalMs: INTERVAL },
        describeImpl: async () => q('Implement debounce in JavaScript.'),
      });
      const c = new LiveScreenContextController(host, clock);
      c.start();
      await flush();
      assert.equal(state.dispatched.length, screenOnly ? 1 : 0, `screenOnly=${screenOnly}`);
      if (screenOnly) {
        assert.equal(state.dispatched[0].text, 'Implement debounce in JavaScript.');
        assert.equal(state.dispatched[0].result.status, 'available');
        clock.advance(INTERVAL); await flush();
        assert.equal(state.dispatched.length, 1, 'unchanged screen does not re-fire');
      }
    }
  });
});

describe('Gemini-first provider order', () => {
  const rung = (id, hint) => ({ id, hint });
  test('Gemini rungs lead, everything else kept in order as fallback', () => {
    const input = [rung('natively', 'natively'), rung('openai', 'openai'), rung('gemini_flash_lite', 'gemini'), rung('gemini_flash', 'gemini'), rung('claude', 'claude'), rung('gemini_pro', 'gemini'), rung('ollama', 'ollama')];
    assert.deepEqual(orderVisionProvidersGeminiFirst(input).map((p) => p.id),
      ['gemini_flash_lite', 'gemini_flash', 'gemini_pro', 'natively', 'openai', 'claude', 'ollama']);
  });
  test('private_vision (local-only list) is unchanged: nothing is added', () => {
    const local = [rung('ollama', 'ollama'), rung('codex', 'openai'), rung('custom', 'openai')];
    assert.deepEqual(orderVisionProvidersGeminiFirst(local).map((p) => p.id), ['ollama', 'codex', 'custom']);
  });
});
