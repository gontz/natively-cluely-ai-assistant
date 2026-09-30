/**
 * Auto Answer prefetch slot release (2026-09-30).
 *
 * The engine holds one speculative result. prefetchAutoAnswer refused to start
 * while `speculativeText` was non-null, even after that result had expired and
 * could never be adopted, and a prefetch the judge rejected stayed there until
 * some real dispatch cleared it. The next genuinely answerable question then
 * lost its head start.
 *
 * Pins: an expired leftover no longer blocks a prefetch, and
 * abandonSpeculative(id) frees the slot for the held id only.
 *
 * Ported from rishikeshl0510/natively-cluely-ai-assistant@59c42e8.
 * Same poke-the-instance pattern as AutoAnswerPrefetchReveal2026_09_03.test.mjs.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const enginePath = path.resolve(__dirname, '../../../dist-electron/electron/IntelligenceEngine.js');
const sessionPath = path.resolve(__dirname, '../../../dist-electron/electron/SessionTracker.js');
const require = createRequire(import.meta.url);

const Q1 = 'Why did you choose PostgreSQL over the alternatives for this service?';
const Q2 = 'How would you shard the orders table once it outgrows a single box?';
const ANSWER = 'I picked PostgreSQL for the ecosystem and the tooling around it.';

async function makeEngine({ gate = null } = {}) {
    const { IntelligenceEngine } = await import(pathToFileURL(enginePath).href);
    const { SessionTracker } = require(sessionPath);
    const engine = new IntelligenceEngine({ setNegotiationCoachingHandler() {} }, new SessionTracker());
    engine.lastTriggerTime = 0;
    engine.whatToAnswerLLM = {
        async *generateStream() {
            if (gate) await gate;
            yield ANSWER;
        },
    };
    engine.planSuggestionTrigger = async () => ({ kind: 'answer', reason: 'answerable_question', confidence: 0.9 });
    return { engine };
}

function untilIdle(engine) {
    return new Promise((resolve) => {
        if (engine.getActiveMode() === 'idle') return resolve();
        const handler = (mode) => { if (mode === 'idle') { engine.off('mode_changed', handler); resolve(); } };
        engine.on('mode_changed', handler);
    });
}

test('baseline: a live, unadopted prefetch result still holds the slot', async () => {
    const { engine } = await makeEngine();
    engine.prefetchAutoAnswer('q1', Q1);
    await untilIdle(engine);
    engine.prefetchAutoAnswer('q2', Q2);
    assert.equal(engine.getActiveMode(), 'idle', 'an unexpired result keeps throttling a second prefetch');
    assert.equal(engine.getSpeculativeSnapshot().questionId, 'q1');
    engine.reset();
});

test('an EXPIRED leftover result no longer blocks the next prefetch', async () => {
    const { engine } = await makeEngine();
    engine.prefetchAutoAnswer('q1', Q1);
    await untilIdle(engine);
    engine.speculativeTextExpiry = Date.now() - 1;          // the moment has passed
    assert.equal(engine.getSpeculativeSnapshot().questionId, null, 'already unusable for adoption');
    engine.prefetchAutoAnswer('q2', Q2);
    assert.equal(engine.getActiveMode(), 'what_to_say', 'the new prefetch starts');
    await untilIdle(engine);
    assert.equal(engine.getSpeculativeSnapshot().questionId, 'q2');
    engine.reset();
});

test('abandonSpeculative frees the slot for the held id, and the next prefetch starts', async () => {
    const { engine } = await makeEngine();
    engine.prefetchAutoAnswer('q1', Q1);
    await untilIdle(engine);
    engine.abandonSpeculative('q1');
    assert.deepEqual(engine.getSpeculativeSnapshot(), { questionId: null, text: null });
    engine.prefetchAutoAnswer('q2', Q2);
    assert.equal(engine.getActiveMode(), 'what_to_say');
    await untilIdle(engine);
    assert.equal(engine.getSpeculativeSnapshot().questionId, 'q2');
    engine.reset();
});

test('abandonSpeculative for a different id leaves a newer prefetch untouched', async () => {
    const { engine } = await makeEngine();
    engine.prefetchAutoAnswer('q2', Q2);
    await untilIdle(engine);
    engine.abandonSpeculative('q1');                        // a stale rejection arriving late
    assert.equal(engine.getSpeculativeSnapshot().questionId, 'q2', 'the newer candidate still owns the slot');
    engine.reset();
});

test('abandoning a prefetch that is still streaming does not abort it, and it cannot be adopted afterwards', async () => {
    let release;
    const gate = new Promise((r) => { release = r; });
    const { engine } = await makeEngine({ gate });
    engine.prefetchAutoAnswer('q1', Q1);
    assert.equal(engine.getActiveMode(), 'what_to_say');
    engine.abandonSpeculative('q1');
    assert.equal(engine.getActiveMode(), 'what_to_say', 'the stream keeps running (busy, not aborted)');
    assert.deepEqual(engine.getSpeculativeSnapshot(), { questionId: null, text: null });
    release();
    await untilIdle(engine);
    assert.deepEqual(engine.getSpeculativeSnapshot(), { questionId: null, text: null }, 'completion does not re-arm the slot');
    engine.prefetchAutoAnswer('q2', Q2);
    assert.equal(engine.getActiveMode(), 'what_to_say', 'the next prefetch starts right away');
    await untilIdle(engine);
    engine.reset();
});
