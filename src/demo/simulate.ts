/**
 * Headless end-to-end smoke run: 120s synthetic stream containing exactly
 * two triggerable moments — one velocity spike and one emote-storm window —
 * deterministically seeded. Exits non-zero if the engine fails to fire
 * exactly the expected events, so `npm run demo` doubles as a CI smoke gate.
 *
 * Scenario math (baseline 4 msg/s, window 10s, warmup 4 => armed at win4):
 *   0-39s   4 msg/s steady            -> baseline EWMA settles at 4.0 MPS
 *   40-54s  32 msg/s text burst (win4) -> 8x fires `velocity` once; win5
 *                                      (18 mps) is suppressed by adaptation
 *   55-89s  4 msg/s steady            -> baseline EWMA decays back toward ~7
 *   90-99s  4 msg/s emote storm (win9) -> density ~4.0 fires `emote_density`
 *   (the storm fills the whole 10s window because density is a per-window
 *    aggregate — a 1s storm inside a 10s window would read ~0.4)
 */
import type { SpikeDetected } from "../domain/events.ts";
import { SpikeDetector } from "../detector/SpikeDetector.ts";
import { MockChatProvider } from "../ingest/MockChatProvider.ts";

export interface SimulationStats {
  readonly messages: number;
  readonly spikes: SpikeDetected[];
  readonly expectedSpikes: number;
}

export async function runSimulation(): Promise<SimulationStats> {
  const spikes: SpikeDetected[] = [];
  const detector = new SpikeDetector({ warmupWindows: 4 }, (e) => spikes.push(e));

  const provider = new MockChatProvider({
    durationMs: 120_000,
    baseMessagesPerSecond: 4,
    userIdPoolSize: 25,
    spikePhases: [
      { atMs: 40_000, durationMs: 15_000, factor: 8, template: "text_burst" },
      { atMs: 90_000, durationMs: 10_000, factor: 1, template: "emote_storm" },
    ],
  });

  provider.register((msg) => detector.processMessage(msg));
  await provider.start();
  detector.forceCloseCurrent(Date.now());

  return { messages: provider.messages.length, spikes, expectedSpikes: 2 };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const t0 = Date.now();
  const { messages, spikes, expectedSpikes } = await runSimulation();

  process.stdout.write(
    `\n=== DirectorHUD Phase 1 smoke run (${Date.now() - t0}ms) ===\n`,
  );
  process.stdout.write(`messages ingested : ${messages}\n`);
  process.stdout.write(
    `spikes detected   : ${spikes.length} (expected ${expectedSpikes})\n`,
  );
  for (const s of spikes) {
    process.stdout.write(
      `  #${s.windowIndex} ${s.reason.padEnd(14)} mps=${s.mps.toFixed(1)} baseline=${s.baselineMPS.toFixed(1)} ratio=${s.triggerRatio.toFixed(2)} context_msgs=${s.context.length}\n`,
    );
  }

  const byReason: Record<string, number> = {};
  for (const s of spikes) byReason[s.reason] = (byReason[s.reason] ?? 0) + 1;
  const ok =
    spikes.length === expectedSpikes &&
    (byReason.velocity ?? 0) >= 1 &&
    (byReason.emote_density ?? 0) >= 1;
  process.stdout.write(`result            : ${ok ? "PASS" : "FAIL"}\n`);
  process.exit(ok ? 0 : 1);
}
