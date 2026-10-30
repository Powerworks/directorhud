import type { ChatMessage } from "./chatMessage.ts";

/**
 * Events — facts that happened, consumed downstream (HUD projection, the
 * 60s context window handed to the Codex prompt job).
 */
export type TriggerReason = "velocity" | "emote_density";

export interface SpikeDetected {
  readonly type: "SpikeDetected";
  /** Epoch ms — the close of the triggering window (its evaluation moment). */
  readonly firedAt: number;
  readonly windowIndex: number;
  readonly windowStart: number; // t0 + index * windowMs
  readonly windowEnd: number; // windowStart + windowMs
  readonly messageCount: number;
  /** Messages per second observed inside the window. */
  readonly mps: number;
  /** Baseline MPS recorded *before* this window was folded in. */
  readonly baselineMPS: number;
  /** Emote occurrences per message inside the window. */
  readonly emoteDensity: number;
  /** Which acceptance rule fired. */
  readonly reason: TriggerReason;
  /** mps / baselineMPS — how extreme the burst was. */
  readonly triggerRatio: number;
  /** The 60s (configurable) chat context captured for headline synthesis. */
  readonly context: readonly ChatMessage[];
}

/** Snapshot of the engine after a window closed — the read model. */
export interface WindowSnapshot {
  readonly windowIndex: number;
  readonly windowStart: number;
  readonly windowEnd: number;
  readonly messageCount: number;
  readonly mps: number;
  readonly baselineMPS: number | null;
  readonly emoteDensity: number;
  /** false during the warmup/calibration phase. */
  readonly armed: boolean;
  /** How many complete windows have been folded into the model. */
  readonly windowsIncorporated: number;
}
