// electron/services/__tests__/InterviewKnowledgeContext.test.mjs
//
// The seam between the Interview Knowledge store and answer generation
// (interviewKnowledgeContext.ts): WHEN it may inject, WHAT it injects, and that
// it never throws into an answer. The store and the agentic loop are injected
// fakes, so no database or embedding provider is involved.

import { test, describe, mock } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const mod = await import(pathToFileURL(path.resolve(
  __dirname, '../../../dist-electron/electron/services/interviewKnowledge/interviewKnowledgeContext.js',
)).href);

function fakeSource(overrides = {}) {
  return {
    hasAnyDocs: () => true,
    getHybridRetriever: () => ({ retrieve: async () => ({ chunks: [] }) }),
    ensureAllIndexed: mock.fn(async () => {}),
    getReferenceFiles: () => [{ id: 'ik_1', modeId: '__interview_knowledge__', fileName: 'resume.md', content: 'x', createdAt: 'now' }],
    getDocTypeMap: () => new Map([['ik_1', 'resume']]),
    ...overrides,
  };
}

const chunk = (text, i = 0) => ({ sourceId: 'ik_1', fileName: 'resume.md', text, chunkIndex: i, score: 1, ftsScore: 1, vectorScore: 1, trustLevel: 'untrusted_reference' });

describe('shouldInjectInterviewKnowledge', () => {
  test('injects on an ordinary turn', () => {
    assert.equal(mod.shouldInjectInterviewKnowledge({}), true);
  });
  for (const key of ['ignoreKnowledgeMode', 'v3Owned', 'contextOsGoverned', 'strictDocumentGrounded']) {
    test(`never injects when ${key}`, () => {
      assert.equal(mod.shouldInjectInterviewKnowledge({ [key]: true }), false);
    });
  }
});

describe('buildInterviewKnowledgeInjection', () => {
  test('no docs: nothing injected, retrieval never runs', async () => {
    const retrieveFn = mock.fn();
    const r = await mod.buildInterviewKnowledgeInjection({ question: 'q', live: true, source: fakeSource({ hasAnyDocs: () => false }), retrieveFn });
    assert.equal(r.contextBlock, null);
    assert.deepEqual(r.citations, []);
    assert.equal(retrieveFn.mock.callCount(), 0);
  });

  test('pipeline not ready yet: degrades to nothing instead of throwing', async () => {
    const retrieveFn = mock.fn();
    const r = await mod.buildInterviewKnowledgeInjection({ question: 'q', live: true, source: fakeSource({ getHybridRetriever: () => null }), retrieveFn });
    assert.equal(r.contextBlock, null);
    assert.equal(retrieveFn.mock.callCount(), 0);
  });

  test('live path: bounded to 2 rounds with a deadline, indexing kicked but not awaited', async () => {
    let releaseIndexing;
    const source = fakeSource({ ensureAllIndexed: mock.fn(() => new Promise((resolve) => { releaseIndexing = resolve; })) });
    const retrieveFn = mock.fn(async () => ({ formattedContext: '[Source: resume.md]\nBuilt the billing service.', chunks: [chunk('Built the billing service.')], coverage: null, rounds: 1 }));
    const r = await mod.buildInterviewKnowledgeInjection({ question: 'What did I build?', live: true, source, retrieveFn });
    // Resolved while indexing is still pending: the live answer never waits on embedding.
    assert.equal(source.ensureAllIndexed.mock.callCount(), 1);
    const args = retrieveFn.mock.calls[0].arguments[0];
    assert.equal(args.maxRounds, 2);
    assert.equal(args.deadlineMs, mod.LIVE_RETRIEVAL_DEADLINE_MS);
    assert.equal(args.docTypeById.get('ik_1'), 'resume');
    assert.ok(r.contextBlock.startsWith(mod.INTERVIEW_KNOWLEDGE_CONTEXT_HEADER));
    assert.match(r.contextBlock, /billing service/);
    assert.deepEqual(r.citations, [{ sourceId: 'ik_1', fileName: 'resume.md', text: 'Built the billing service.' }]);
    releaseIndexing();
  });

  test('manual path: awaits indexing, allows 3 rounds, no deadline', async () => {
    const order = [];
    const source = fakeSource({ ensureAllIndexed: mock.fn(async () => { order.push('index'); }) });
    const retrieveFn = mock.fn(async () => { order.push('retrieve'); return { formattedContext: '', chunks: [], coverage: null, rounds: 1 }; });
    const r = await mod.buildInterviewKnowledgeInjection({ question: 'q', live: false, source, retrieveFn });
    assert.deepEqual(order, ['index', 'retrieve']);
    assert.equal(retrieveFn.mock.calls[0].arguments[0].maxRounds, 3);
    assert.equal(retrieveFn.mock.calls[0].arguments[0].deadlineMs, undefined);
    assert.equal(r.contextBlock, null, 'an empty retrieval must not inject a header-only block');
  });

  test('a throwing retrieval never breaks the answer', async () => {
    const r = await mod.buildInterviewKnowledgeInjection({ question: 'q', live: true, source: fakeSource(), retrieveFn: async () => { throw new Error('boom'); } });
    assert.equal(r.contextBlock, null);
    assert.deepEqual(r.citations, []);
  });
});

describe('citations and context merge', () => {
  test('citation text is capped so a huge chunk cannot flood IPC or the card', () => {
    const [c] = mod.toCitations([chunk('a'.repeat(mod.CITATION_TEXT_MAX_CHARS + 50))]);
    assert.equal(c.text.length, mod.CITATION_TEXT_MAX_CHARS + 1);
    assert.ok(c.text.endsWith('…'));
  });

  test('block is prepended to existing context, absent block leaves it untouched', () => {
    assert.equal(mod.mergeInterviewKnowledgeContext('ctx', null), 'ctx');
    assert.equal(mod.mergeInterviewKnowledgeContext(undefined, null), undefined);
    assert.equal(mod.mergeInterviewKnowledgeContext(undefined, 'B'), 'B');
    assert.equal(mod.mergeInterviewKnowledgeContext('ctx', 'B'), 'B\n\nctx');
  });
});
