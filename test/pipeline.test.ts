/**
 * Pipeline integration — synthetic 40s stream through the real detector +
 * teaser headline service; assert the HUD sees the full composed event.
 */
import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { makeChatMessage } from "../src/domain/chatMessage.ts";
import { HeadlineService } from "../src/headline/headline.ts";
import { createPipeline } from "../src/pipeline.ts";
import { createServer, type Server } from "node:http";
import { WebSocket } from "ws";

const T0 = 60_000_000;

function steady(offsetSec: number, msgs: number, seconds: number, res: { text?: string; tag?: string } = {}): ReturnType<typeof makeChatMessage>[] {
  const out = [];
  for (let s = 0; s < seconds; s++) {
    for (let i = 0; i < msgs; i++) {
      out.push(makeChatMessage({
        timestamp: T0 + (offsetSec + s) * 1000 + Math.floor((i * 1000) / msgs),
        channel: "pwrkns",
        author: `viewer${i % 7}`,
        text: res.text ?? "lol",
        emotesTag: res.tag ?? "",
      }));
    }
  }
  return out;
}

// 1s windows, warmup 2, 10s → armed at win2
const CFG = { windowMs: 1_000, warmupWindows: 2 };

describe("createPipeline end-to-end", () => {
  test("velocity spike → HUD receives teaser-composed event (no API key)", async () => {
    const server = createServer();
    const { attachHud } = await import("../src/hud/server.ts");
    const hud = attachHud(server);
    await new Promise<void>((r) => server.listen(0, () => r()));
    const addr = server.address();
    const port = typeof addr === "object" && addr !== null ? addr.port : 0;

    const seen: unknown[] = [];
    const ws = new WebSocket(`ws://127.0.0.1:${port}/events`);
    ws.on("message", (d) => seen.push(JSON.parse(String(d))));
    await new Promise<void>((resolve, reject) => {
      ws.once("open", () => resolve());
      ws.once("error", reject);
    });

    const svc = new HeadlineService(null);
    const pipeline = createPipeline({ config: CFG, headline: svc, hud, onSpike: () => undefined });

    const stream = [
      ...steady(0, 4, 2), // calibrate wins 0,1
      ...steady(2, 16, 1), // burst win2 — 4x
      ...steady(3, 4, 1), // closes win2
    ];
    for (const m of stream) pipeline.onChat(m);
    await new Promise((r) => setTimeout(r, 100));

    assert.equal(seen.length, 1);
    const ev = seen[0] as {
      type: string;
      headline: string;
      reason: string;
      mps: number;
      baselineMPS: number;
      triggerRatio: number;
    };
    assert.equal(ev.type, "spike");
    assert.equal(ev.reason, "velocity");
    assert.equal(ev.mps, 16);
    assert.equal(ev.triggerRatio, 4);
    assert.ok(Math.abs(ev.baselineMPS - 4) < 1e-9);
    assert.match(ev.headline, /storm/i);
    ws.close();
    server.closeAllConnections();
    await new Promise<void>((r) => server.close(() => r()));
  });

  test("flush folds the trailing window into stats", () => {
    const noHud = createPipeline({ config: CFG, headline: new HeadlineService(null), hud: null });
    for (const m of [...steady(0, 4, 2), ...steady(2, 12, 2)]) noHud.onChat(m);
    noHud.flush();
    const s = noHud.detector.snapshot();
    assert.equal(s.windowIndex, 3);
    assert.ok(s.mps > 0);
  });
});
