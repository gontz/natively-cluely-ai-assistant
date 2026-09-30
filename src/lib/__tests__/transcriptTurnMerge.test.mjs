import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import {
  mergeTranscriptTurns,
  joinFragmentText,
  TRANSCRIPT_TURN_GAP_MS,
} from '../transcriptTurnMerge.mjs';

const T0 = 1_780_000_000_000;

describe('mergeTranscriptTurns', () => {
  test('folds consecutive same-speaker fragments into one turn with the first timestamp', () => {
    const out = mergeTranscriptTurns([
      { speaker: 'interviewer', text: 'So tell me', timestamp: T0 },
      { speaker: 'interviewer', text: 'about your last', timestamp: T0 + 1200 },
      { speaker: 'interviewer', text: 'project.', timestamp: T0 + 2500 },
    ]);
    assert.equal(out.length, 1);
    assert.equal(out[0].text, 'So tell me about your last project.');
    assert.equal(out[0].timestamp, T0);
    assert.equal(out[0].endTimestamp, T0 + 2500);
    assert.equal(out[0].fragmentCount, 3);
  });

  test('a speaker change starts a new turn', () => {
    const out = mergeTranscriptTurns([
      { speaker: 'interviewer', text: 'Ready?', timestamp: T0 },
      { speaker: 'user', text: 'Yes.', timestamp: T0 + 500 },
      { speaker: 'interviewer', text: 'Great.', timestamp: T0 + 900 },
    ]);
    assert.deepEqual(out.map(t => t.text), ['Ready?', 'Yes.', 'Great.']);
  });

  test('a pause longer than the gap starts a new turn, measured from the previous fragment', () => {
    const out = mergeTranscriptTurns([
      { speaker: 'user', text: 'one', timestamp: T0 },
      { speaker: 'user', text: 'two', timestamp: T0 + TRANSCRIPT_TURN_GAP_MS },
      { speaker: 'user', text: 'three', timestamp: T0 + 2 * TRANSCRIPT_TURN_GAP_MS },
      { speaker: 'user', text: 'four', timestamp: T0 + 3 * TRANSCRIPT_TURN_GAP_MS + 1 },
    ]);
    assert.deepEqual(out.map(t => t.text), ['one two three', 'four']);
  });

  test('never merges when a timestamp is missing or goes backwards', () => {
    const out = mergeTranscriptTurns([
      { speaker: 'user', text: 'a', timestamp: 0 },
      { speaker: 'user', text: 'b', timestamp: 0 },
      { speaker: 'user', text: 'c', timestamp: T0 },
      { speaker: 'user', text: 'd', timestamp: T0 - 10 },
    ]);
    assert.equal(out.length, 4);
  });

  test('caps turn length so long speech still breaks into paragraphs', () => {
    const out = mergeTranscriptTurns([
      { speaker: 'user', text: 'x'.repeat(8), timestamp: T0 },
      { speaker: 'user', text: 'y'.repeat(8), timestamp: T0 + 100 },
      { speaker: 'user', text: 'z'.repeat(8), timestamp: T0 + 200 },
    ], { maxChars: 17 });
    assert.deepEqual(out.map(t => t.text), ['xxxxxxxx yyyyyyyy', 'zzzzzzzz']);
  });

  test('speaker match ignores case and surrounding space; empty text is skipped', () => {
    const out = mergeTranscriptTurns([
      { speaker: 'Interviewer', text: 'Hello', timestamp: T0 },
      { speaker: 'interviewer ', text: '   ', timestamp: T0 + 100 },
      { speaker: 'interviewer', text: 'there', timestamp: T0 + 200 },
    ]);
    assert.equal(out.length, 1);
    assert.equal(out[0].text, 'Hello there');
    assert.equal(out[0].speaker, 'Interviewer');
  });

  test('does not mutate the input and tolerates null input', () => {
    const input = [
      { speaker: 'user', text: 'a', timestamp: T0 },
      { speaker: 'user', text: 'b', timestamp: T0 + 1 },
    ];
    const snapshot = JSON.stringify(input);
    mergeTranscriptTurns(input);
    assert.equal(JSON.stringify(input), snapshot);
    assert.deepEqual(mergeTranscriptTurns(null), []);
    assert.deepEqual(mergeTranscriptTurns(undefined), []);
  });
});

describe('joinFragmentText', () => {
  test('adds one space between words and none before closing punctuation', () => {
    assert.equal(joinFragmentText('Hello ', ' world'), 'Hello world');
    assert.equal(joinFragmentText('Hello', ', world'), 'Hello, world');
    assert.equal(joinFragmentText('Done', '.'), 'Done.');
    assert.equal(joinFragmentText('', 'b'), 'b');
    assert.equal(joinFragmentText('a', ''), 'a');
  });
});
