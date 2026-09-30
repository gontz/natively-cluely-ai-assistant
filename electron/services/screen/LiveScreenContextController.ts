// electron/services/screen/LiveScreenContextController.ts
//
// Live screen context: while a live session runs, describe the screen on a
// timer so automatic answers can use it as text context without paying for a
// capture on their own critical path; optionally auto-answer a question that
// only appears on screen.
//
// Ported from rishikeshl0510/natively-cluely-ai-assistant (0a4b3de, b2f0960,
// d61a740; spec docs/specs/live-screen-context-spec.md on that fork). The fork
// kept all of this inline in AppState. Here the timing, freshness and gating
// logic is a standalone class with an injected clock and host so it can be
// tested, and main.ts only supplies the capture/describe/dispatch hooks.
//
// Pure: no Electron, no I/O. Everything platform-specific (the capture itself,
// the macOS Screen Recording check inside ScreenshotHelper) lives behind the
// host.

import type { ScreenUnderstandingResult } from './ScreenUnderstandingService';
import { tokenContainment } from '../../intelligence/autoAnswer/AutoAnswerText';

/** Fork default was 10s. Ours is a little longer: every tick can be a vision call. */
export const LIVE_SCREEN_CONTEXT_DEFAULT_INTERVAL_MS = 15_000;
export const LIVE_SCREEN_CONTEXT_MIN_INTERVAL_MS = 10_000;
export const LIVE_SCREEN_CONTEXT_MAX_INTERVAL_MS = 120_000;
/** How long an answer waits for a capture that is already running (spec tier 2). */
export const LIVE_SCREEN_CONTEXT_INFLIGHT_WAIT_MS = 700;
/** Oldest description an answer still uses (spec tier 3), floor. */
export const LIVE_SCREEN_CONTEXT_STALE_CEILING_MS = 45_000;
/** Background describe budget; nothing waits on it (see totalDeadlineMsOverride). */
export const LIVE_SCREEN_CONTEXT_DESCRIBE_DEADLINE_MS = 30_000;

export interface LiveScreenContextSettings {
  /** Periodic capture + description. Off unless explicitly true. */
  enabled: boolean;
  /** Auto-answer questions seen on screen. Off unless explicitly true, and only with `enabled`. */
  screenOnlyAutoAnswer: boolean;
  intervalMs: number;
}

export interface RawLiveScreenContextSettings {
  liveScreenContextEnabled?: unknown;
  screenOnlyAutoAnswerEnabled?: unknown;
  liveScreenContextIntervalMs?: unknown;
}

export function clampLiveScreenContextInterval(value: unknown): number {
  const n = typeof value === 'number' ? value : Number.NaN;
  if (!Number.isFinite(n)) return LIVE_SCREEN_CONTEXT_DEFAULT_INTERVAL_MS;
  return Math.min(LIVE_SCREEN_CONTEXT_MAX_INTERVAL_MS, Math.max(LIVE_SCREEN_CONTEXT_MIN_INTERVAL_MS, Math.round(n)));
}

/** Settings as stored → settings as used. Unset, or anything but `true`, is off. */
export function resolveLiveScreenContextSettings(raw: RawLiveScreenContextSettings | null | undefined): LiveScreenContextSettings {
  const enabled = raw?.liveScreenContextEnabled === true;
  return {
    enabled,
    screenOnlyAutoAnswer: enabled && raw?.screenOnlyAutoAnswerEnabled === true,
    intervalMs: clampLiveScreenContextInterval(raw?.liveScreenContextIntervalMs),
  };
}

// ─── Screen-only auto-answer gate ─────────────────────────────────────────

export interface ScreenOnlyAutoAnswerEnv {
  autoAnswerEnabled: boolean;
  sessionActive: boolean;
  engineAccepting: boolean;
  answerStreaming: boolean;
  /** Interviewer speech the auto-answer engine has not resolved yet. */
  interviewerSpeechPending: boolean;
}

