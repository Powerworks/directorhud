/**
 * DirectorHUD — Phase 1 entry point.
 * Wires provider -> spike detector, logs every SpikeDetected as JSON.
 * Ctrl-C (SIGINT) stops gracefully.
 */
import { loadConfig } from "./config.ts";
import { SpikeDetector } from "./detector/SpikeDetector.ts";
import { MockChatProvider } from "./ingest/MockChatProvider.ts";
import { TwitchIrcProvider } from "./ingest/TwitchIrcProvider.ts";
import type { ChatProvider } from "./ingest/ChatProvider.ts";

function providerFromArgv(): string | undefined {
  const flag = process.argv.indexOf("--provider");
  if (flag >= 0) return process.argv[flag + 1];
  return undefined;
}

async function main(): Promise<void> {
  const config = loadConfig(providerFromArgv());

  const detector = new SpikeDetector(config.detector, (event) => {
    // Context is a 60s array of messages — collapse it for terminal
    // readability; consumers downstream receive the full structure.
    const { context, ...summary } = event;
    process.stdout.write(
      `[SPIKE] ${JSON.stringify(summary)} context:[${context.map((m) => m.id).join(",")}]\n`,
    );
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

  provider.register((msg) => detector.processMessage(msg));
  await provider.start();

  // If the trailing window never gets a next-window message to close it,
  // finalize honest partial-MPS stats before we evaluate back-pressure.
  const now = () => Date.now();
  const interval = setInterval(() => detector.forceCloseCurrent(now()), 1_000);
  interval.unref();

  const shutdown = async (): Promise<void> => {
    clearInterval(interval);
    await provider.stop().catch(() => undefined);
    detector.forceCloseCurrent(now());
    const snap = detector.snapshot();
    process.stdout.write(
      `[DONE] provider=${provider.name} armed=${snap.armed} windows=${snap.windowsIncorporated} mps=${snap.mps.toFixed(2)}\n`,
    );
    process.exit(0);
  };

  process.once("SIGINT", () => void shutdown());
  process.once("SIGTERM", () => void shutdown());

  if (provider instanceof MockChatProvider) {
    // Mock finishes on its own — settle and leave cleanly.
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
