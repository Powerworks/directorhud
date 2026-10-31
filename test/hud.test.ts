/**
 * HUD layer tests — real TCP + WebSocket round-trip against the overlay
 * server; the protocol and static asset route only (no browser).
 */
import { describe, test, before, after } from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { WebSocket } from "ws";
import { attachHud, type HudBroadcaster } from "../src/hud/server.ts";

const ASSET_MARKER = /<!doctype html>/i;
const PORT = 18921;

describe("HudBroadcaster + attachHud", () => {
  let server: Server;
  let hud: HudBroadcaster;
  let received: Array<unknown> = [];

  before(async () => {
    server = createServer();
    hud = attachHud(server);
    await new Promise<void>((resolve) => server.listen(PORT, () => resolve()));
  });

  after(async () => {
    for (const ws of hud.clients) ws.terminate();
    hud.wss.close();
    server.closeAllConnections();
    await new Promise<void>((r) => server.close(() => r()));
  });

  function connect(): Promise<WebSocket> {
    const ws = new WebSocket(`ws://127.0.0.1:${PORT}/events`);
    return new Promise((resolve, reject) => {
      ws.once("open", () => resolve(ws));
      ws.once("error", reject);
    });
  }

  test("GET / serves the overlay asset", async () => {
    const res = await fetch(`http://127.0.0.1:${PORT}/`);
    assert.equal(res.status, 200);
    assert.match(await res.text(), ASSET_MARKER);
  });

  test("GET unknown route → 404", async () => {
    const res = await fetch(`http://127.0.0.1:${PORT}/nope`);
    assert.equal(res.status, 404);
  });

  test("broadcast reaches a connected overlay", async () => {
    received = [];
    const ws = await connect();
    await waitFor(() => hud.clients.size >= 1);
    ws.on("message", (data) => received.push(JSON.parse(String(data))));

    hud.broadcast({
      type: "spike",
      firedAt: 1_700_000_000_000,
      windowIndex: 4,
      reason: "velocity",
      mps: 32,
      baselineMPS: 4.1,
      triggerRatio: 7.8,
      headline: "Chat ignites — kekw storm ×9",
      source: "teaser",
    });

    await waitFor(() => received.length === 1);
    const ev = received[0] as {
      type: string;
      headline: string;
      reason: string;
    };
    assert.equal(ev.type, "spike");
    assert.equal(ev.headline, "Chat ignites — kekw storm ×9");
    assert.equal(ev.reason, "velocity");
    ws.close();
    await waitFor(() => hud.clients.size === 0);
  });

  test("disconnected client is dropped from the set", async () => {
    const before = hud.clients.size;
    const ws = await connect();
    await waitFor(() => hud.clients.size === before + 1);
    ws.close();
    await waitFor(() => hud.clients.size === before);
  });
});

async function waitFor(cond: () => boolean, timeoutMs = 1_500): Promise<void> {
  const t0 = Date.now();
  while (!cond()) {
    if (Date.now() - t0 > timeoutMs) throw new Error("waitFor timed out");
    await new Promise((r) => setTimeout(r, 10));
  }
}
