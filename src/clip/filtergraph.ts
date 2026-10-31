/**
 * Filtergraph generation — turning a clip's caption + target geometry into
 * an FFmpeg `-vf` filtergraph via the Codex CLI.
 *
 * Pipeline safety rule (same as the Phase 2 headline layer): the Codex call
 * is a *decoration*, never a blocker. Every failure mode (CLI missing,
 * timeout, malformed JSON, non-zero exit) degrades to a deterministic
 * hand-built filtergraph so clip export can never hang or silently drop a
 * clip waiting on a model call.
 */
import { spawn as nodeSpawn, type ChildProcess } from "node:child_process";

/** Test seam — the real `node:child_process.spawn` export isn't configurable, so mocks inject this instead. */
export type SpawnFn = (command: string, args: string[], options?: Record<string, unknown>) => ChildProcess;

export interface ClipGeometry {
  readonly width: number;
  readonly height: number;
}

export const TIKTOK_GEOMETRY: ClipGeometry = { width: 1080, height: 1920 };

export interface FiltergraphRequest {
  readonly caption: string;
  readonly geometry: ClipGeometry;
  readonly sourceWidth: number;
  readonly sourceHeight: number;
}

export interface FiltergraphResult {
  readonly filtergraph: string;
  readonly source: "codex" | "fallback";
  /** Codex CLI session id, when the primary path produced one — submission evidence. */
  readonly codexSessionId: string | null;
}

export interface FiltergraphClient {
  generate(req: FiltergraphRequest): Promise<{ filtergraph: string; codexSessionId: string }>;
}

