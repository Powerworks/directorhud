/**
 * Headline synthesis — turning a 60s chat context into an 8–12 word
 * on-stream headline.
 *
 * Pipeline safety rule: the OpenAI call is a *decoration*, never a blocker.
 * Every failure mode (no key, network, filter, garbage payload) degrades to a
 * deterministic rule-based teaser so a live demo can never hang on the API.
 */
import type { ChatMessage } from "../domain/chatMessage.ts";
import type { TriggerReason } from "../domain/events.ts";

export const DEFAULT_OPENAI_MODEL = "gpt-4o-mini";

export interface SynthesisContext {
  readonly reason: TriggerReason;
  /** Window length in ms — lets the promo copy stay honest about durations. */
  readonly windowMs: number;
}

export interface SynthResult {
  readonly headline: string;
  readonly source: "openai" | "teaser";
}

export interface HeadlineClient {
  synthesize(
    context: readonly ChatMessage[],
    meta: SynthesisContext,
  ): Promise<string>;
}

const SYSTEM = `You are the headline writer for DirectorHUD, a live Twitch broadcast
director. You read an unstructured window of Twitch chat (author: text lines)
captured during a chat spike, and you return ONE tight, humorous broadcaster
headline — 8 to 12 words — explaining why chat erupted, in the voice a
streamer would shout over a clip. No quotes, no hashtags, no emoji, no
punctuation tricks. Return only the headline text.

Example:
streamer ignores chat's warnings, walks straight off the map edge`;

function buildUserPrompt(
  context: readonly ChatMessage[],
  meta: SynthesisContext,
): string {
  const bullets = context.map((m) => `${m.author}: ${m.text}`).join("\n");
  const trigger =
    meta.reason === "emote_density" ? "emote storm" : "velocity spike";
  return `Chat spike detected: ${trigger}.
${context.length} recent messages (oldest first):

${bullets}

Write the headline.`;
}

export class OpenAIHeadlineClient implements HeadlineClient {
  readonly apiKey: string;
  readonly model: string;
  readonly timeoutMs: number;

  constructor(apiKey: string, model?: string, timeoutMs = 10_000) {
    this.apiKey = apiKey;
    this.model = model ?? DEFAULT_OPENAI_MODEL;
    this.timeoutMs = timeoutMs;
  }

  async synthesize(
    context: readonly ChatMessage[],
    meta: SynthesisContext,
  ): Promise<string> {
    const res = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${this.apiKey}`,
      },
      body: JSON.stringify({
        model: this.model,
        messages: [
          { role: "system", content: SYSTEM },
          { role: "user", content: buildUserPrompt(context, meta) },
        ],
        temperature: 0.85,
        max_completion_tokens: 40,
      }),
      signal: AbortSignal.timeout(this.timeoutMs),
    });
    if (!res.ok) {
      throw new Error(`openai api ${res.status}`);
    }
    const body = (await res.json()) as {
      choices?: Array<{ message?: { content?: string } }>;
    };
    const content = body.choices?.[0]?.message?.content;
    if (!content || !content.trim()) {
      throw new Error("openai response empty");
    }
    return content;
  }
}

/** Deterministic fallback when the API is unavailable or slow. */
export function buildTeaser(
  context: readonly ChatMessage[],
  meta: SynthesisContext,
): string {
  // Most repeated non-trivial word in the window = what chat is actually
  // locked onto. Emotes surface as lexicon tokens naturally.
  const frequency = new Map<string, number>();
  for (const m of context) {
    for (const word of m.text.toLowerCase().split(/[^a-z0-9']/g)) {
      if (word.length < 3) continue;
      frequency.set(word, (frequency.get(word) ?? 0) + 1);
    }
  }
  let top = "";
  let topCount = 0;
  for (const [word, n] of frequency) {
    if (n > topCount || (n === topCount && word < top)) {
      top = word;
      topCount = n;
    }
  }
  const windowSec = Math.max(1, Math.round(meta.windowMs / 1000));
  if (!top) return `CHAT ERUPTS — ${context.length} messages in ${windowSec}s with zero chill`;
  return `Chat ignites — "${top}" storm ×${topCount} (${context.length} messages in ${windowSec}s)`;
}

/** Strip anything that would break the JSON protocol or the HUD DOM. */
export function sanitizeHeadline(raw: string): string {
  return raw
    // C0 + DEL control chars (incl. \r\n\t) become spaces…
    .replace(/[\x00-\x1f\x7f]/g, " ")
    // …which then collapse; length cap for the protocol frame.
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 140);
}

export const MIN_HEADLINE_CHARS = 8;

export class HeadlineService {
  readonly primary: HeadlineClient | null;
  readonly fallbackTeaser: (
    context: readonly ChatMessage[],
    meta: SynthesisContext,
  ) => string;

  constructor(primary: HeadlineClient | null) {
    this.primary = primary;
    this.fallbackTeaser = buildTeaser;
  }

  /** Never rejects: always resolves to a presentable headline. */
  async synthesize(
    context: readonly ChatMessage[],
    meta: SynthesisContext,
  ): Promise<SynthResult> {
    if (this.primary !== null) {
      try {
        const attempt = sanitizeHeadline(await this.primary.synthesize(context, meta));
        if (attempt.length >= MIN_HEADLINE_CHARS) {
          return { headline: attempt, source: "openai" };
        }
      } catch {
        // fall through to teaser — commentary for observability
        process.stderr.write("[headline] openai failed, using teaser fallback\n");
      }
    }
    return {
      headline: sanitizeHeadline(this.fallbackTeaser(context, meta)),
      source: "teaser",
    };
  }
}
