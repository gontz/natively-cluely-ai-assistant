// Regression (2026-09-30): the Settings audio test's system-audio probe had no
// "no system audio detected" timeout. When the probe started but never saw a
// sample with signal in it, the System Audio Level meter just sat flat and the
// user could not tell a quiet machine from audio that was not being captured.
//
// Fix: a pure diagnosis module (audioTestSystemSilence.mjs) plus wiring in
// AppState._startAudioTestImpl that arms a ~12s timer when the probe starts,
// clears it on the first signal-bearing chunk, on a probe error and in
// stopAudioTest, and otherwise sends a platform-appropriate message on the
// existing `audio-test-system-error` channel.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  AUDIO_TEST_NO_SYSTEM_AUDIO_MS,
  AUDIO_TEST_SIGNAL_PEAK_TO_PEAK,
  chunkHasSystemAudioSignal,
  describeNoSystemAudioInTest,
} from '../audioTestSystemSilence.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '../../..');
const mainSrc = fs.readFileSync(path.join(root, 'electron/main.ts'), 'utf8');
const overlaySrc = fs.readFileSync(path.join(root, 'src/components/SettingsOverlay.tsx'), 'utf8');

function pcm(samples) {
  const buf = Buffer.alloc(samples.length * 2);
  samples.forEach((v, i) => buf.writeInt16LE(v, i * 2));
  return buf;
}

// A slow sine so the classifier's strided sampling still sees the full swing.
function sine(n, amplitude) {
  return pcm(Array.from({ length: n }, (_, i) => Math.round(amplitude * Math.sin((2 * Math.PI * i) / 37))));
}

const MAC_HINT = /Privacy & Security|Screen Recording/;
const WINDOWS_HINT = /Windows/;

describe('audio test no-system-audio diagnosis: pure logic', () => {
  it('uses a ~12s window and the meeting classifier signal floor', () => {
    assert.equal(AUDIO_TEST_NO_SYSTEM_AUDIO_MS, 12_000);
    assert.equal(AUDIO_TEST_SIGNAL_PEAK_TO_PEAK, 100);
  });

  it('zero-filled and near-silent chunks carry no signal; real audio does', () => {
    assert.equal(chunkHasSystemAudioSignal(Buffer.alloc(3200)), false);
    assert.equal(chunkHasSystemAudioSignal(sine(1600, 20)), false);
    assert.equal(chunkHasSystemAudioSignal(sine(1600, 4000)), true);
    assert.equal(chunkHasSystemAudioSignal(Buffer.alloc(0)), false);
    assert.equal(chunkHasSystemAudioSignal(null), false);
  });

  it('darwin: macOS guidance only, never Windows advice', () => {
    for (const probeOutputId of [undefined, 'BuiltInSpeakerDevice']) {
      const msg = describeNoSystemAudioInTest({ platform: 'darwin', probeOutputId, defaultOutputId: 'other' });
      assert.match(msg, /No system audio detected/);
      assert.match(msg, MAC_HINT);
      assert.doesNotMatch(msg, WINDOWS_HINT);
    }
  });

  it('win32 with a selected output that differs from the Windows default: points at the selected device and the mismatch', () => {
    const msg = describeNoSystemAudioInTest({
      platform: 'win32',
      probeOutputId: '{0.0.0.00000000}.{AAA}',
      defaultOutputId: '{0.0.0.00000000}.{BBB}',
    });
    assert.match(msg, /selected output device/);
    assert.match(msg, /different default device/);
    assert.doesNotMatch(msg, MAC_HINT);
  });

  it('win32 with a selected output equal to the default (case-insensitive) or unknown default: no mismatch claim', () => {
    for (const defaultOutputId of ['{0.0.0.00000000}.{aaa}', undefined, null, '']) {
      const msg = describeNoSystemAudioInTest({ platform: 'win32', probeOutputId: '{0.0.0.00000000}.{AAA}', defaultOutputId });
      assert.match(msg, /selected output device/);
      assert.doesNotMatch(msg, /different default device/);
      assert.doesNotMatch(msg, MAC_HINT);
    }
  });

  it('win32 on the default route: names the Windows default output', () => {
    const msg = describeNoSystemAudioInTest({ platform: 'win32', probeOutputId: undefined, defaultOutputId: 'x' });
    assert.match(msg, /Windows default output/);
    assert.doesNotMatch(msg, MAC_HINT);
  });

  it('unknown platform: generic copy with neither platform\'s advice', () => {
    const msg = describeNoSystemAudioInTest({ platform: 'linux' });
    assert.match(msg, /No system audio detected/);
    assert.doesNotMatch(msg, MAC_HINT);
    assert.doesNotMatch(msg, WINDOWS_HINT);
  });
});

describe('audio test no-system-audio diagnosis: wiring', () => {
  const start = mainSrc.indexOf('private async _startAudioTestImpl(');
  const stop = mainSrc.indexOf('public stopAudioTest(): void {');
  const startBody = mainSrc.slice(start, stop);
  const stopBody = mainSrc.slice(stop, stop + 3000);

  it('arms the timer only after the probe started for the current test', () => {
    assert.ok(start !== -1 && stop > start);
    assert.match(startBody, /setTimeout\([\s\S]*?AUDIO_TEST_NO_SYSTEM_AUDIO_MS\)/);
    assert.match(
      startBody,
      /this\.audioTestSystemCapture\.start\(\);\s*if \(!isCurrentTest\(\)\) \{[\s\S]*?\} else \{\s*armNoSystemAudioDiagnosis\(this\.audioTestSystemCapture\);/,
    );
    assert.match(startBody, /if \(!isCurrentTest\(\) \|\| this\.audioTestSystemCapture !== capture\) return;/);
  });

  it('reports through the existing audio-test-system-error channel with platform-injected copy', () => {
    assert.match(startBody, /describeNoSystemAudioInTest\(\{\s*platform: process\.platform,/);
    assert.match(startBody, /'audio-test-system-error', message\)/);
    // The Windows default-output lookup is gated to win32.
    assert.match(startBody, /process\.platform === 'win32' && probeOutputId/);
  });

  it('clears on first signal, on a probe error, and on stopAudioTest', () => {
    assert.match(startBody, /chunkHasSystemAudioSignal\(chunk\)\) \{\s*this\.clearAudioTestNoSystemAudioTimer\(\);/);
    assert.match(startBody, /capture\.on\('error'[\s\S]*?this\.clearAudioTestNoSystemAudioTimer\(\);/);
    assert.match(stopBody, /this\.clearAudioTestNoSystemAudioTimer\(\);/);
  });

  it('renderer keeps the notice until the bar visibly moves', () => {
    assert.match(overlaySrc, /onAudioTestSystemLevel\?\.\(\(level\) => \{[\s\S]*?if \(level >= 0\.01\) setSystemAudioError\(null\);/);
  });
});