/** Escapes text for safe embedding inside an FFmpeg `drawtext` filter argument. */
export function escapeDrawtext(raw: string): string {
  return raw
    .replace(/\\/g, "\\\\")
    .replace(/:/g, "\\:")
    .replace(/'/g, "\\'")
    .replace(/%/g, "\\%");
}

/** Deterministic fallback — center-crop to target aspect + burned caption. */
export function buildFallbackFiltergraph(req: FiltergraphRequest): string {
  const { geometry, sourceWidth, sourceHeight } = req;
  const targetRatio = geometry.width / geometry.height;
  const sourceRatio = sourceWidth / sourceHeight;
  // Crop to the target aspect ratio first (centered), then scale exactly —
  // avoids letterboxing/pillarboxing on a vertical target.
  const cropFilter =
    sourceRatio > targetRatio
      ? `crop=ih*${targetRatio}:ih:(iw-ih*${targetRatio})/2:0`
      : `crop=iw:iw/${targetRatio}:0:(ih-iw/${targetRatio})/2`;
  const text = escapeDrawtext(req.caption);
  return (
    `${cropFilter},scale=${geometry.width}:${geometry.height},` +
    `drawtext=text='${text}':fontcolor=white:fontsize=56:` +
    `box=1:boxcolor=black@0.6:boxborderw=16:x=(w-text_w)/2:y=h-220`
  );
}

const SYSTEM_PROMPT = `You generate a single FFmpeg video filtergraph for DirectorHUD, a
TwitchCon hackathon broadcast director. Given a source resolution, a target
vertical resolution, and a caption, respond with ONLY a JSON object of the
exact shape {"filtergraph": "<ffmpeg -vf argument string>"} — no prose, no
markdown fences. The filtergraph must: crop the source to the target aspect
ratio (centered crop, no letterboxing), scale to the exact target
width/height, and burn the caption in via drawtext (white text, dark
semi-transparent box behind it, centered horizontally, positioned in the
lower third). Escape the caption correctly for FFmpeg's drawtext syntax.`;

/** Invokes the Codex CLI non-interactively to generate one filtergraph. */
export class CodexFiltergraphClient implements FiltergraphClient {
  readonly timeoutMs: number;
  readonly binary: string;
  readonly spawnFn: SpawnFn;

  constructor(timeoutMs = 20_000, binary = "codex", spawnFn: SpawnFn = nodeSpawn) {
    this.timeoutMs = timeoutMs;
    this.binary = binary;
    this.spawnFn = spawnFn;
  }

  async generate(
    req: FiltergraphRequest,
  ): Promise<{ filtergraph: string; codexSessionId: string }> {
    const prompt = `${SYSTEM_PROMPT}

Source resolution: ${req.sourceWidth}x${req.sourceHeight}
Target resolution: ${req.geometry.width}x${req.geometry.height}
Caption: ${req.caption}`;

    const { stdout } = await this.run(["exec", "--json", "--skip-git-repo-check", prompt]);

    // Real `codex exec --json` JSONL schema (verified against codex-cli 0.149.1):
    //   {"type":"thread.started","thread_id":"<uuid>"}
    //   {"type":"item.completed","item":{"type":"agent_message","text":"..."}}
    // Non-JSON lines (e.g. an interactive "Reading additional input..." notice)
    // are skipped rather than crashing the parse.
    let sessionId: string | null = null;
    let lastMessage: string | null = null;
    for (const line of stdout.split("\n")) {
      if (!line.trim()) continue;
      let event: unknown;
      try {
        event = JSON.parse(line);
      } catch {
        continue;
      }
      if (typeof event !== "object" || event === null) continue;
      const e = event as Record<string, unknown>;
      if (e.type === "thread.started" && typeof e.thread_id === "string") {
        sessionId = e.thread_id;
      }
      if (e.type === "item.completed") {
        const item = e.item as Record<string, unknown> | undefined;
        if (item?.type === "agent_message" && typeof item.text === "string") {
          lastMessage = item.text;
        }
      }
    }

    if (!lastMessage) throw new Error("codex exec produced no final message");
    if (!sessionId) throw new Error("codex exec produced no session id");

    const parsed = extractFiltergraphJson(lastMessage);
    return { filtergraph: parsed, codexSessionId: sessionId };
  }

  private run(args: string[]): Promise<{ stdout: string; code: number }> {
    return new Promise((resolve, reject) => {
      const child = this.spawnFn(this.binary, args, { stdio: ["ignore", "pipe", "pipe"] });
      let stdout = "";
      let stderr = "";
      const timer = setTimeout(() => {
        child.kill("SIGKILL");
        reject(new Error(`codex exec timed out after ${this.timeoutMs}ms`));
      }, this.timeoutMs);

      child.stdout?.on("data", (d: Buffer) => (stdout += d.toString("utf8")));
      child.stderr?.on("data", (d: Buffer) => (stderr += d.toString("utf8")));
      child.on("error", (err) => {
        clearTimeout(timer);
        reject(err);
      });
      child.on("close", (code) => {
        clearTimeout(timer);
        if (code !== 0) {
          reject(new Error(`codex exec exited ${code}: ${stderr.slice(0, 500)}`));
          return;
        }
        resolve({ stdout, code: code ?? 0 });
      });
    });
  }
}

/** Pulls the `filtergraph` field out of the model's final message, tolerating markdown fences. */
export function extractFiltergraphJson(raw: string): string {
  const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const candidate = fenced?.[1] ?? raw;
  const parsed = JSON.parse(candidate.trim()) as { filtergraph?: unknown };
  if (typeof parsed.filtergraph !== "string" || !parsed.filtergraph.trim()) {
    throw new Error("codex response missing non-empty filtergraph field");
  }
  return parsed.filtergraph;
}

/** Never rejects: falls through to the deterministic filtergraph on any Codex failure. */
export async function resolveFiltergraph(
  client: FiltergraphClient | null,
  req: FiltergraphRequest,
): Promise<FiltergraphResult> {
  if (client !== null) {
    try {
      const { filtergraph, codexSessionId } = await client.generate(req);
      return { filtergraph, source: "codex", codexSessionId };
    } catch (error) {
      process.stderr.write(`[clip] codex filtergraph failed, using fallback: ${String(error)}\n`);
    }
  }
  return { filtergraph: buildFallbackFiltergraph(req), source: "fallback", codexSessionId: null };
}