export type ScreenOnlyDecision =
  | { fire: true; text: string }
  | { fire: false; reason: string };

/** Word-overlap similarity above which a new capture counts as the question already answered. */
export const SCREEN_ONLY_DEDUP_SIMILARITY = 0.75;
const MAX_RECENT_SCREEN_TEXTS = 4;

/**
 * Decides whether a fresh screen description should trigger an automatic
 * answer with nobody speaking. The classification itself is the vision
 * model's (`hasUnansweredQuestion`, same call that transcribed the screen);
 * this only adds the state the model cannot see: is auto-answer allowed right
 * now, is the interviewer mid-question, and has this question already been
 * answered from an earlier capture.
 *
 * Keeps a few recent distinct captures so a long question read by scrolling
 * over several ticks is answered from all of it, oldest first.
 */
export class ScreenOnlyAutoAnswerGate {
  private lastTriggeredText: string | null = null;
  private recentTexts: string[] = [];

  reset(): void {
    this.lastTriggeredText = null;
    this.recentTexts = [];
  }

  evaluate(result: ScreenUnderstandingResult | null | undefined, env: ScreenOnlyAutoAnswerEnv): ScreenOnlyDecision {
    if (!env.autoAnswerEnabled) return { fire: false, reason: 'auto_answer_off' };
    if (!env.sessionActive) return { fire: false, reason: 'no_session' };
    if (!env.engineAccepting) return { fire: false, reason: 'engine_busy' };
    if (env.answerStreaming) return { fire: false, reason: 'answer_streaming' };
    // A spoken question already gets this screen context attached when it
    // resolves; answering the screen alone now would race it.
    if (env.interviewerSpeechPending) return { fire: false, reason: 'interviewer_speaking' };
    if (!result || result.status !== 'available') return { fire: false, reason: 'no_screen_context' };
    const text = (result.extractedText || result.visibleSummary || '').trim();
    if (!text) return { fire: false, reason: 'no_text' };

    if (this.recentTexts[this.recentTexts.length - 1] !== text) {
      this.recentTexts.push(text);
      if (this.recentTexts.length > MAX_RECENT_SCREEN_TEXTS) this.recentTexts.shift();
    }

    // Similarity, not equality: OCR noise and a ticking URL or clock make the
    // same page read slightly differently on every capture.
    if (this.lastTriggeredText) {
      const similarity = Math.min(tokenContainment(text, this.lastTriggeredText), tokenContainment(this.lastTriggeredText, text));
      if (similarity >= SCREEN_ONLY_DEDUP_SIMILARITY) {
        // Still the answered question: it must not leak into the next one's merge.
        this.recentTexts = [];
        return { fire: false, reason: 'already_answered' };
      }
    }

    if (result.hasUnansweredQuestion !== true) return { fire: false, reason: 'no_question_on_screen' };

    const combined = this.recentTexts.join('\n---\n');
    this.lastTriggeredText = text;
    this.recentTexts = [];
    return { fire: true, text: combined };
  }
}

// ─── Controller ───────────────────────────────────────────────────────────

export interface LiveScreenContextClock {
  now(): number;
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
}

export const systemLiveScreenContextClock: LiveScreenContextClock = {
  now: () => Date.now(),
  setTimeout: (fn, ms) => setTimeout(fn, ms),
  clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

export interface LiveScreenContextHost {
  settings(): LiveScreenContextSettings;
  /** A live session (meeting) is running. Nothing is captured outside one. */
  sessionActive(): boolean;
  /**
   * Privacy and window gates, re-checked before every capture: the
   * screenshots data scope, and whatever window state the capture needs.
   */
  captureAllowed(): { ok: true } | { ok: false; reason: string };
  /** Capture the screen through the app's normal capture path. Returns an image path. */
  capture(): Promise<string>;
  describe(imagePath: string): Promise<ScreenUnderstandingResult>;
  /** A new description is available (UI hint only). */
  onDescribed?(result: ScreenUnderstandingResult): void;
  screenOnlyEnv?(): ScreenOnlyAutoAnswerEnv;
  dispatchScreenQuestion?(text: string, result: ScreenUnderstandingResult): Promise<unknown> | void;
  log?(line: string): void;
}

/** Errors from the capture path that will not clear up by retrying on a timer. */
export function isScreenPermissionError(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err ?? '');
  return /permission|screen recording|restricted by a device policy/i.test(msg);
}

