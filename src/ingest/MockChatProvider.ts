import { makeChatMessage } from "../domain/chatMessage.ts";
import type { ChatMessage } from "../domain/chatMessage.ts";
import type { ChatListener } from "./ChatProvider.ts";
import type { ChatProvider } from "./ChatProvider.ts";

/** Scriptable burst phase inside a synthetic stream. */
export interface SpikePhase {
  /** Phase start offset from stream t0 (ms). */
  readonly atMs: number;
  /** Phase duration (ms). */
  readonly durationMs: number;
  /** Multiplier on baseMessagesPerSecond during the phase. */
  readonly factor: number;
  /** "emote_storm" = emote-only posts; "text_burst" = normal chat, just faster. */
  readonly template: "emote_storm" | "text_burst";
}

export interface MockChatSpec {
  readonly durationMs: number;
  readonly baseMessagesPerSecond: number;
  readonly userIdPoolSize: number;
  readonly spikePhases?: readonly SpikePhase[];
  /** Seeded PRNG — same spec + seed always yields the same stream. */
  readonly seed?: number;
}

const NORMAL_TEXT = [
  "lol",
  "nice play",
  "hahaha",
  "that was smooth",
  "wut",
  "lol no way",
  "nice shot",
  "haha good one",
  "how is this real",
  "come on lol",
];

const EMOTE_LEXICON = [
  "Kappa",
  "LUL",
  "KEKW",
  "PepeLaugh",
  "POGGERS",
  "OMEGA",
  "Pepega",
  "ClipIt",
  "HAHYEAH",
  "DansGame",
];

/** Deterministic single pick from a const array (strict-indexable). */
function pick<T>(list: readonly T[], prng: () => number): T {
  return list[Math.floor(prng() * list.length)] as T;
}

/** mulberry32 — tiny, deterministic, platform-independent PRNG. */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function indexOf<T>(list: readonly T[], value: T): number {
  return list.indexOf(value);
}

/**
 * Deterministic synthetic Twitch chat.
 * Rates follow the spec exactly on a per-second grid (floor(secRate)), so
 * tests can assert precise message counts; jitter only scrambles text choice.
 */
export class MockChatProvider implements ChatProvider {
  readonly name = "mock";
  /** Every emitted message, in emission order — trace for demos/tests. */
  readonly messages: ChatMessage[] = [];
  /** t0 of the current run — timestamps align: msg = t0 + sec*1000 + jitter. */
  startedAt = 0;

  readonly spec: MockChatSpec;
  #listener: ChatListener | null = null;
  #stopRequested = false;

  constructor(spec: MockChatSpec) {
    this.spec = spec;
  }

  register(listener: ChatListener): void {
    this.#listener = listener;
  }

  get stopRequested(): boolean {
    return this.#stopRequested;
  }

  async start(): Promise<void> {
    this.#stopRequested = false;
    const prng = mulberry32(this.spec.seed ?? 42);
    this.startedAt = Date.now();

    const durationS = Math.ceil(this.spec.durationMs / 1000);
    for (let sec = 0; sec < durationS && !this.#stopRequested; sec += 1) {
      const atMs = sec * 1000;
      const phase = activePhase(this.spec.spikePhases ?? [], atMs);
      const perSecond =
        Math.floor(this.spec.baseMessagesPerSecond * (phase ? phase.factor : 1)) ||
        1;

      for (let j = 0; j < perSecond && !this.#stopRequested; j += 1) {
        // Deterministic jitter inside the second — arrival order preserved.
        const jitter = Math.floor(((j + 0.5) / perSecond) * 1000);
        const text = textFor(phase, prng);
        const emotesTag = emotesTagFor(text);
        const author = `viewer${1 + Math.floor(prng() * this.spec.userIdPoolSize)}`;

        // Deterministic id: authored relative to run start, so identical
        // replays reproduce identical ids even across separate processes.
        const message = makeChatMessage({
          id: `mock:${author}:${atMs + jitter}`,
          timestamp: this.startedAt + atMs + jitter,
          channel: "mock",
          author,
          text,
          emotesTag,
        });
        this.messages.push(message);
        this.#listener?.(message);
      }

      // Yield per second so an in-flight stop() can actually take effect.
      await new Promise((resolve) => setImmediate(resolve));
    }
  }

  async stop(): Promise<void> {
    this.#stopRequested = true;
  }
}

function activePhase(phases: readonly SpikePhase[], atMs: number): SpikePhase | null {
  for (const phase of phases) {
    if (atMs >= phase.atMs && atMs < phase.atMs + phase.durationMs) return phase;
  }
  return null;
}

function textFor(phase: SpikePhase | null, prng: () => number): string {
  if (phase?.template === "emote_storm") {
    const tokens = 3 + Math.floor(prng() * 3); // 3-5 pure emotes
    const words: string[] = [];
    for (let i = 0; i < tokens; i += 1)
      words.push(pick(EMOTE_LEXICON, prng));
    return words.join(" ");
  }
  if (phase?.template === "text_burst" && prng() < 0.15) {
    // Rare emote garnish makes bursts look organic.
    return `${pick(NORMAL_TEXT, prng)} ${EMOTE_LEXICON[0]}`;
  }
  // Steady-state chatter; ~10% of messages carry a single emote.
  const base = pick(NORMAL_TEXT, prng);
  if (prng() < 0.1) return base;
  const emote = pick(EMOTE_LEXICON, prng);
  return `${base} ${emote}`;
}

/**
 * Reconstruct the Twitch emotes tag from text known to contain lexicon
 * emotes (mock-side guarantee — real tags come from IRC untouched).
 */
/** Reconstructed mock-side tag (exported for the test suite). */
export function emotesTagFor(text: string): string {
  const words = text.split(" ");
  const ranges: string[] = [];
  let cursor = 0;
  for (const word of words) {
    if (indexOf(EMOTE_LEXICON, word) >= 0) {
      const id = lexiconId(word);
      const end = cursor + word.length - 1;
      ranges.push(`${id}:${cursor}-${end}`);
    }
    cursor += word.length + 1; // +1 for the space
  }
  return ranges.join(";");
}

function lexiconId(word: string): string {
  return word.toLowerCase().replace(/[^a-z0-9]/g, "_");
}

