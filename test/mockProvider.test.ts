/**
 * MockChatProvider contract tests — seeded determinism and scripted-phase
 * fidelity (the harness the detector acceptance tests rely on).
 *
 * Timestamp contract: messages of second `sec` land at
 * `startedAt + sec*1000 + jitter`, jitter < 1000 — never crossing boundaries.
 */
import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { MockChatProvider, emotesTagFor } from "../src/ingest/MockChatProvider.ts";
import { countEmotes } from "../src/domain/chatMessage.ts";

const SPEC = {
  durationMs: 30_000,
  baseMessagesPerSecond: 4,
  userIdPoolSize: 25,
  spikePhases: [
    { atMs: 10_000, durationMs: 5_000, factor: 8, template: "text_burst" },
    { atMs: 20_000, durationMs: 5_000, factor: 12, template: "emote_storm" },
  ],
} as const;

describe("MockChatProvider", () => {
  test("same spec + seed => identical stream (deterministic)", async () => {
    const a = new MockChatProvider({ ...SPEC, seed: 7 });
    const b = new MockChatProvider({ ...SPEC, seed: 7 });
    await a.start();
    await b.start();
    assert.deepEqual(
      a.messages.map((m) => m.id),
      b.messages.map((m) => m.id),
      "message ids must match replay-for-replay",
    );
  });

  test("different seed => different text choices (variety exists)", async () => {
    const a = new MockChatProvider({ ...SPEC, seed: 1 });
    const b = new MockChatProvider({ ...SPEC, seed: 2 });
    await a.start();
    await b.start();
    assert.notDeepEqual(
      a.messages.map((m) => m.text),
      b.messages.map((m) => m.text),
    );
  });

  test("base rate honoured outside phases — exactly 4 msg/s", async () => {
    const p = new MockChatProvider({ ...SPEC, seed: 3 });
    await p.start();
    const perSecond = new Map<number, number>();
    for (const m of p.messages) {
      const s = Math.floor((m.timestamp - p.startedAt) / 1000);
      perSecond.set(s, (perSecond.get(s) ?? 0) + 1);
    }
    for (const [s, n] of [...perSecond]) {
      if (s < 10 || (s >= 15 && s < 20) || s >= 25) {
        assert.equal(n, 4, `quiet second ${s} must have exactly 4 msgs, got ${n}`);
      }
    }
  });

  test("burst phase multiplies the base rate (factor 8 => 32 msg/s)", async () => {
    const p = new MockChatProvider({ ...SPEC, seed: 3 });
    await p.start();
    for (const sec of [10, 11, 12, 13, 14]) {
      const n = p.messages.filter(
        (m) => Math.floor((m.timestamp - p.startedAt) / 1000) === sec,
      ).length;
      assert.equal(n, 32, `burst second ${sec} must have 32 msgs, got ${n}`);
    }
  });

  test("emote_storm messages all carry >= 3 emote occurrences", async () => {
    const p = new MockChatProvider({ ...SPEC, seed: 3 });
    await p.start();
    const storm = p.messages.filter((m) => {
      const sec = Math.floor((m.timestamp - p.startedAt) / 1000);
      return sec >= 20 && sec < 25;
    });
    assert.equal(storm.length, 48 * 5, "12x factor over 5s");
    for (const m of storm) assert.ok(countEmotes(m.emotesTag) >= 3, m.text);
  });

  test("generated emotes tags parse back to their occurrence count", () => {
    const tag = emotesTagFor("LUL Kappa KEKW LUL");
    assert.equal(countEmotes(tag), 4); // 4 tokens, "LUL" repeated
    assert.equal(emotesTagFor("just text here"), "");
  });

  test("stop() mid-stream truncates cleanly", async () => {
    const p = new MockChatProvider({ ...SPEC, durationMs: 300_000, seed: 9 });
    const seen: string[] = [];
    p.register((m) => seen.push(m.id));
    const running = p.start();
    await new Promise((r) => setTimeout(r, 5)); // let the sync burst begin
    await p.stop();
    await running;
    assert.ok(seen.length > 0, "stream emitted before stop");
    assert.ok(seen.length < 3000, "stop must truncate a 300s script");
  });
});
