import type { ChatMessage } from "../domain/chatMessage.ts";

/** Command sink shared by every ingest backend. */
export type ChatListener = (message: ChatMessage) => void;

/**
 * ChatProvider — seam between "chat exists somewhere" and the detector.
 * Phase 1 ships two providers behind this interface:
 *   - MockChatProvider: seeded synthetic stream for tests + headless demo.
 *   - TwitchIrcProvider: live tmi.js client wired to real credentials.
 */
export interface ChatProvider {
  readonly name: string;
  register(listener: ChatListener): void;
  /** Begin streaming; resolves once started (mock) or connected (twitch). */
  start(): Promise<void>;
  /** Stop streaming / disconnect. */
  stop(): Promise<void>;
}
