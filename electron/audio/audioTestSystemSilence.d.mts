export const AUDIO_TEST_NO_SYSTEM_AUDIO_MS: number;
export const AUDIO_TEST_SIGNAL_PEAK_TO_PEAK: number;

export function chunkHasSystemAudioSignal(chunk: Buffer, threshold?: number): boolean;

export function describeNoSystemAudioInTest(input: {
  platform: NodeJS.Platform | string;
  probeOutputId?: string | null;
  defaultOutputId?: string | null;
}): string;
