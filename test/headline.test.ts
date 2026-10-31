/**
 * Headline layer tests — prompt contract, sanitize rules, teaser fallback,
 * OpenAI client over a MOCKED fetch (no network in the test suite).
 */
import { describe, test, mock } from "node:test";
import assert from "node:assert/strict";
import { makeChatMessage } from "../src/domain/chatMessage.ts";
import {
  buildTeaser,
  HeadlineService,
  OpenAIHeadlineClient,
  sanitizeHeadline,
} from "../src/headline/headline.ts";

const ctx = (texts: string[], emotes: string[] = []): ReturnType<typeof makeChatMessage>[] =>
  texts.map((text, i) =>
    makeChatMessage({
      timestamp: 1_000 + i,
      channel: "pwrkns",
      author: `viewer${i}`,
      text,
      emotesTag: emotes[i] ?? "",
    }),
  );

describe("sanitizeHeadline — protocol/DOM hardening", () => {
  test("flattens newlines, collapses spaces, trims, caps length", () => {
    const dirty = "  line one\r\nline  two\tline three wow ".repeat(20);
    const out = sanitizeHeadline(dirty);
    assert.ok(!/[\r\n\t]/.test(out));
    assert.ok(!/\s{2}/.test(out));
    assert.ok(out.length <= 140);
    assert.equal(out.startsWith("line one line two"), true);
  });

  test("hands control-char chat gibberish a clean exit", () => {
    assert.equal(sanitizeHeadline("\x00\x01\x02"), ""); // below MIN length → caller falls back
  });
});

describe("buildTeaser — deterministic fallback copy", () => {
  test("locks onto the most repeated word", () => {
    const r = buildTeaser(ctx(["KEKW nice", "KEKW nice", "KEKW nice", "KEKW lol"]), {
      reason: "emote_density",
      windowMs: 10_000,
    });
    assert.match(r, /"kekw" storm ×4/);
  });

  test("empty of long words → generic eruption line", () => {
    const r = buildTeaser(ctx(["a b", "a c", "a"]), { reason: "velocity", windowMs: 10_000 });
    assert.match(r, /CHAT ERUPTS/);
  });

  test("identical input → identical output (recording-safe)", () => {
    const c = ctx(["KEKW", "KEKW", "KEKW"]);
    const a = buildTeaser(c, { reason: "velocity", windowMs: 10_000 });
    const b = buildTeaser(c, { reason: "velocity", windowMs: 10_000 });
    assert.equal(a, b);
  });
});

describe("HeadlineService — fallback contract", () => {
  test("no primary client → always teaser, never rejects", async () => {
    const svc = new HeadlineService(null);
    const result = await svc.synthesize(ctx(["KEKW KEKW KEKW"]), {
      reason: "emote_density",
      windowMs: 10_000,
    });
    assert.equal(result.source, "teaser");
    assert.ok(result.headline.length >= 8);
  });

  test("short API payload → frowns and falls back", async () => {
    const svc = new HeadlineService({ synthesize: async () => "nope" });
    const result = await svc.synthesize(ctx(["whatever"]), {
      reason: "velocity",
      windowMs: 10_000,
    });
    assert.equal(result.source, "teaser");
  });

  test("primary throwing → teaser, logs nothing to stdout", async () => {
    const svc = new HeadlineService({
      synthesize: async () => {
        throw new Error("boom");
      },
    });
    const result = await svc.synthesize(ctx(["test valid words here"]), {
      reason: "velocity",
      windowMs: 10_000,
    });
    assert.equal(result.source, "teaser");
  });
});

describe("OpenAIHeadlineClient — fetch contract", () => {
  test("posts model/messages correctly and parses content", async () => {
    const fetchHelpers = fakeFetch({
      choices: [{ message: { content: "streamer walks off the map edge lol" } }],
    });
    const client = new OpenAIHeadlineClient("sk-test", "gpt-4o-mini", 1_000);
    const out = await client.synthesize(ctx(["KEKW lol", "KEKW KEKW"]), {
      reason: "velocity",
      windowMs: 10_000,
    });
    assert.equal(out, "streamer walks off the map edge lol");

    const body = JSON.parse(String(fetchHelpers.lastInit?.body));
    assert.equal(body.model, "gpt-4o-mini");
    assert.equal(body.max_completion_tokens, 40);
    assert.ok(body.messages.some((m: { content: string }) => m.content.includes("viewer0: KEKW lol")));
    fetchHelpers.fetchMock.mock.restore();
  });

  test("non-2xx → rejects with status (service then teaser-falls-back)", async () => {
    const { fetchMock } = fakeFetch("rate limited", { ok: false, status: 429 });
    const client = new OpenAIHeadlineClient("sk-test");
    await assert.rejects(() => client.synthesize(ctx(["hi"]), { reason: "velocity", windowMs: 1_000 }), /429/);
    fetchMock.mock.restore();
  });

  test("empty choices → rejects", async () => {
    const { fetchMock } = fakeFetch({ choices: [] });
    const client = new OpenAIHeadlineClient("sk-test");
    await assert.rejects(() => client.synthesize(ctx(["hi"]), { reason: "velocity", windowMs: 1_000 }));
    fetchMock.mock.restore();
  });
});

// --- helpers ---------------------------------------------------------------

let lastInit: RequestInit | undefined;

function fakeFetch(payload: unknown, opts: { ok?: boolean; status?: number } = {}) {
  const fetchMock = mock.method(
    globalThis,
    "fetch",
    async (_url: unknown, init: RequestInit) => {
      lastInit = init;
      if (opts.ok === false) {
        return new Response("ratelimited", { status: opts.status ?? 429 });
      }
      return new Response(JSON.stringify(payload), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    },
  );
  return { fetchMock, get lastInit() { return lastInit; } };
}
