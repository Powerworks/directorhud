/**
 * HUD layer: static overlay for OBS Browser Source + WebSocket fan-out to
 * every connected overlay page.
 *
 *   GET  /            → overlay/index.html  (add as OBS Browser Source)
 *   WS   /events      → JSON protocol, one message per spike
 */
import { createReadStream } from "node:fs";
import { existsSync } from "node:fs";
import type { IncomingMessage, Server, ServerResponse } from "node:http";
import { readFile } from "node:fs/promises";
import { WebSocket, WebSocketServer } from "ws";

export interface HudEvent {
  readonly type: "spike";
  readonly firedAt: number;
  readonly windowIndex: number;
  readonly reason: "velocity" | "emote_density";
  readonly mps: number;
  readonly baselineMPS: number;
  readonly triggerRatio: number;
  readonly headline: string;
  readonly source: "openai" | "teaser";
}

import { fileURLToPath } from "node:url";

const OVERLAY_PATH = fileURLToPath(new URL("./overlay/index.html", import.meta.url));

export class HudBroadcaster {
  readonly clients = new Set<WebSocket>();
  readonly wss: WebSocketServer;

  constructor(wss: WebSocketServer) {
    this.wss = wss;
    wss.on("connection", (ws) => {
      this.clients.add(ws);
      ws.on("close", () => this.clients.delete(ws));
      ws.on("error", () => this.clients.delete(ws));
    });
  }

  broadcast(event: HudEvent): void {
    const payload = JSON.stringify(event);
    for (const ws of this.clients) {
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(payload);
        // eslint-disable-next-line no-console
        process.stdout.write(`[hud] → ${this.clients.size} listener(s): ${event.headline}\n`);
      }
    }
  }
}

/**
 * Wires the overlay asset route and the WS upgrade route onto one HTTP
 * server. Returns the broadcaster for downstream events.
 */
export function attachHud(server: Server, overlayPath: string = OVERLAY_PATH): HudBroadcaster {
  const wss = new WebSocketServer({ noServer: true });

  server.on("upgrade", (req: IncomingMessage, socket, head) => {
    if (req.url === "/events") {
      wss.handleUpgrade(req, socket, head, (ws) => wss.emit("connection", ws, req));
    } else {
      socket.destroy();
    }
  });

  server.on("request", async (req: IncomingMessage, res: ServerResponse) => {
    const urlPath = (req.url ?? "/").split("?")[0];
    if (urlPath !== "/") {
      res.writeHead(404).end("not found");
      return;
    }
    if (!existsSync(overlayPath)) {
      res.writeHead(500).end("overlay asset missing — build the project");
      return;
    }
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    res.write(await readFile(overlayPath));
    res.end();
  });

  return new HudBroadcaster(wss);
}

/** Stream the overlay asset (kept for non-HTTP tooling/tests). */
export function streamOverlay(path: string = OVERLAY_PATH): ReturnType<typeof createReadStream> {
  return createReadStream(path);
}
