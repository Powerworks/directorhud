/**
 * Filtergraph layer tests — fallback filtergraph shape, JSON extraction,
 * and the CodexFiltergraphClient over a MOCKED child_process.spawn (no
 * real `codex exec` subprocess in the test suite).
 */
import { describe, test, mock } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import type { ChildProcess } from "node:child_process";
import {
  buildFallbackFiltergraph,
  CodexFiltergraphClient,
  escapeDrawtext,
  extractFiltergraphJson,
  resolveFiltergraph,
  TIKTOK_GEOMETRY,
  type SpawnFn,
} from "../src/clip/filtergraph.ts";

describe("escapeDrawtext", () => {
  test("escapes backslash, colon, quote, percent", () => {
    assert.equal(escapeDrawtext(`a:b\\c'd%e`), `a\\:b\\\\c\\'d\\%e`);
  });
});

describe("buildFallbackFiltergraph", () => {
  test("produces crop + scale to exact target + drawtext with the caption", () => {
    const out = buildFallbackFiltergraph({
      caption: "Chat ignites now",
      geometry: TIKTOK_GEOMETRY,
      sourceWidth: 1920,
      sourceHeight: 1080,
    });
    assert.match(out, /^crop=/);
    assert.ok(out.includes("scale=1080:1920"));
    assert.ok(out.includes("drawtext="));
    assert.ok(out.includes("Chat ignites now"));
  });
});

describe("extractFiltergraphJson", () => {
  test("parses a plain JSON object", () => {
    assert.equal(extractFiltergraphJson('{"filtergraph":"scale=1080:1920"}'), "scale=1080:1920");
  });

  test("tolerates a markdown-fenced response", () => {
    const raw = '```json\n{"filtergraph":"scale=1080:1920"}\n```';
    assert.equal(extractFiltergraphJson(raw), "scale=1080:1920");
  });

  test("throws on a missing filtergraph field", () => {
    assert.throws(() => extractFiltergraphJson('{"other":"x"}'));
  });

  test("throws on an empty filtergraph field", () => {
    assert.throws(() => extractFiltergraphJson('{"filtergraph":""}'));
  });
});

/** Fakes a ChildProcess emitting the real `codex exec --json` line shape. */
function fakeChildProcess() {
  const child = new EventEmitter() as EventEmitter & {
    stdout: EventEmitter;
    stderr: EventEmitter;
    kill: (signal?: string) => void;
  };
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.kill = mock.fn();
  return child;
}

function fakeSpawnFn(child: ReturnType<typeof fakeChildProcess>): SpawnFn {
  return () => child as unknown as ChildProcess;
}

describe("CodexFiltergraphClient", () => {
  test("parses thread_id + the final agent_message's filtergraph JSON", async () => {
    const child = fakeChildProcess();

    const promise = new CodexFiltergraphClient(5_000, "codex", fakeSpawnFn(child)).generate({
      caption: "test",
      geometry: TIKTOK_GEOMETRY,
      sourceWidth: 1920,
      sourceHeight: 1080,
    });

    child.stdout.emit(
      "data",
      Buffer.from(
        '{"type":"thread.started","thread_id":"01a192dc-ea78-75a3-b0b2-9e4373941d08"}\n' +
          '{"type":"item.completed","item":{"type":"agent_message","text":"{\\"filtergraph\\":\\"scale=1080:1920\\"}"}}\n',
      ),
    );
    child.emit("close", 0);

    const result = await promise;
    assert.equal(result.filtergraph, "scale=1080:1920");
    assert.equal(result.codexSessionId, "01a192dc-ea78-75a3-b0b2-9e4373941d08");
  });

  test("skips a non-JSON line (e.g. an interactive stdin notice) without crashing", async () => {
    const child = fakeChildProcess();

    const promise = new CodexFiltergraphClient(5_000, "codex", fakeSpawnFn(child)).generate({
      caption: "test",
      geometry: TIKTOK_GEOMETRY,
      sourceWidth: 1920,
      sourceHeight: 1080,
    });

    child.stdout.emit(
      "data",
      Buffer.from(
        "Reading additional input from stdin...\n" +
          '{"type":"thread.started","thread_id":"abc"}\n' +
          '{"type":"item.completed","item":{"type":"agent_message","text":"{\\"filtergraph\\":\\"x\\"}"}}\n',
      ),
    );
    child.emit("close", 0);

    const result = await promise;
    assert.equal(result.filtergraph, "x");
  });

  test("rejects on non-zero exit", async () => {
    const child = fakeChildProcess();

    const promise = new CodexFiltergraphClient(5_000, "codex", fakeSpawnFn(child)).generate({
      caption: "test",
      geometry: TIKTOK_GEOMETRY,
      sourceWidth: 1920,
      sourceHeight: 1080,
    });
    child.stderr.emit("data", Buffer.from("boom"));
    child.emit("close", 1);

    await assert.rejects(promise, /exited 1/);
  });

  test("rejects when no session id is present", async () => {
    const child = fakeChildProcess();

    const promise = new CodexFiltergraphClient(5_000, "codex", fakeSpawnFn(child)).generate({
      caption: "test",
      geometry: TIKTOK_GEOMETRY,
      sourceWidth: 1920,
      sourceHeight: 1080,
    });
    child.stdout.emit(
      "data",
      Buffer.from('{"type":"item.completed","item":{"type":"agent_message","text":"{\\"filtergraph\\":\\"x\\"}"}}\n'),
    );
    child.emit("close", 0);

    await assert.rejects(promise, /no session id/);
  });
});

describe("resolveFiltergraph", () => {
  test("null client → fallback immediately, no codexSessionId", async () => {
    const result = await resolveFiltergraph(null, {
      caption: "hi",
      geometry: TIKTOK_GEOMETRY,
      sourceWidth: 1920,
      sourceHeight: 1080,
    });
    assert.equal(result.source, "fallback");
    assert.equal(result.codexSessionId, null);
  });

  test("client success → codex source + session id passed through", async () => {
    const result = await resolveFiltergraph(
      { generate: async () => ({ filtergraph: "scale=1:1", codexSessionId: "sid-1" }) },
      { caption: "hi", geometry: TIKTOK_GEOMETRY, sourceWidth: 1920, sourceHeight: 1080 },
    );
    assert.equal(result.source, "codex");
    assert.equal(result.filtergraph, "scale=1:1");
    assert.equal(result.codexSessionId, "sid-1");
  });

  test("client throws → falls through to fallback, never rejects", async () => {
    const result = await resolveFiltergraph(
      {
        generate: async () => {
          throw new Error("boom");
        },
      },
      { caption: "hi", geometry: TIKTOK_GEOMETRY, sourceWidth: 1920, sourceHeight: 1080 },
    );
    assert.equal(result.source, "fallback");
  });
});
