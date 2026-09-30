/**
 * Pure decision: should a live meeting stop capturing the user-SELECTED output
 * and fall back to the platform default output because the selected one has
 * delivered no audio at all?
 *
 * Why this exists (Windows): WASAPI loopback is per-endpoint. If the user
 * picked "Headset" in Settings but the meeting app actually plays through the
 * Windows default ("Speakers"), loopback on Headset receives nothing and the
 * interviewer transcript stays empty for the whole meeting. The default-output
 * watcher deliberately ignores users who picked a specific output, and the
 * stuck watchdog only logs, so nothing recovered this case.
 *
 * Why NOT macOS: the CoreAudio process tap is bound by UID and the existing
 * macOS recovery (route-change watcher, SCK re-probe, Screen Recording
 * revocation diagnosis) owns that pipeline; its silence usually means a
 * permission or same-device problem that switching devices would not fix.
 * The decision is therefore a no-op off win32.
 *
 * Deliberately conservative: it only fires when the selected output has NEVER
 * carried signal since this capture started. A selected output that worked
 * and then went quiet is a conversational pause (the user answering, a lull),
 * not a routing error, and switching away from it would lose the interviewer.
 *
 * Authored as .mjs + .d.mts (same pattern as systemAudioHealthClassifier.mjs)
 * so node:test exercises the real implementation. The platform is always a
 * parameter; never read process.platform here.
 */

/** Sustained silence (no signal since capture start) before falling back. */
export const SELECTED_OUTPUT_SILENCE_FALLBACK_MS = 30_000;

function sameOutputId(a, b) {
  return a.toLowerCase() === b.toLowerCase();
}

/**
 * @param {{
 *   platform: string,
 *   selectedOutputId?: string | null,
 *   defaultOutputId?: string | null,
 *   silentForMs: number,
 *   hadSignal?: boolean,
 *   thresholdMs?: number,
 * }} input
 * @returns {{ fallback: true, defaultOutputId: string } | { fallback: false, reason: string }}
 */
export function decideSelectedOutputSilenceFallback({
  platform,
  selectedOutputId,
  defaultOutputId,
  silentForMs,
  hadSignal = false,
  thresholdMs = SELECTED_OUTPUT_SILENCE_FALLBACK_MS,
}) {
  if (platform !== 'win32') return { fallback: false, reason: 'platform-not-supported' };
  if (!selectedOutputId) return { fallback: false, reason: 'no-selected-output' };
  if (!defaultOutputId) return { fallback: false, reason: 'default-output-unknown' };
  if (sameOutputId(selectedOutputId, defaultOutputId)) return { fallback: false, reason: 'selected-is-default' };
  if (hadSignal) return { fallback: false, reason: 'selected-output-had-signal' };
  if (!Number.isFinite(silentForMs) || silentForMs < thresholdMs) {
    return { fallback: false, reason: 'silence-too-short' };
  }
  return { fallback: true, defaultOutputId };
}
