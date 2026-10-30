import { makeChatMessage } from "../domain/chatMessage.ts";
import type { ChatListener } from "./ChatProvider.ts";
import type { ChatProvider } from "./ChatProvider.ts";

export interface TwitchIrcOptions {
  readonly channel: string;
  readonly username: string;
  /** Full oauth token, including the `oauth:` prefix. */
  readonly token: string;
}

/**
 * Live Twitch chat ingestion over IRC (tmi.js).
 *
 * Twitch EventSub was considered and deferred: webhook transport requires a
 * publicly reachable HTTPS endpoint, which a local hackathon demo box does
 * not have; websocket transport is IRC-equivalent for raw messages.
 *
 * tmi.js is dynamically imported here so the mock/test path never touches it
 * (failures in credential setup must not break headless operation).
 */
export class TwitchIrcProvider implements ChatProvider {
  readonly name = "twitch-irc";

  readonly #options: TwitchIrcOptions;
  #listener: ChatListener | null = null;
  #client: unknown = null;

  constructor(options: TwitchIrcOptions) {
    this.#options = options;
    if (!this.#options.channel) throw new Error("TWITCH_CHANNEL is required");
    if (!this.#options.token) throw new Error("TWITCH_OAUTH is required");
    if (!this.#options.token.startsWith("oauth:"))
      throw new Error("TWITCH_OAUTH must include the 'oauth:' prefix");
  }

  register(listener: ChatListener): void {
    this.#listener = listener;
  }

  async start(): Promise<void> {
    // Delayed import: keep the core/mock path dependency-light at runtime.
    const tmi = (await import("tmi.js")) as typeof import("tmi.js");
    this.#client = new tmi.Client({
      connection: { secure: true, reconnect: true },
      identity: {
        username: this.#options.username,
        password: this.#options.token,
      },
      channels: [`#${this.#options.channel}`],
      options: { debug: process.env.DIRECTORHUD_DEBUG === "1" },
    });
    const client = this.#client as {
      on(event: string, cb: unknown): unknown;
      connect(): Promise<unknown>;
      disconnect(): Promise<unknown>;
    };

    client.on("message", (_channel: unknown, userstate: Record<string, unknown>, message: unknown, self: boolean) => {
      if (self) return;
      const text = String(message);
      const rawEmotes = userstate.emotes;
      const emotesTag = typeof rawEmotes === "string" ? rawEmotes : "";
      this.#listener?.(
        makeChatMessage({
          timestamp: Date.now(),
          channel: this.#options.channel,
          author: (userstate["display-name"] ?? userstate["username"] ?? "unknown") as string,
          text,
          emotesTag,
        }),
      );
    });
    client.on("connected", () => {
      process.stdout.write(
        `[twitch-irc] connected as ${this.#options.username} in #${this.#options.channel}\n`,
      );
    });

    await client.connect();
  }

  async stop(): Promise<void> {
    const client = this.#client as { disconnect(): Promise<unknown> } | null;
    this.#client = null;
    await client?.disconnect();
  }
}
