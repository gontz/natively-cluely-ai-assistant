// electron/llm/__tests__/MeetingSummarySelectedModel2026_09_30.test.mjs
//
// generateMeetingSummary ran a FIXED ladder (custom, Natively, Codex,
// Antigravity, Groq, Gemini, Ollama) that never consulted the selected model.
// A user whose only key was OpenAI, Claude or DeepSeek had no rung that could
// reach it and got no post-call summary at all. The selection now leads
// (through streamChatLongForm, the chat path) and the ladder is the fallback.
//
// Two layers are pinned: the pure order/budget decision
// (LLMHelper.planMeetingSummaryLead) and the real ladder driven on a helper
// whose provider calls are stubbed, so no network is touched.
//
// Platform: no platform branch in either path. Identical on darwin and win32.
//
// Run: NATIVELY_CORE_SMOKE=1 node scripts/build-electron.js && node --test \
//        electron/llm/__tests__/MeetingSummarySelectedModel2026_09_30.test.mjs

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import Module, { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import fs from 'node:fs';
import os from 'node:os';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '../../..');
const cjs = createRequire(path.join(root, 'package.json'));

// Same electron stub as MeetingSummaryNoGeminiClient2026_09_23.test.mjs:
// LLMHelper's constructor reaches app.getPath('userData').
const tmpUserData = fs.mkdtempSync(path.join(os.tmpdir(), 'summary-selected-model-test-'));
const electronStub = new Module('electron');
electronStub.exports = {
  app: {
    isReady: () => true,
    getPath: (n) => (n === 'userData' ? tmpUserData : os.tmpdir()),
    getAppPath: () => root,
    getName: () => 'natively-test',
    getVersion: () => '0.0.0-test',
    isPackaged: false,
    on: () => {},
  },
  shell: { openPath: async () => '' },
  safeStorage: { isEncryptionAvailable: () => false },
  ipcMain: { on: () => {}, handle: () => {}, removeAllListeners: () => {} },
  BrowserWindow: { getAllWindows: () => [] },
  desktopCapturer: { getSources: async () => [] },
  net: { isOnline: () => true },
};
electronStub.loaded = true;
cjs.cache[cjs.resolve('electron')] = electronStub;

const { LLMHelper } = cjs(path.join(root, 'dist-electron/electron/LLMHelper.js'));
const plan = (provider, callerTimeoutMs, codexTimeoutMs = 45000) =>
  LLMHelper.planMeetingSummaryLead(provider, callerTimeoutMs, codexTimeoutMs);

describe('which selection leads the summary ladder, and for how long', () => {
  test('OpenAI, Claude, DeepSeek and the gateways lead: the ladder has no rung for them', () => {
    for (const p of ['openai', 'claude', 'deepseek', 'nvidia_nim', 'openrouter', 'fluxion', 'litellm', 'ninerouter']) {
      assert.deepEqual(plan(p, undefined), { provider: p, timeoutMs: 60000 }, p);
      assert.deepEqual(plan(p, 30000), { provider: p, timeoutMs: 35000 }, `${p} honours the caller budget`);
    }
  });

  test('Gemini, Groq and Antigravity lead with the SELECTED model, on the caller budget', () => {
    for (const p of ['gemini', 'groq', 'antigravity']) {
      assert.deepEqual(plan(p, 30000), { provider: p, timeoutMs: 35000 }, p);
    }
  });

  test('custom and cURL keep the budget their rung always had', () => {
    assert.deepEqual(plan('custom', 30000), { provider: 'custom', timeoutMs: 60000 });
    assert.deepEqual(plan('curl', undefined), { provider: 'curl', timeoutMs: 60000 });
  });

  test('local transports keep their longer cold-start budgets', () => {
    assert.deepEqual(plan('ollama', 30000), { provider: 'ollama', timeoutMs: 120000 });
    assert.deepEqual(plan('codex-cli', 30000, 45000), { provider: 'codex-cli', timeoutMs: 60000 });
    assert.deepEqual(plan('codex-cli', 30000, 90000), { provider: 'codex-cli', timeoutMs: 90000 });
  });

  test('Natively does not lead (its own rung is first and forwards purpose/timeout)', () => {
    assert.equal(plan('natively', 30000), null);
  });

  test('nothing selected leaves the ladder as it was', () => {
    assert.equal(plan(null, undefined), null);
  });
});

