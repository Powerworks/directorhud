/**
 * ChatMessage — a single ingested chat line, normalized off the wire.
 *
 * Twitch IRC (with the `twitch.tv/tags` capability) annotates every PRIVMSG
 * with an `emotes` field such as:
 *
 *   "emotes": "emote1:1-4,7-9;emote2:12-15"
 *
 * i.e. `<emote-id>:<start>-<end>,<start>-<end>` describing the 0-indexed char
 * ranges at which each emote substitution applies. countEmotes() turns that
 * tag into a scalar density input without ever needing image assets.
 */
export interface ChatMessage {
  /** Deterministic id. Format: `${channel}:${author}:${timestampMs}`. */
  readonly id: string;
  /** Epoch milliseconds (event time, not processing time). */
  readonly timestamp: number;
  /** Channel without the leading '#'. */
  readonly channel: string;
  /** Display name when available, otherwise login name. */
  readonly author: string;
  /** Raw chat text. */
  readonly text: string;
  /** Verbatim Twitch v3 emotes tag ("" when no capability/no emotes). */
  readonly emotesTag: string;
  /** Number of emote occurrences in `text` (derived from emotesTag). */
  readonly emoteCount: number;
}

/** Build a ChatMessage, deriving emoteCount from the emotes tag. */
export function makeChatMessage(partial: {
  readonly id?: string;
  readonly timestamp: number;
  readonly channel: string;
  readonly author: string;
  readonly text: string;
  readonly emotesTag?: string;
}): ChatMessage {
  const emotesTag = partial.emotesTag ?? "";
  return {
    id: partial.id ?? `${partial.channel}:${partial.author}:${partial.timestamp}`,
    timestamp: partial.timestamp,
    channel: partial.channel,
    author: partial.author,
    text: partial.text,
    emotesTag,
    emoteCount: countEmotes(emotesTag),
  };
}

const FRAGMENT = /^(?<id>[A-Za-z0-9_]+):(?<ranges>\d+-\d+(,\d+-\d+)*)$/;

/**
 * Parse a Twitch `emotes` tag into an occurrence count.
 * Malformed fragments are ignored (counted as 0) — never throw on wire data.
 */
export function countEmotes(emotesTag: string): number {
  if (!emotesTag) return 0;
  let total = 0;
  for (const fragment of emotesTag.split(";")) {
    const match = FRAGMENT.exec(fragment);
    if (!match) continue;
    total += match[2]!.split(",").length;
  }
  return total;
}
