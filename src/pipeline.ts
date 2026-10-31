/**
 * Pipeline composition — wires the Phase 1 detector to the Phase 2
 * headline service and HUD broadcaster. The detector stays a pure engine;
 * all I/O lives here behind one injectable, test-seam.
 */
import type { ChatMessage } from "./domain/chatMessage.ts";
import type { SpikeDetected } from "./domain/events.ts";
import type { DetectorConfig, SpikeDetector } from "./detector/SpikeDetector.ts";
import { SpikeDetector as SpikeDetectorImpl } from "./detector/SpikeDetector.ts";
import type { HeadlineService, SynthesisContext } from "./headline/headline.ts";
import type { HudBroadcaster, HudEvent } from "./hud/server.ts";
import type { ClipGenerator } from "./clip/ClipGenerator.ts";

export interface Pipeline {
  /** Engine — exposed read-only for stats; drive it via onChat. */
  readonly detector: SpikeDetector;
  /** Chat hook for whichever provider is live. */
  onChat: (message: ChatMessage) => void;
  /** Flush the open window (stream end / shutdown). */
  flush: () => void;
  /** One-line diagnostics. */
  stats: () => string;
  /** Current overlay listener count (0 when HUD off). */
  listeners: () => number;
}

export function createPipeline(params: {
  /** Detector tuning; defaults to DEFAULT_DETECTOR_CONFIG. */
  config?: Partial<DetectorConfig>;
  /** Optional diagnostics sink (CLI logging). */
  onSpike?: (event: SpikeDetected) => void;
  readonly headline: HeadlineService;
  readonly hud: HudBroadcaster | null;
  /** Phase 3 — null when no recording source is configured (clips are decoration, not required). */
  readonly clip?: ClipGenerator | null;
}): Pipeline {
  const { config = {}, onSpike, headline, hud, clip = null } = params;

  const fireClip = (event: SpikeDetected, caption: string) => {
    if (!clip) return;
    // Fire-and-forget — same rule as the headline/HUD path: clip export can
    // take seconds (ffmpeg + a Codex round trip) and must never stall ingest.
    clip.generate(event, caption).catch((error) => {
      process.stderr.write(`[pipeline] clip generation failed: ${String(error)}\n`);
    });
  };

  const detector = new SpikeDetectorImpl(config, (event: SpikeDetected) => {
    // Diagnostics first — always.
    onSpike?.(event);

    const meta: SynthesisContext = {
      reason: event.reason,
      windowMs: event.windowEnd - event.windowStart,
    };

    void headline
      .synthesize(event.context, meta)
      .then((synth) => {
        hud?.broadcast(toHudEvent(event, synth));
        fireClip(event, synth.headline);
      })
      .catch((error) => {
        // synthesize() is contractually non-rejecting, but an exception
        // here means a bug, not a network problem — still never break the stream.
        process.stderr.write(`[pipeline] headline sink failed: ${String(error)}\n`);
        const fallback = { headline: "Moment locked — highlight rendering", source: "teaser" as const };
        hud?.broadcast(toHudEvent(event, fallback));
        fireClip(event, fallback.headline);
      });
  });

  return {
    detector,
    onChat: (message: ChatMessage) => detector.processMessage(message),
    flush: () => detector.forceCloseCurrent(Date.now()),
    stats: () => {
      const s = detector.snapshot();
      return `windows=${s.windowsIncorporated} armed=${s.armed} lastMps=${s.mps.toFixed(1)} baseline=${s.baselineMPS?.toFixed(1) ?? "-"}`;
    },
    listeners: () => hud?.clients.size ?? 0,
  };
}

function toHudEvent(event: SpikeDetected, synth: { readonly headline: string; readonly source: "openai" | "teaser" }): HudEvent {
  return {
    type: "spike",
    firedAt: event.firedAt,
    windowIndex: event.windowIndex,
    reason: event.reason,
    mps: event.mps,
    baselineMPS: event.baselineMPS,
    triggerRatio: event.triggerRatio,
    headline: synth.headline,
    source: synth.source,
  };
}
