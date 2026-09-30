// electron/services/__tests__/InterviewKnowledgeWiring.test.mjs
//
// Source-level pins for the Interview Knowledge answer wiring, which lives in
// files too large to execute in a unit test (LLMHelper, ipcHandlers, main):
//  • both LLMHelper entry points consult the gate, and the streamed one passes
//    the V3 / Context OS / strict-doc-grounded flags it must respect;
//  • citations are keyed per turn (abort signal), never a shared "last" slot,
//    and the manual-chat done event reads them with the SAME signal;
//  • main injects the shared, initialized embedding pipeline (no second one).

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const electronDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const read = (rel) => fs.readFileSync(path.join(electronDir, rel), 'utf8');

describe('Interview Knowledge wiring', () => {
  const llm = read('LLMHelper.ts');

  test('streamed path gates on V3-owned, Context OS governed and strict doc-grounded turns', () => {
    const at = llm.indexOf("ikModule.shouldInjectInterviewKnowledge({ ignoreKnowledgeMode, v3Owned: v3OwnedTurn, contextOsGoverned: contextOsGovernedDocumentTurn, strictDocumentGrounded: strictDocGroundedForLog })");
    assert.ok(at > 0, 'the streamed gate call is missing or no longer passes every flag');
    // It must run after the flags are computed and before the premium knowledge intercept.
    assert.ok(llm.lastIndexOf('const v3OwnedTurn = routeOptions?.v3Owned === true;', at) > 0);
    assert.ok(llm.indexOf('if (shouldRunKnowledge) {', at) > at);
    assert.ok(llm.slice(at, at + 900).includes('live: true'));
  });

  test('non-streaming chatWithGemini path is wired too, without per-turn citations', () => {
    const start = llm.indexOf('public async chatWithGemini(');
    const end = llm.indexOf('\n  public ', start + 10);
    const body = llm.slice(start, end);
    assert.match(body, /buildInterviewKnowledgeInjection\(\{ question: message, live: false \}\)/);
    assert.ok(!body.includes('interviewKnowledgeCitationsByTurn'), 'chatWithGemini has no turn key to store citations under');
  });

  test('citations are stored per turn in a WeakMap keyed by the abort signal', () => {
    assert.match(llm, /interviewKnowledgeCitationsByTurn: WeakMap<object,/);
    assert.match(llm, /this\.interviewKnowledgeCitationsByTurn\.set\(abortSignal, ik\.citations\)/);
    assert.ok(!/lastInterviewKnowledgeCitations/.test(llm), 'a single shared slot would leak one turn\'s sources onto a concurrent turn');
  });

  test('manual-chat done event reads citations with the same controller signal the answer streamed under', () => {
    const ipc = read('ipcHandlers.ts');
    assert.match(ipc, /llmHelper\.getInterviewKnowledgeCitations\?\.\(myController\?\.signal\)/);
    assert.match(ipc, /if \(ikCitations\) event\.sender\.send\('gemini-stream-done', \{ \.\.\.\(finalText \? \{ finalText \} : \{\}\), citations: ikCitations, streamId: myStreamId \}\)/);
  });

  test('main injects the shared RAG pipeline into the retriever', () => {
    const main = read('main.ts');
    assert.match(main, /InterviewKnowledgeRetriever\.getInstance\(\)\.setSharedEmbeddingPipeline\(modeEmbeddingPipeline\)/);
    const code = read('services/interviewKnowledge/InterviewKnowledgeRetriever.ts')
      .split('\n').filter((line) => !/^\s*(\/\/|\*|\/\*\*)/.test(line)).join('\n');
    assert.ok(!/new EmbeddingPipeline\(/.test(code), 'the retriever must never build its own embedding pipeline');
  });
});
