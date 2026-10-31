/**
 * DirectorHUD — Phase 2 entry point.
 * Wires provider ─► spike detector ─► headline service ─► HUD overlay.
 * Ctrl-C stops gracefully.
 */
import { createServer } from "node:http";
import { mkdir } from "node:fs/promises";
import { loadConfig } from "./config.ts";
import { HeadlineService, OpenAIHeadlineClient } from "./headline/headline.ts";
import { createPipeline } from "./pipeline.ts";
import { MockChatProvider } from "./ingest/MockChatProvider.ts";
import { TwitchIrcProvider } from "./ingest/TwitchIrcProvider.ts";
import type { ChatProvider } from "./ingest/ChatProvider.ts";
import { attachHud } from "./hud/server.ts";
import type { SpikeDetected } from "./domain/events.ts";
import { ClipGenerator } from "./clip/ClipGenerator.ts";
import { CodexFiltergraphClient } from "./clip/filtergraph.ts";

function providerFromArgv(): string | undefined {
  const flag = process.argv.indexOf("--provider");
  if (flag >= 0) return process.argv[flag + 1];
  return undefined;
}

async function main(): Promise<void> {
  const config = loadConfig(providerFromArgv());

  // Phase 2 headline path: live API when a key exists, teaser always ready.
  const headline = new HeadlineService(
    config.openai.apiKey === null
      ? null
      : new OpenAIHeadlineClient(config.openai.apiKey, config.openai.model),
  );

  // HUD overlay server (OBS Browser Source → http://localhost:<port>/)
  const httpServer = createServer();
  const hud = attachHud(httpServer);
  const hudPort = config.hudPort;
  await new Promise<void>((resolve, reject) => {
    httpServer.once("error", reject);
    httpServer.listen(hudPort, () => {
      httpServer.off("error", reject);
      void resolve();
    });
  });
  process.stdout.write(
    `[hud] overlay → http://localhost:${hudPort}/  (add as OBS Browser Source, 1920×1080)\n`,
  );

  // Diagnostics sink.
  const logSpike = (event: SpikeDetected) => {
    const { context, ...summary } = event;
    process.stdout.write(
      `[SPIKE] ${JSON.stringify(summary)} context:[${context.map((m) => m.id).join(",")}]\n`,
    );
  };

  // Phase 3 clip path: only active when a recording source is configured
  // (DIRECTORHUD_RECORDING_PATH) — see docs/adr/002. Codex generates the
  // filtergraph; a deterministic center-crop is the always-available fallback.
  let clip: ClipGenerator | null = null;
  if (config.clip) {
    await mkdir(config.clip.outputDir, { recursive: true });
    clip = new ClipGenerator(
      { ...config.clip, geometry: { width: 1080, height: 1920 } },
      new CodexFiltergraphClient(),
    );
    process.stdout.write(`[clip] enabled → ${config.clip.outputDir}/ (recording: ${config.clip.recordingPath})\n`);
  }

  const pipeline = createPipeline({
    // The 120s demo script embeds its burst at 40s — matching the short-
    // calibration scenario (as in simulate.ts) so both triggers can fire
    // inside the script window. Live detectors keep config.detector's defaults.
    config:
      config.provider === "mock"
        ? { ...config.detector, warmupWindows: 4 }
        : config.detector,
    headline,
    hud,
    clip,
    onSpike: logSpike,
  });

  let provider: ChatProvider;
  if (config.provider === "twitch") {
    if (config.twitch === null)
      throw new Error("internal: twitch config missing");
    provider = new TwitchIrcProvider({
      channel: config.twitch.channel,
      username: config.twitch.botName,
      token: config.twitch.token,
    });
  } else {
    provider = new MockChatProvider({
      durationMs: 120_000,
      baseMessagesPerSecond: 4,
      userIdPoolSize: 25,
      spikePhases: [
        { atMs: 40_000, durationMs: 15_000, factor: 8, template: "text_burst" },
        { atMs: 90_000, durationMs: 10_000, factor: 1, template: "emote_storm" },
      ],
    });
  }

  provider.register((msg) => pipeline.onChat(msg));
  await provider.start();

  // Keep the trailing window honest between idle gaps.
  const interval = setInterval(() => pipeline.flush(), 1_000);
  interval.unref();

  const shutdown = async (): Promise<void> => {
    clearInterval(interval);
    pipeline.flush();
    await provider.stop().catch(() => undefined);
    process.stdout.write(`[DONE] ${pipeline.stats()} listeners=${pipeline.listeners()}\n`);
    process.exit(0);
  };

  process.once("SIGINT", () => void shutdown());
  process.once("SIGTERM", () => void shutdown());

  if (provider instanceof MockChatProvider) {
    await new Promise<void>((resolve) => {
      const timer = setInterval(() => {
        if (provider.stopRequested) {
          clearInterval(timer);
          void shutdown().then(resolve);
        }
      }, 25);
      timer.unref();
    });
  }
}

void main().catch((error) => {
  process.stderr.write(`[FATAL] ${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
});