export class LiveScreenContextController {
  private latest: ScreenUnderstandingResult | null = null;
  /** When `latest` was produced by us. A cache hit keeps the old result's capturedAt. */
  private latestAt = 0;
  private inFlight: Promise<void> | null = null;
  private timer: unknown = null;
  private running = false;
  private generation = 0;
  private permissionBlocked = false;
  private readonly gate = new ScreenOnlyAutoAnswerGate();

  constructor(
    private readonly host: LiveScreenContextHost,
    private readonly clock: LiveScreenContextClock = systemLiveScreenContextClock,
  ) {}

  isRunning(): boolean { return this.running; }
  isCaptureInFlight(): boolean { return this.inFlight !== null; }

  /** Session start. No-op unless the feature is enabled. */
  start(): void {
    this.stop();
    this.permissionBlocked = false;
    this.startIfEnabled();
  }

  /** Session end, app quit, or the feature turned off. Safe to call repeatedly. */
  stop(): void {
    this.generation++;
    if (this.timer !== null) this.clock.clearTimeout(this.timer);
    this.timer = null;
    this.running = false;
    this.latest = null;
    this.latestAt = 0;
    this.gate.reset();
  }

  /** Settings changed: follow the toggle and interval without waiting for a tick. */
  settingsChanged(): void {
    const s = this.host.settings();
    if (!s.enabled) {
      if (this.running) this.host.log?.('[LiveScreenContext] disabled in settings, stopping');
      this.stop();
      return;
    }
    if (!this.running) {
      this.startIfEnabled();
      return;
    }
    // Re-arm on the new interval.
    if (this.timer !== null) this.clock.clearTimeout(this.timer);
    this.timer = null;
    this.schedule(s.intervalMs);
  }

  private startIfEnabled(): void {
    const s = this.host.settings();
    if (!s.enabled || !this.host.sessionActive() || this.permissionBlocked) return;
    this.running = true;
    this.host.log?.(`[LiveScreenContext] started, every ${s.intervalMs}ms`);
    void this.refresh();
    this.schedule(s.intervalMs);
  }

  private schedule(ms: number): void {
    const gen = this.generation;
    this.timer = this.clock.setTimeout(() => {
      this.timer = null;
      if (gen !== this.generation) return;
      this.tick();
    }, ms);
  }

  private tick(): void {
    const s = this.host.settings();
    if (!s.enabled || !this.host.sessionActive()) {
      this.stop();
      return;
    }
    if (this.inFlight) {
      // Never overlap: the previous capture/describe is still running.
      this.host.log?.('[LiveScreenContext] tick skipped, previous capture still running');
    } else {
      void this.refresh();
    }
    if (this.running && !this.permissionBlocked) this.schedule(s.intervalMs);
  }

  /**
   * Capture and describe now, unless a capture is already running (joined) or
   * the last description is still inside the interval. Fire-and-forget safe:
   * never rejects.
   */
  refresh(): Promise<void> {
    if (this.inFlight) return this.inFlight;
    const s = this.host.settings();
    if (!s.enabled || !this.host.sessionActive() || this.permissionBlocked) return Promise.resolve();
    if (this.latest && this.clock.now() - this.latestAt < s.intervalMs) return Promise.resolve();
    const allowed = this.host.captureAllowed();
    if (!allowed.ok) {
      this.host.log?.(`[LiveScreenContext] capture skipped: ${allowed.reason}`);
      return Promise.resolve();
    }
    const gen = this.generation;
    const run = this.runOnce(gen, s).finally(() => {
      if (this.inFlight === run) this.inFlight = null;
    });
    this.inFlight = run;
    return run;
  }

