import { countEmotes } from "../domain/chatMessage.ts";
import type { ChatMessage } from "../domain/chatMessage.ts";
import type { SpikeDetected, WindowSnapshot } from "../domain/events.ts";
import { EwmaBaseline } from "./ewma.ts";

export interface DetectorConfig {
  /** Length of one evaluation window (ms). */
  readonly windowMs: number;
  /**
   * Calibration windows observed before the detector is armed. Must be >= 1
   * so the EWMA baseline has a seed before it is judged against.
   */
  readonly warmupWindows: number;
  /** EWMA smoothing factor for baseline adaptation. */
  readonly ewmaAlpha: number;
  /** Velocity trigger: fires when window MPS > baseline MPS * velocityThreshold. */
  readonly velocityThreshold: number;
  /** Emote trigger: fires when emotes per message >= emoteDensityThreshold. */
  readonly emoteDensityThreshold: number;
  /** How far back (ms) the 60s-context projection reaches into the ring. */
  readonly contextBackfillMs: number;
}

export const DEFAULT_DETECTOR_CONFIG: Readonly<DetectorConfig> = Object.freeze({
  windowMs: 10_000,
  warmupWindows: 6,
  ewmaAlpha: 0.3,
  velocityThreshold: 3.0,
  emoteDensityThreshold: 2.5,
  contextBackfillMs: 60_000,
});

interface WindowBucket {
  messageCount: number;
  emoteCount: number;
  closed: boolean;
  fired: boolean;
}

export type SpikeListener = (event: SpikeDetected) => void;

/**
 * SpikeDetector — tumbling sliding-window velocity / emote-density engine.
 *
 * Command  : processMessage(msg)
 * Event    : SpikeDetected (once per window, with 60s context projection)
 * Projection: windowSnapshot
 *
 * Design notes (ADR-001):
 *  - Windows are tumbling buckets of `windowMs` aligned to the first message
 *    ever seen (t0). A bucket finalizes when the first message of the *next*
 *    bucket arrives. This makes behavior a pure function of event timestamps:
 *    no timers, no wall clock, fully deterministic in tests.
 *  - The EWMA baseline is judged against the window's MPS *before* that MPS
 *    is folded in — otherwise a burst would contaminate its own baseline and
 *    mask the very trigger it should have caused.
 *  - Adaptation means a *sustained* 4x burst fires on its first window, then
 *    re-arms later as the baseline catches up — desired for a live stream.
 */
export class SpikeDetector {
  readonly #config: DetectorConfig;
  readonly #baseline: EwmaBaseline;
  readonly #onSpike: SpikeListener | null;

  #t0: number | null = null;
  #buckets = new Map<number, WindowBucket>();
  /** Ring of recent messages, pruned to contextBackfillMs. */
  #ring: ChatMessage[] = [];
  #windowsIncorporated = 0;

  constructor(
    config: Partial<DetectorConfig> = {},
    onSpike: SpikeListener | null = null,
  ) {
    this.#config = { ...DEFAULT_DETECTOR_CONFIG, ...config };
    this.#baseline = new EwmaBaseline(this.#config.ewmaAlpha);
    this.#onSpike = onSpike;
  }

