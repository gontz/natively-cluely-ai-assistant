/**
 * Pure logic for the Settings audio test's "no system audio" diagnosis.
 *
 * The system-audio probe in AppState._startAudioTestImpl can start cleanly and
 * still never deliver a sample with any signal in it: nothing is playing, the
 * meeting app plays through a different output, or (macOS) the Screen
 * Recording grant is zero-filling the tap. Without a diagnosis the meter just
 * sits flat and the user cannot tell "quiet" from "not captured".
 *
 * Authored as .mjs + .d.mts (same pattern as systemAudioHealthClassifier.mjs)
 * so node:test exercises the real implementation.
 *
 * CROSS-PLATFORM: the platform is a parameter, never read from process.
 * macOS copy talks about the CoreAudio tap / Screen Recording; Windows copy
 * talks about the selected WASAPI output endpoint. Neither leaks into the
 * other (CLAUDE.md: platform-specific instructions stay on their platform).
 */

import { peakToPeakInt16LE } from './systemAudioHealthClassifier.mjs';

/** How long the probe may run without a single signal-bearing chunk. */
export const AUDIO_TEST_NO_SYSTEM_AUDIO_MS = 12_000;

/**
 * Same "meaningful signal" floor the meeting-side health classifier uses, so
 * the test and the meeting agree on what counts as audio.
 */
export const AUDIO_TEST_SIGNAL_PEAK_TO_PEAK = 100;

export function chunkHasSystemAudioSignal(chunk, threshold = AUDIO_TEST_SIGNAL_PEAK_TO_PEAK) {
  return peakToPeakInt16LE(chunk) > threshold;
}

function sameOutputId(a, b) {
  return typeof a === 'string' && typeof b === 'string' && a.toLowerCase() === b.toLowerCase();
}

/**
 * @param {{ platform: string, probeOutputId?: string | null, defaultOutputId?: string | null }} input
 * @returns {string}
 */
export function describeNoSystemAudioInTest({ platform, probeOutputId, defaultOutputId }) {
  if (platform === 'darwin') {
    return 'No system audio detected. Play something through your speakers or headphones. If the meter stays flat, check Natively is enabled under Privacy & Security → Screen Recording.';
  }
  if (platform === 'win32') {
    if (!probeOutputId) {
      return 'No system audio detected on the Windows default output. Play something, or pick the device your meeting app plays through under Output Device.';
    }
    if (defaultOutputId && !sameOutputId(probeOutputId, defaultOutputId)) {
      return 'No system audio detected on the selected output device. Windows is sending sound to a different default device, so play audio through the selected one or pick the device your meeting app uses.';
    }
    return 'No system audio detected on the selected output device. Play something through it, or pick the device your meeting app plays through.';
  }
  return 'No system audio detected. Play something through your speakers, then try again.';
}
