// electron/services/screen/visionProviderOrder.ts
//
// Pure reordering of an already-built vision provider list. Kept out of
// VisionProviderRegistry so it can be unit-tested without CredentialsManager
// (which needs the Electron app at module load).

import type { VisionProviderConfig } from './VisionProviderFallbackChain';

/**
 * Gemini rungs first (in their existing relative order), then every other
 * rung in its existing order. Nothing is added or dropped: the input already
 * went through buildVisionProviders, so private_vision and the screenshots
 * data scope have been applied and still hold here.
 *
 * Ported from the live-screen-context work in rishikeshl0510's fork, where a
 * Gemini-ONLY list failed every capture when all three Gemini rungs timed out
 * with other configured providers sitting unused. Gemini-first keeps the
 * preference and restores the fallback.
 */
export function orderVisionProvidersGeminiFirst(providers: readonly VisionProviderConfig[]): VisionProviderConfig[] {
  const isGemini = (p: VisionProviderConfig) => p.hint === 'gemini' || p.id.startsWith('gemini');
  return [...providers.filter(isGemini), ...providers.filter(p => !isGemini(p))];
}
