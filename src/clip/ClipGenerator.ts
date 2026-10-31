/**
 * Clip export — slices a vertical, captioned mp4 out of OBS's local
 * recording for one spike (see docs/adr/002-codex-filtergraph-clip-export.md
 * for the recording-source and Codex-fallback decisions).
 */
import { spawn as nodeSpawn } from "node:child_process";
import { appendFile } from "node:fs/promises";
import type { SpikeDetected } from "../domain/events.ts";
import type { ClipGeometry, FiltergraphClient, SpawnFn } from "./filtergraph.ts";
import { resolveFiltergraph, TIKTOK_GEOMETRY } from "./filtergraph.ts";

export interface ClipConfig {
  /** OBS's continuously-recording local file, sliced by timestamp offset. */
  readonly recordingPath: string;
  /** Recording start time (epoch ms) — must share a clock with the detector. */
  readonly recordingStartedAt: number;
  readonly outputDir: string;
  readonly geometry: ClipGeometry;
  readonly sourceWidth: number;
  readonly sourceHeight: number;
  readonly preRollMs: number;
  readonly postRollMs: number;
  /** Append-only audit trail: spike → clip → filtergraph source → Codex session id. */
  readonly manifestPath: string;
}

export const DEFAULT_CLIP_CONFIG: Omit<
  ClipConfig,
  "recordingPath" | "recordingStartedAt" | "outputDir" | "manifestPath"
> = {
  geometry: TIKTOK_GEOMETRY,
  sourceWidth: 1920,
  sourceHeight: 1080,
  preRollMs: 15_000,
  postRollMs: 10_000,
};

export interface ClipResult {
  readonly outputPath: string;
  readonly filtergraphSource: "codex" | "fallback";
  readonly codexSessionId: string | null;
  readonly startOffsetMs: number;
  readonly durationMs: number;
}

function runFfmpeg(spawnFn: SpawnFn, args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawnFn("ffmpeg", args, { stdio: ["ignore", "ignore", "pipe"] });
    let stderr = "";
    child.stderr?.on("data", (d: Buffer) => (stderr += d.toString("utf8")));
    child.on("error", reject);
    child.on("close", (code) => {
      if (code !== 0) {
        reject(new Error(`ffmpeg exited ${code}: ${stderr.slice(-800)}`));
        return;
      }
      resolve();
    });
  });
}

export class ClipGenerator {
  readonly config: ClipConfig;
  readonly filtergraphClient: FiltergraphClient | null;
  readonly spawnFn: SpawnFn;

  constructor(
    config: ClipConfig,
    filtergraphClient: FiltergraphClient | null,
    spawnFn: SpawnFn = nodeSpawn,
  ) {
    this.config = config;
    this.filtergraphClient = filtergraphClient;
    this.spawnFn = spawnFn;
  }

  async generate(spike: SpikeDetected, caption: string): Promise<ClipResult> {
    const c = this.config;
    const startOffsetMs = Math.max(0, spike.firedAt - c.recordingStartedAt - c.preRollMs);
    const durationMs = c.preRollMs + c.postRollMs;

    const { filtergraph, source, codexSessionId } = await resolveFiltergraph(
      this.filtergraphClient,
      {
        caption,
        geometry: c.geometry,
        sourceWidth: c.sourceWidth,
        sourceHeight: c.sourceHeight,
      },
    );

    const outputPath = `${c.outputDir}/spike-${spike.windowIndex}-${spike.firedAt}.mp4`;
    await runFfmpeg(this.spawnFn, [
      "-y",
      "-ss",
      (startOffsetMs / 1000).toFixed(3),
      "-i",
      c.recordingPath,
      "-t",
      (durationMs / 1000).toFixed(3),
      "-vf",
      filtergraph,
      "-c:v",
      "libx264",
      "-preset",
      "veryfast",
      "-c:a",
      "aac",
      outputPath,
    ]);

    await appendFile(
      c.manifestPath,
      `${JSON.stringify({
        windowIndex: spike.windowIndex,
        firedAt: spike.firedAt,
        outputPath,
        filtergraphSource: source,
        codexSessionId,
        caption,
      })}\n`,
      "utf8",
    );

    return { outputPath, filtergraphSource: source, codexSessionId, startOffsetMs, durationMs };
  }
}
