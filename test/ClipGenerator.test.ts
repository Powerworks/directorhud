/**
 * ClipGenerator tests — ffmpeg invocation shape, offset/clamp math, and the
 * manifest write, over an INJECTED fake spawnFn (no real ffmpeg/codex
 * subprocess in the test suite).
 */
import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import type { ChildProcess } from "node:child_process";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ClipGenerator, DEFAULT_CLIP_CONFIG, type ClipConfig } from "../src/clip/ClipGenerator.ts";
import type { SpawnFn } from "../src/clip/filtergraph.ts";
import type { SpikeDetected } from "../src/domain/events.ts";

function fakeFfmpegSpawnFn(exitCode: number, onArgs: (args: string[]) => void): SpawnFn {
  return (_bin: string, args: string[]) => {
    onArgs(args);
    const child = new EventEmitter() as EventEmitter & { stderr: EventEmitter };
    child.stderr = new EventEmitter();
    queueMicrotask(() => child.emit("close", exitCode));
    return child as unknown as ChildProcess;
  };
}

const spike: SpikeDetected = {
  type: "SpikeDetected",
  firedAt: 100_000,
  windowIndex: 3,
  windowStart: 90_000,
  windowEnd: 100_000,
  messageCount: 40,
  mps: 16,
  baselineMPS: 4,
  emoteDensity: 1,
  reason: "velocity",
  triggerRatio: 4,
  context: [],
};

function makeConfig(dir: string): ClipConfig {
  return {
    ...DEFAULT_CLIP_CONFIG,
    recordingPath: `${dir}/recording.mp4`,
    recordingStartedAt: 0,
    outputDir: dir,
    manifestPath: join(dir, "clip-manifest.jsonl"),
  };
}

describe("ClipGenerator", () => {
  test("builds ffmpeg args with the pre-roll-clamped offset and writes the manifest", async () => {
    const dir = mkdtempSync(join(tmpdir(), "directorhud-clip-"));
    const config = makeConfig(dir);
    let capturedArgs: string[] = [];

    const gen = new ClipGenerator(config, null, fakeFfmpegSpawnFn(0, (a) => (capturedArgs = a)));
    const result = await gen.generate(spike, "Chat ignites now");

    // firedAt=100_000, recordingStartedAt=0, preRollMs=15_000 → offset 85s.
    assert.equal(capturedArgs[capturedArgs.indexOf("-ss") + 1], "85.000");
    assert.equal(
      capturedArgs[capturedArgs.indexOf("-t") + 1],
      ((DEFAULT_CLIP_CONFIG.preRollMs + DEFAULT_CLIP_CONFIG.postRollMs) / 1000).toFixed(3),
    );
    assert.ok(capturedArgs.includes("-vf"));
    assert.equal(result.filtergraphSource, "fallback");
    assert.equal(result.codexSessionId, null);

    const manifestLines = readFileSync(config.manifestPath, "utf8").trim().split("\n");
    assert.equal(manifestLines.length, 1);
    const entry = JSON.parse(manifestLines[0]) as { outputPath: string; windowIndex: number };
    assert.equal(entry.windowIndex, 3);
    assert.equal(entry.outputPath, result.outputPath);
  });

  test("clamps the start offset to 0 when the pre-roll would go negative", async () => {
    const dir = mkdtempSync(join(tmpdir(), "directorhud-clip-"));
    const config = { ...makeConfig(dir), recordingStartedAt: 0 };
    let capturedArgs: string[] = [];

    const earlySpike: SpikeDetected = { ...spike, firedAt: 1_000 }; // less than preRollMs after start
    await new ClipGenerator(config, null, fakeFfmpegSpawnFn(0, (a) => (capturedArgs = a))).generate(
      earlySpike,
      "early",
    );

    assert.equal(capturedArgs[capturedArgs.indexOf("-ss") + 1], "0.000");
  });

  test("propagates an ffmpeg failure", async () => {
    const dir = mkdtempSync(join(tmpdir(), "directorhud-clip-"));
    const config = makeConfig(dir);

    await assert.rejects(
      new ClipGenerator(config, null, fakeFfmpegSpawnFn(1, () => {})).generate(spike, "boom case"),
      /ffmpeg exited 1/,
    );
  });

  test("uses the Codex filtergraph client's session id when it succeeds", async () => {
    const dir = mkdtempSync(join(tmpdir(), "directorhud-clip-"));
    const config = makeConfig(dir);

    const result = await new ClipGenerator(
      config,
      { generate: async () => ({ filtergraph: "scale=1:1", codexSessionId: "sid-42" }) },
      fakeFfmpegSpawnFn(0, () => {}),
    ).generate(spike, "codex path");

    assert.equal(result.filtergraphSource, "codex");
    assert.equal(result.codexSessionId, "sid-42");
  });
});