  /** Feed one chat message into the engine. */
  processMessage(msg: ChatMessage): void {
    const t0 = (this.#t0 ??= msg.timestamp);
    if (msg.timestamp < t0) {
      // Out-of-order arrival: still count it in the ring if in range, but it
      // cannot finalize a window retroactively. Acceptable for Phase 1.
      this.#appendToRing(msg);
      return;
    }

    this.#appendToRing(msg);

    const index = this.#windowIndex(msg.timestamp);
    const bucket = this.#buckets.get(index) ?? this.#newBucket();
    this.#buckets.set(index, bucket);
    bucket.messageCount += 1;
    bucket.emoteCount += countEmotes(msg.emotesTag);

    // Arriving in bucket `index` finalizes every bucket strictly before it.
    for (const [key, candidate] of this.#buckets) {
      if (!candidate.closed && index > key) {
        candidate.closed = true;
        this.#incorporateWindow(key, candidate, this.#config.windowMs);
      }
    }
  }

  /**
   * Finalize the still-open trailing window, using its real observed span so a
   * partial final burst is evaluated at honest MPS rather than diluting over
   * the full window. Idempotent per bucket. Used at stream end / demo close.
   */
  forceCloseCurrent(now: number): void {
    if (this.#t0 === null) return;
    const index = this.#windowIndex(now);
    const bucket = this.#buckets.get(index);
    if (!bucket || bucket.closed) return;
    bucket.closed = true;
    const span = Math.max(1, now - this.#windowStart(index));
    this.#incorporateWindow(index, bucket, span);
  }

  /** Latest read-model projection. */
  snapshot(): WindowSnapshot {
    const t0 = this.#t0;
    if (t0 === null || this.#buckets.size === 0) {
      return {
        windowIndex: -1,
        windowStart: 0,
        windowEnd: 0,
        messageCount: 0,
        mps: 0,
        baselineMPS: null,
        emoteDensity: 0,
        armed: false,
        windowsIncorporated: 0,
      };
    }
    const [lastKey, last] = [...this.#buckets].at(-1) ?? [0, null];
    if (last === null) throw new Error("unreachable");
    const baseline = this.#baseline.get();
    return {
      windowIndex: lastKey,
      windowStart: this.#windowStart(lastKey),
      windowEnd: this.#windowStart(lastKey) + this.#config.windowMs,
      messageCount: last.messageCount,
      mps: last.messageCount * 1000 / this.#config.windowMs,
      baselineMPS: baseline,
      emoteDensity:
        last.messageCount === 0
          ? 0
          : last.emoteCount / last.messageCount,
      armed: this.#armed(),
      windowsIncorporated: this.#windowsIncorporated,
    };
  }

  get armed(): boolean {
    return this.#armed();
  }

  get windowsIncorporated(): number {
    return this.#windowsIncorporated;
  }

  #armed(): boolean {
    return this.#windowsIncorporated >= this.#config.warmupWindows;
  }

  #newBucket(): WindowBucket {
    return { messageCount: 0, emoteCount: 0, closed: false, fired: false };
  }

  #windowIndex(ts: number): number {
    if (this.#t0 === null) throw new Error("detector not initialized");
    return Math.floor((ts - this.#t0) / this.#config.windowMs);
  }

  #windowStart(index: number): number {
    if (this.#t0 === null) throw new Error("detector not initialized");
    return this.#t0 + index * this.#config.windowMs;
  }

  #appendToRing(msg: ChatMessage): void {
    this.#ring.push(msg);
    const cutoff = msg.timestamp - this.#config.contextBackfillMs;
    while (this.#ring.length > 0 && this.#ring[0]!.timestamp < cutoff) {
      this.#ring.shift();
    }
  }

  #incorporateWindow(index: number, bucket: WindowBucket, spanMs: number): void {
    const mps = bucket.messageCount * 1000 / spanMs;
    const emoteDensity =
      bucket.messageCount === 0 ? 0 : bucket.emoteCount / bucket.messageCount;

    const armed = this.#armed();
    const baseline = this.#baseline.get();
    let reason: "velocity" | "emote_density" | null = null;

    if (armed && baseline !== null) {
      if (mps > baseline * this.#config.velocityThreshold) {
        reason = "velocity";
      } else if (emoteDensity >= this.#config.emoteDensityThreshold) {
        reason = "emote_density";
      }
    }

    // Fold this window into the baseline AFTER judging against it.
    this.#baseline.update(mps);
    this.#windowsIncorporated += 1;

    if (reason !== null && !bucket.fired) {
      bucket.fired = true;
      if (baseline !== null) {
        const firedAt = this.#windowStart(index) + spanMs;
        const cutoff = firedAt - this.#config.contextBackfillMs;
        this.#onSpike?.({
          type: "SpikeDetected",
          firedAt,
          windowIndex: index,
          windowStart: this.#windowStart(index),
          windowEnd: this.#windowStart(index) + this.#config.windowMs,
          messageCount: bucket.messageCount,
          mps,
          baselineMPS: baseline,
          emoteDensity,
          reason,
          triggerRatio: baseline === 0 ? Infinity : mps / baseline,
          context: this.#ring
            .filter(
              (m) => m.timestamp >= cutoff && m.timestamp <= firedAt,
            )
            .slice(0, 500),
        });
      }
    }
  }
}
