// Regression (2026-09-30): on Windows, a user who picked a specific output in
// Settings while their meeting app played through a DIFFERENT Windows default
// endpoint got an empty interviewer transcript for the whole meeting. WASAPI
// loopback on the selected endpoint hears nothing; the default-output watcher
// returned early because an output was selected, and the stuck watchdog only
// logs. Nothing recovered.
//
// Fix: a pure, platform-injected decision (selectedOutputSilenceFallback.mjs)
// evaluated from the default-output watcher tick. On win32 only, after a
// sustained stretch in which the selected output never carried signal while
// the Windows default is another endpoint, the live capture is rebuilt on the
// default output, logged, and announced via device-selection-applied.
// macOS behaviour is unchanged: the decision is a no-op on darwin.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  SELECTED_OUTPUT_SILENCE_FALLBACK_MS,
  decideSelectedOutputSilenceFallback,
} from '../selectedOutputSilenceFallback.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '../../..');
const mainSrc = fs.readFileSync(path.join(root, 'electron/main.ts'), 'utf8');

const SELECTED = '{0.0.0.00000000}.{11111111-aaaa}';
const DEFAULT = '{0.0.0.00000000}.{22222222-bbbb}';
const LONG = SELECTED_OUTPUT_SILENCE_FALLBACK_MS + 1;

describe('decideSelectedOutputSilenceFallback: win32', () => {
  it('falls back when the selected output never carried signal for the full window and the default differs', () => {
    assert.deepEqual(
      decideSelectedOutputSilenceFallback({ platform: 'win32', selectedOutputId: SELECTED, defaultOutputId: DEFAULT, silentForMs: LONG }),
      { fallback: true, defaultOutputId: DEFAULT },
    );
    assert.equal(
      decideSelectedOutputSilenceFallback({ platform: 'win32', selectedOutputId: SELECTED, defaultOutputId: DEFAULT, silentForMs: SELECTED_OUTPUT_SILENCE_FALLBACK_MS }).fallback,
      true,
      'the threshold is inclusive',
    );
  });

  it('waits until the silence is sustained', () => {
    const d = decideSelectedOutputSilenceFallback({ platform: 'win32', selectedOutputId: SELECTED, defaultOutputId: DEFAULT, silentForMs: SELECTED_OUTPUT_SILENCE_FALLBACK_MS - 1 });
    assert.deepEqual(d, { fallback: false, reason: 'silence-too-short' });
    assert.equal(decideSelectedOutputSilenceFallback({ platform: 'win32', selectedOutputId: SELECTED, defaultOutputId: DEFAULT, silentForMs: Number.NaN }).fallback, false);
  });

  it('honours a custom threshold', () => {
    assert.equal(decideSelectedOutputSilenceFallback({ platform: 'win32', selectedOutputId: SELECTED, defaultOutputId: DEFAULT, silentForMs: 5_000, thresholdMs: 4_000 }).fallback, true);
  });

  it('never abandons a selected output that has already delivered audio (a pause is not a routing error)', () => {
    assert.deepEqual(
      decideSelectedOutputSilenceFallback({ platform: 'win32', selectedOutputId: SELECTED, defaultOutputId: DEFAULT, silentForMs: LONG * 10, hadSignal: true }),
      { fallback: false, reason: 'selected-output-had-signal' },
    );
  });

  it('does nothing when the selected output IS the Windows default (case-insensitive)', () => {
    assert.deepEqual(
      decideSelectedOutputSilenceFallback({ platform: 'win32', selectedOutputId: SELECTED, defaultOutputId: SELECTED.toUpperCase(), silentForMs: LONG }),
      { fallback: false, reason: 'selected-is-default' },
    );
  });

  it('does nothing without a selection or without a known default', () => {
    for (const selectedOutputId of [undefined, null, '']) {
      assert.deepEqual(
        decideSelectedOutputSilenceFallback({ platform: 'win32', selectedOutputId, defaultOutputId: DEFAULT, silentForMs: LONG }),
        { fallback: false, reason: 'no-selected-output' },
      );
    }
    for (const defaultOutputId of [undefined, null, '']) {
      assert.deepEqual(
        decideSelectedOutputSilenceFallback({ platform: 'win32', selectedOutputId: SELECTED, defaultOutputId, silentForMs: LONG }),
        { fallback: false, reason: 'default-output-unknown' },
      );
    }
  });
});

