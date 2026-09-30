// electron/llm/__tests__/CurrentProviderMapping2026_09_30.test.mjs
//
// getCurrentProvider() reported every OpenAI, Claude, Groq, DeepSeek and
// gateway selection as "gemini", and a cURL provider as "gemini" too. It feeds
// get-current-llm-config (the overlay's route/privacy label) and the Provider
// Performance Profile key, so an OpenAI user's latency evidence was filed under
// "gemini". It now derives from the Direct Assist classification, with cURL
// folded into "custom".
//
// Platform: pure string classification. No platform branch; identical on
// darwin and win32.
//
// Run: NATIVELY_CORE_SMOKE=1 node scripts/build-electron.js && node --test \
//        electron/llm/__tests__/CurrentProviderMapping2026_09_30.test.mjs

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const { LLMHelper } = require(path.join(root, 'dist-electron/electron/LLMHelper.js'));

function helper(currentModelId, extra = {}) {
  const h = Object.create(LLMHelper.prototype);
  h.currentModelId = currentModelId;
  h.useOllama = false;
  h.ollamaModel = '';
  h.customProvider = null;
  h.activeCurlProvider = null;
  h.codexCliConfig = { model: 'gpt-5.5', fastModel: 'gpt-5.5-mini', timeoutMs: 45000 };
  return Object.assign(h, extra);
}

describe('getCurrentProvider reports the provider that is actually selected', () => {
  const cases = [
    ['gemini-3.8-flash', 'gemini'],
    ['gpt-5.5', 'openai'],
    ['claude-opus-5', 'claude'],
    ['llama-3.3-70b-versatile', 'groq'],
    ['openai/gpt-oss-120b', 'groq'],
    ['deepseek-v4', 'deepseek'],
    ['natively', 'natively'],
    ['codex-cli:gpt-5.5', 'codex-cli'],
    ['antigravity:gemini-3.6-flash-low', 'antigravity'],
    ['nvidia_nim/openai/gpt-oss-120b', 'nvidia_nim'],
    ['openrouter/openai/gpt-4o', 'openrouter'],
    ['fluxion/claude-opus-5', 'fluxion'],
    ['litellm/openai/gpt-4o', 'litellm'],
    ['ninerouter/openai/gpt-5', 'ninerouter'],
  ];
  for (const [modelId, expected] of cases) {
    test(`${modelId} -> ${expected}`, () => {
      assert.equal(helper(modelId).getCurrentProvider(), expected);
    });
  }

  test('a cURL provider is reported as custom, not gemini', () => {
    const h = helper('gemini-3.8-flash', { activeCurlProvider: { id: 'curl-1', name: 'My cURL' } });
    assert.equal(h.getCurrentProvider(), 'custom');
  });

  test('a custom provider is reported as custom whatever model id is left behind', () => {
    const h = helper('gpt-5.5', { customProvider: { id: 'cp-1', name: 'Mine', model: 'mistral' } });
    assert.equal(h.getCurrentProvider(), 'custom');
  });

  test('Ollama wins over a stale cloud id, even with no model picked yet', () => {
    assert.equal(helper('gpt-5.5', { useOllama: true, ollamaModel: 'qwen3.5:4b' }).getCurrentProvider(), 'ollama');
    assert.equal(helper('gpt-5.5', { useOllama: true, ollamaModel: '' }).getCurrentProvider(), 'ollama');
  });

  test('an unresolvable selection keeps the old "gemini" default instead of throwing', () => {
    assert.equal(helper('').getCurrentProvider(), 'gemini');
    assert.equal(helper('mystery-model').getCurrentProvider(), 'gemini');
  });

  test('never reports the internal "curl" transport id', () => {
    for (const [modelId] of cases) {
      assert.notEqual(helper(modelId, { activeCurlProvider: { id: 'c' } }).getCurrentProvider(), 'curl');
    }
  });
});

describe('the Provider Performance Profile key follows the same mapping', () => {
  // The store keys profiles by providerId|modelId|network and treats the id as
  // an opaque string (lookup falls back to providerId alone), so no lookup
  // table needed new entries. What matters is that an OpenAI turn is no longer
  // filed under, or seeded from, "gemini" evidence.
  const routeStubs = { isUsingCodexCli: () => false, isUsingUserEndpoint: () => false };

  test('an OpenAI selection is profiled as openai', () => {
    const id = helper('gpt-5.5', routeStubs).performanceIdentity(false);
    assert.equal(id.providerId, 'openai');
    assert.equal(id.modelId, 'gpt-5.5');
  });

  test('a cURL provider is profiled as custom under its own model', () => {
    const id = helper('gemini-3.8-flash', { ...routeStubs, activeCurlProvider: { id: 'curl-1', model: 'llama-local' } })
      .performanceIdentity(false);
    assert.equal(id.providerId, 'custom');
    assert.equal(id.modelId, 'llama-local');
  });
});