function helperWith(modelId) {
  const h = new LLMHelper(undefined, false);
  h.currentModelId = modelId;
  const calls = { lead: [], natively: 0, ollama: 0 };
  h.hasNatively = () => true;
  h.generateWithNatively = async () => { calls.natively++; return 'Natively summary.'; };
  h.callOllama = async () => { calls.ollama++; return 'Ollama summary.'; };
  const leadWith = (behaviour) => {
    h.streamChatLongForm = (...args) => {
      calls.lead.push(args);
      const outcome = { truncated: false };
      const stream = (async function* () {
        if (behaviour instanceof Error) throw behaviour;
        yield behaviour;
      })();
      return { stream, outcome };
    };
  };
  return { h, calls, leadWith };
}

describe('the real ladder', () => {
  for (const [label, modelId] of [['OpenAI', 'gpt-5.5'], ['Claude', 'claude-opus-5'], ['DeepSeek', 'deepseek-v4']]) {
    test(`a ${label} selection is summarised by the selected model, not the fixed ladder`, async () => {
      const { h, calls, leadWith } = helperWith(modelId);
      leadWith('Selected summary.');
      const out = await h.generateMeetingSummary('Summarise.', 'Alice: we ship Friday.', undefined, { timeoutMs: 30000 });
      assert.match(out, /Selected summary\./);
      assert.equal(calls.lead.length, 1);
      assert.equal(calls.natively, 0, 'the fixed ladder must not run when the selection answered');
      const [message, , , systemPrompt, ignoreKnowledgeMode, , , signal] = calls.lead[0];
      assert.match(message, /Alice: we ship Friday\./);
      assert.equal(systemPrompt, 'Summarise.');
      assert.equal(ignoreKnowledgeMode, true, 'summaries must bypass the knowledge intercept');
      assert.ok(signal instanceof AbortSignal, 'the lead attempt must be abortable');
      assert.equal(signal.aborted, true, 'the lead stream is torn down once the attempt settles');
    });
  }

  test('a failing selection falls back to the existing ladder', async () => {
    const { h, calls, leadWith } = helperWith('gpt-5.5');
    leadWith(new Error('401 invalid api key'));
    const out = await h.generateMeetingSummary('Summarise.', 'Alice: we ship Friday.');
    assert.match(out, /Natively summary\./);
    assert.equal(calls.lead.length, 1);
    assert.equal(calls.natively, 1);
  });

  test('a Natively selection keeps its own rung first and skips the chat path', async () => {
    const { h, calls, leadWith } = helperWith('natively');
    leadWith('should not be used');
    const out = await h.generateMeetingSummary('Summarise.', 'Alice: we ship Friday.');
    assert.match(out, /Natively summary\./);
    assert.equal(calls.lead.length, 0);
  });

  test('an Ollama selection that already led is not retried as the last rung', async () => {
    const { h, calls, leadWith } = helperWith('gemini-3.8-flash');
    h.useOllama = true;
    h.ollamaModel = 'qwen3.5:4b';
    h.hasNatively = () => false;
    leadWith(new Error('connection refused'));
    await assert.rejects(
      h.generateMeetingSummary('Summarise.', 'Alice: we ship Friday.'),
      /Failed to generate summary after all fallback attempts/,
    );
    assert.equal(calls.lead.length, 1);
    assert.equal(calls.ollama, 0, 'Ollama was the lead; a second identical attempt only costs time');
  });
});