describe('decideSelectedOutputSilenceFallback: darwin', () => {
  it('never falls back on macOS, even in the exact situation that triggers it on Windows', () => {
    for (const selectedOutputId of [SELECTED, 'BuiltInSpeakerDevice', 'sck']) {
      assert.deepEqual(
        decideSelectedOutputSilenceFallback({ platform: 'darwin', selectedOutputId, defaultOutputId: DEFAULT, silentForMs: LONG * 10 }),
        { fallback: false, reason: 'platform-not-supported' },
      );
    }
  });

  it('other platforms are also a no-op', () => {
    assert.equal(decideSelectedOutputSilenceFallback({ platform: 'linux', selectedOutputId: SELECTED, defaultOutputId: DEFAULT, silentForMs: LONG }).fallback, false);
  });
});

describe('silent-selected-output fallback: main.ts wiring', () => {
  const methodStart = mainSrc.indexOf('private maybeFallBackFromSilentSelectedOutput(');
  const fallbackStart = mainSrc.indexOf('private async fallBackToDefaultOutput(');
  const decideBody = mainSrc.slice(methodStart, fallbackStart);
  const fallbackBody = mainSrc.slice(fallbackStart, mainSrc.indexOf('// Mic-side equivalent of setupAudioRecoveryHandler', fallbackStart));

  it('the watcher tick consults the decision only when an output was selected, then still returns', () => {
    assert.match(
      mainSrc,
      /if \(this\._lastRequestedOutputDeviceId\) \{\s*this\.maybeFallBackFromSilentSelectedOutput\(NativeModule\);\s*return;\s*\}/,
    );
  });

  it('the decision gets the injected platform, both ids, silence duration and signal history', () => {
    assert.ok(methodStart !== -1 && fallbackStart > methodStart);
    assert.match(decideBody, /decideSelectedOutputSilenceFallback\(\{\s*platform: process\.platform,\s*selectedOutputId: this\._lastRequestedOutputDeviceId,\s*defaultOutputId,\s*silentForMs: Date\.now\(\) - watch\.startedAtMs,\s*hadSignal: watch\.hadSignal,/);
    assert.match(decideBody, /watch\.capture !== capture\) return;/);
    assert.match(decideBody, /this\._selectedOutputFallbackGeneration === this\._meetingGeneration\) return;/);
  });

  it('the rebuild shares the route-change mutex, revalidates ownership, switches to the default route and notifies', () => {
    assert.match(fallbackBody, /this\._defaultOutputSwitchInProgress = true;/);
    assert.match(fallbackBody, /finally \{\s*this\._defaultOutputSwitchInProgress = false;/);
    assert.match(fallbackBody, /await expectedCapture\.destroy\(\);[\s\S]*?if \(this\.systemAudioCapture\) \{/);
    assert.match(fallbackBody, /new SystemAudioCapture\(undefined\)/);
    assert.match(fallbackBody, /this\._lastRequestedOutputDeviceId = undefined;/);
    assert.match(fallbackBody, /reason: 'selected-output-silent'/);
    assert.match(fallbackBody, /console\.warn\(/);
  });

  it('signal history is tracked per capture instance in wireSystemCapture', () => {
    assert.match(mainSrc, /this\._systemOutputSignalWatch = \{ capture, startedAtMs: Date\.now\(\), hadSignal: false \};/);
    assert.match(mainSrc, /signalWatch\.capture === capture && !signalWatch\.hadSignal && chunkHasSystemAudioSignal\(chunk\)/);
  });
});
