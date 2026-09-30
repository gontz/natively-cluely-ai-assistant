// Regression (2026-09-30): the Settings audio test built its system-audio probe
// with `new SystemAudioCapture()`, i.e. the DEFAULT output, while a meeting
// captures the user's saved output device. A user whose meeting app plays
// through a non-default device saw a flat system meter in the test even though
// the meeting would work, or a healthy meter for a route the meeting never used.
//
// Contract guarded here:
//   - the renderer forwards the saved output id as an optional 2nd argument,
//   - preload / IPC / AppState thread it through without making it required
//     (older callers that send only the mic id keep the default-output probe),
//   - the probe constructs SystemAudioCapture with the normalized output id.
// Both native backends (macOS CoreAudio tap by UID, Windows WASAPI loopback by
// endpoint id) already fall back to the default output for a stale id, which
// is the same contract the meeting path relies on.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '../../..');
const read = (rel) => fs.readFileSync(path.join(root, rel), 'utf8');

const mainSrc = read('electron/main.ts');
const preloadSrc = read('electron/preload.ts');
const ipcSrc = read('electron/ipcHandlers.ts');
const dtsSrc = read('src/types/electron.d.ts');
const overlaySrc = read('src/components/SettingsOverlay.tsx');

function sliceFrom(src, marker, length = 12000) {
  const idx = src.indexOf(marker);
  assert.notEqual(idx, -1, `marker not found: ${marker}`);
  return src.slice(idx, idx + length);
}

describe('audio test probes the saved output device', () => {
  it('AppState.startAudioTest accepts an optional output id and forwards it', () => {
    assert.match(mainSrc, /public\s+async\s+startAudioTest\s*\(\s*deviceId\?:\s*string,\s*outputDeviceId\?:\s*string\s*\)/);
    assert.match(mainSrc, /this\._startAudioTestImpl\(\s*deviceId,\s*outputDeviceId\s*\)/);
  });

  it('_startAudioTestImpl normalizes the output id and uses it for the system probe', () => {
    const body = sliceFrom(mainSrc, 'private async _startAudioTestImpl(');
    assert.match(body, /_startAudioTestImpl\(\s*deviceId\?:\s*string,\s*outputDeviceId\?:\s*string\s*\)/);
    assert.match(body, /const\s+probeOutputId\s*=\s*this\.normalizeDeviceId\(\s*outputDeviceId\s*\)/);
    assert.match(body, /new\s+SystemAudioCapture\(\s*probeOutputId\s*\)/);
    assert.doesNotMatch(
      body.slice(0, body.indexOf('public stopAudioTest')),
      /new\s+SystemAudioCapture\(\s*\)/,
      'the probe must not fall back to a bare default-output constructor when an output is selected',
    );
  });

  it('IPC handler keeps the second argument optional and type-checks it', () => {
    const handler = sliceFrom(ipcSrc, "safeHandle('start-audio-test'", 600);
    assert.match(handler, /deviceId\?:\s*string,\s*outputDeviceId\?:\s*string/);
    assert.match(handler, /typeof\s+outputDeviceId\s*===\s*'string'\s*\?\s*outputDeviceId\s*:\s*undefined/);
  });

  it('preload and renderer typings expose the optional output argument', () => {
    assert.match(preloadSrc, /startAudioTest:\s*\(deviceId\?:\s*string,\s*outputDeviceId\?:\s*string\)\s*=>\s*Promise</);
    assert.match(preloadSrc, /ipcRenderer\.invoke\('start-audio-test',\s*deviceId,\s*outputDeviceId\)/);
    assert.match(dtsSrc, /startAudioTest:\s*\(deviceId\?:\s*string,\s*outputDeviceId\?:\s*string\)\s*=>\s*Promise</);
  });

  it('SettingsOverlay forwards only the SAVED output preference and restarts on output change', () => {
    const effect = sliceFrom(overlaySrc, "const shouldRun = isOpen && activeTab === 'audio'", 5000);
    assert.match(effect, /localStorage\.getItem\('preferredOutputDeviceId'\)/);
    assert.match(effect, /selectedOutput\s*&&\s*selectedOutput\s*===\s*savedOutput\s*\?\s*selectedOutput\s*:\s*undefined/);
    assert.match(effect, /startAudioTest\(\s*selectedInput,\s*probeOutput\s*\)/);
    assert.match(effect, /\}, \[isOpen, activeTab, selectedInput, selectedOutput\]\);/);
  });
});
