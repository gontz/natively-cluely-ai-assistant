export const TRANSCRIPT_TURN_GAP_MS: number;
export const TRANSCRIPT_TURN_MAX_CHARS: number;

export interface TranscriptFragment {
  speaker: string;
  text: string;
  timestamp: number;
}

export interface MergedTranscriptTurn {
  speaker: string;
  text: string;
  /** Timestamp of the first fragment in the turn. */
  timestamp: number;
  /** Timestamp of the last fragment folded into the turn. */
  endTimestamp: number;
  fragmentCount: number;
}

export function joinFragmentText(left: string, right: string): string;

export function mergeTranscriptTurns(
  entries: ReadonlyArray<TranscriptFragment> | null | undefined,
  options?: { maxGapMs?: number; maxChars?: number },
): MergedTranscriptTurn[];