  private async runOnce(gen: number, s: LiveScreenContextSettings): Promise<void> {
    let imagePath: string;
    try {
      imagePath = await this.host.capture();
    } catch (err) {
      if (isScreenPermissionError(err)) {
        // Do not retry on a timer: on macOS this is a missing Screen Recording
        // grant, and the fix is the user's, not another capture's.
        this.permissionBlocked = true;
        if (this.timer !== null) this.clock.clearTimeout(this.timer);
        this.timer = null;
        this.running = false;
        this.host.log?.('[LiveScreenContext] screen capture permission unavailable; paused until the next session');
      } else {
        this.host.log?.(`[LiveScreenContext] capture failed (non-fatal): ${err instanceof Error ? err.message : String(err)}`);
      }
      return;
    }
    if (gen !== this.generation) return;
    let result: ScreenUnderstandingResult;
    try {
      result = await this.host.describe(imagePath);
    } catch (err) {
      this.host.log?.(`[LiveScreenContext] describe failed (non-fatal): ${err instanceof Error ? err.message : String(err)}`);
      return;
    }
    // Session ended or the feature was turned off while describing: drop it.
    if (gen !== this.generation) return;
    if (!result || result.status !== 'available') {
      this.host.log?.(`[LiveScreenContext] no description (${result?.status ?? 'none'}${result?.failureReason ? `: ${result.failureReason}` : ''})`);
      return;
    }
    this.latest = result;
    this.latestAt = this.clock.now();
    try { this.host.onDescribed?.(result); } catch { /* UI hint only */ }

    if (!s.screenOnlyAutoAnswer || !this.host.screenOnlyEnv || !this.host.dispatchScreenQuestion) return;
    // Re-read: the toggle may have changed while the vision call ran.
    if (!this.host.settings().screenOnlyAutoAnswer) return;
    const decision = this.gate.evaluate(result, this.host.screenOnlyEnv());
    if (!decision.fire) {
      this.host.log?.(`[LiveScreenContext] screen-only answer: skipped (${decision.reason})`);
      return;
    }
    this.host.log?.(`[LiveScreenContext] screen-only answer: firing (${decision.text.length} chars)`);
    try {
      await this.host.dispatchScreenQuestion(decision.text, result);
    } catch (err) {
      this.host.log?.(`[LiveScreenContext] screen-only answer failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  /**
   * Screen context for an answer about to be generated (spec's tiered policy):
   * fresh → use it; capture running → wait at most INFLIGHT_WAIT_MS; stale but
   * recent → use it; otherwise none (never a synchronous capture here).
   */
  async resolveForAnswer(): Promise<ScreenUnderstandingResult | undefined> {
    const s = this.host.settings();
    if (!s.enabled || !this.running) return undefined;
    const fresh = () => this.latest && this.clock.now() - this.latestAt < s.intervalMs ? this.latest : null;
    const f1 = fresh();
    if (f1) return f1;
    if (this.inFlight) {
      let handle: unknown = null;
      await Promise.race([
        this.inFlight,
        new Promise<void>((resolve) => { handle = this.clock.setTimeout(resolve, LIVE_SCREEN_CONTEXT_INFLIGHT_WAIT_MS); }),
      ]);
      if (handle !== null) this.clock.clearTimeout(handle);
      const f2 = fresh();
      if (f2) return f2;
    }
    const ceiling = Math.max(LIVE_SCREEN_CONTEXT_STALE_CEILING_MS, s.intervalMs * 3);
    if (this.latest && this.clock.now() - this.latestAt < ceiling) return this.latest;
    return undefined;
  }
}
