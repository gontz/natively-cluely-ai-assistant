export const SELECTED_OUTPUT_SILENCE_FALLBACK_MS: number;

export type SelectedOutputSilenceFallbackDecision =
  | { fallback: true; defaultOutputId: string }
  | {
      fallback: false;
      reason:
        | 'platform-not-supported'
        | 'no-selected-output'
        | 'default-output-unknown'
        | 'selected-is-default'
        | 'selected-output-had-signal'
        | 'silence-too-short';
    };

export function decideSelectedOutputSilenceFallback(input: {
  platform: NodeJS.Platform | string;
  selectedOutputId?: string | null;
  defaultOutputId?: string | null;
  silentForMs: number;
  hadSignal?: boolean;
  thresholdMs?: number;
}): SelectedOutputSilenceFallbackDecision;
