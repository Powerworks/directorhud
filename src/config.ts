import { existsSync } from "node:fs";
import type { DetectorConfig } from "./detector/SpikeDetector.ts";

/**
 * Runtime configuration — mock-first by default; live Twitch wires up only
 * when credentials exist. Values come from the environment (.env optional).
 */

export type ProviderKind = "mock" | "twitch";

export interface TwitchConfig {
  readonly channel: string;
  readonly token: string;
  readonly botName: string;
}

export interface OpenAIConfig {
  /** null ⇒ teaser fallback only — safe for keynote demos. */
  readonly apiKey: string | null;
  readonly model: string;
}

export interface RuntimeConfig {
  readonly provider: ProviderKind;
  readonly twitch: TwitchConfig | null;
  readonly detector: DetectorConfig;
  readonly openai: OpenAIConfig;
  readonly hudPort: number;
}

function loadDotEnv(): void {
  try {
    if (existsSync(".env")) process.loadEnvFile();
  } catch {
    // A malformed .env must never take the pipeline down silently —
    // surface it loudly instead.
    throw new Error("Failed to load .env — check syntax.");
  }
}

function numEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined) return fallback;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed)) {
    throw new Error(`env ${name} must be a finite number, got "${raw}"`);
  }
  return parsed;
}

export function loadConfig(argvProvider: string | undefined = undefined): RuntimeConfig {
  loadDotEnv();

  const explicit = argvProvider ?? process.env.DIRECTORHUD_PROVIDER;
  const hasTwitchCreds =
    Boolean(process.env.TWITCH_CHANNEL && process.env.TWITCH_OAUTH);
  const provider = (explicit ?? (hasTwitchCreds ? "twitch" : "mock")) as ProviderKind;
  if (provider !== "mock" && provider !== "twitch") {
    throw new Error(`DIRECTORHUD_PROVIDER must be "mock" or "twitch", got "${provider}"`);
  }
  if (provider === "twitch" && !hasTwitchCreds) {
    throw new Error(
      'provider=twitch requires TWITCH_CHANNEL and TWITCH_OAUTH (see .env.example)',
    );
  }

  const detector: DetectorConfig = {
    windowMs: Math.max(1_000, numEnv("DIRECTORHUD_WINDOW_MS", 10_000)),
    warmupWindows: Math.max(1, Math.round(numEnv("DIRECTORHUD_WARMUP_WINDOWS", 6))),
    ewmaAlpha: Math.min(1, Math.max(0.01, numEnv("DIRECTORHUD_EWMA_ALPHA", 0.3))),
    velocityThreshold: Math.max(1.01, numEnv("DIRECTORHUD_VELOCITY_K", 3.0)),
    emoteDensityThreshold: Math.max(1, numEnv("DIRECTORHUD_EMOTE_DENSITY_MIN", 2.5)),
    contextBackfillMs: Math.max(5_000, numEnv("DIRECTORHUD_CONTEXT_MS", 60_000)),
  };

  const twitch = hasTwitchCreds
    ? {
        channel: process.env.TWITCH_CHANNEL!,
        token: process.env.TWITCH_OAUTH!,
        botName: process.env.TWITCH_BOT_NAME ?? "directorhud_bot",
      }
    : null;

  const openai: OpenAIConfig = {
    apiKey: process.env.OPENAI_API_KEY ?? null,
    model: process.env.OPENAI_MODEL ?? "gpt-4o-mini",
  };
  const hudPort = Math.max(1024, Math.min(65535, numEnv("DIRECTORHUD_HUD_PORT", 8788)));

  return { provider, twitch, detector, openai, hudPort };
}
