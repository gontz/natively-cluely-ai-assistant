/**
 * Display-only merge of saved transcript fragments into speaker turns
 * (pure, unit-tested).
 *
 * STT providers persist one row per final segment, so a single sentence from
 * one speaker is often stored as several short rows a second or two apart.
 * Meeting details rendered each row as its own entry, which reads as a broken
 * sentence spread over many lines. This folds CONSECUTIVE rows from the same
 * speaker into one entry while the pause between them stays short. The stored
 * transcript is never changed; callers use the result only for rendering.
 *
 * Rules:
 * - Only adjacent rows merge; input order is preserved (no re-sorting).
 * - The gap is measured from the previous row folded into the turn, so a
 *   continuous monologue keeps merging row by row.
 * - A row without a usable timestamp never merges (the gap is unknown).
 * - A turn stops growing at `maxChars` so a long speech still breaks into
 *   readable paragraphs.
 * - The merged entry keeps the FIRST row's timestamp; `endTimestamp` is the
 *   last folded row's timestamp so callers can match a time inside the turn.
 */

export const TRANSCRIPT_TURN_GAP_MS = 4000;
export const TRANSCRIPT_TURN_MAX_CHARS = 1200;

const hasTime = (ts) => typeof ts === 'number' && Number.isFinite(ts) && ts > 0;

const speakerKey = (speaker) => String(speaker ?? '').trim().toLowerCase();

/** Join two text pieces with one space, except before closing punctuation. */
export function joinFragmentText(left, right) {
  const a = String(left ?? '').trim();
  const b = String(right ?? '').trim();
  if (!a) return b;
  if (!b) return a;
  if (/^[,.;:!?%)\]}…]/.test(b)) return a + b;
  return `${a} ${b}`;
}

/**
 * @param {Array<{ speaker: string, text: string, timestamp: number }>} entries
 * @param {{ maxGapMs?: number, maxChars?: number }} [options]
 */
export function mergeTranscriptTurns(entries, options = {}) {
  const maxGapMs = options.maxGapMs ?? TRANSCRIPT_TURN_GAP_MS;
  const maxChars = options.maxChars ?? TRANSCRIPT_TURN_MAX_CHARS;
  const turns = [];
  if (!Array.isArray(entries)) return turns;

  for (const entry of entries) {
    if (!entry) continue;
    const text = String(entry.text ?? '').trim();
    if (!text) continue;
    const prev = turns[turns.length - 1];
    const canMerge = prev !== undefined
      && speakerKey(prev.speaker) === speakerKey(entry.speaker)
      && hasTime(prev.endTimestamp)
      && hasTime(entry.timestamp)
      && entry.timestamp >= prev.endTimestamp
      && entry.timestamp - prev.endTimestamp <= maxGapMs
      && prev.text.length + 1 + text.length <= maxChars;

    if (canMerge) {
      prev.text = joinFragmentText(prev.text, text);
      prev.endTimestamp = entry.timestamp;
      prev.fragmentCount += 1;
    } else {
      turns.push({
        speaker: entry.speaker,
        text,
        timestamp: entry.timestamp,
        endTimestamp: entry.timestamp,
        fragmentCount: 1,
      });
    }
  }
  return turns;
}
