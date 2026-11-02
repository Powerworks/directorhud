# Runbook — Demo day (Sun 2026-11-01)

## Pre-stream checklist (do this BEFORE opening OBS or the app)

- [ ] `cp .env.example .env` filled in:
  - `TWITCH_CHANNEL`, `TWITCH_OAUTH`, `TWITCH_BOT_NAME` (user-keyed channel)
  - `OPENAI_API_KEY` → used by both the headline layer and the Codex CLI
  - `DIRECTORHUD_RECORDING_PATH` pointing at OBS's continuous recording file
    (absolute path to the continuous-recording `.mp4`, e.g. `~/recordings/record.mp4`)
- [ ] Codex CLI authenticated: `codex whoami` succeeds. One sanity
      `codex exec --json "reply ok"` already ran on 2026-10-31 — schema
      verified against 0.149.1.
- [ ] OBS → Settings → Output → Recording: **enable continuous local
      recording** (this is the clip source; without it ClipGenerator has
      nothing to slice — see ADR-002).
- [ ] OBS Browser Source added: `http://localhost:8788/`, 1920×1080,
      local file caching OFF.
- [ ] `npm run demo` passes (64/64 tests) and `npm start` shows the
      HUD overlay URL + connects to the real channel.

## Saturation script (to force visible spikes on real Twitch)

Start the stream, then have ~5-10 viewers mass-send one emote for 10s
(e.g. all type `pog` at once), wait 30s, repeat with a different emote.
Each mass-send should produce an EMOTE STORM or VELOCITY pill on the HUD.

## On spike (what the app does, in order)

1. HUD flashes the Codex/teaser headline (never blocked by API).
2. `codex exec --json` generates the FFmpeg filtergraph (~seconds).
3. `ClipGenerator` slices the spike ± rolls from OBS's continuous
   recording into `clips/` (TikTok 1080×1920).
4. `clip-manifest.jsonl` records spike → clip → filtergraph source →
   **Codex session ID** (submission evidence).

Verify each clip + manifest line while streaming; don't archive first.

## Recording the 3-minute demo video

| Timestamp | Segment |
| --------- | ------- |
| 0:00–0:20 | Cold open: what DirectorHUD is, the problem (manual VOD clipping). |
| 0:20–0:50 | HUD overlay live in OBS on the real stream. |
| 0:50–1:40 | Trigger script: chat saturation → HUD pill + headline, slowed replay of the loop. |
| 1:40–2:20 | Codex Code Engine: show the filtergraph generation + clip export; mention "how we used Codex" in narration. |
| 2:20–2:50 | End result: vertical 1080×1920 clip with burned-in headline. |
| 2:50–3:00 | Recap + Codex session ID visible on screen. |

Rules: must be real Twitch (mock fails the brief), public or unlisted
YouTube, no copyrighted music, < 3 minutes total.

## Post-event (Mon 2026-11-02, before 2:00 PM PT)

- [ ] Upload to YouTube (unlisted or public).
- [ ] Copy Codex session IDs from `clip-manifest.jsonl` into the Devpost entry.
- [ ] Write the "how we used Codex" paragraph (Stage One requirement).
## Ops notes — actual submission-day run (2026-11-02)

- This machine has no sudo; OBS runs via flatpak (com.obsproject.Studio 33),
  launched `flatpak run --command=obs com.obsproject.Studio`.
- Laptop CPU = Core i7-5600U (2C/4T): streaming at 720p30, two x264 encoders
  (stream veryfast 4 Mbps CBR, recording ultrafast 2.5 Mbps fragmented mp4)
  plus transient clip exports — keep overlay sources to GPU-safe nodes only.
- `go-live.sh` (~/directorhud/bin/) drives the whole bring-up: OBS, obs-
  websocket bootstrap (scene, BR/DirectorHUD browser src on :8788, both
  outputs), then `node src/index.ts` in twitch mode. Pauses on missing
  TWITCH_STREAM_KEY / TWITCH_OAUTH.
- ffmpeg has no libx264: clip export probes at runtime (openh264/mpeg4
  fallback, see f86a09c) — verified end-to-end in a full mock run this
  morning: 3 spikes → 3 Codex filtergraphs → 2 clean clips, 1 truncated
  only because the toy recording ended (expected; live file just grows).
- If the live attempt fails, stage B = headless mock demo (same clip
  machinery, mock chat) — brief it honestly as a "repeatability" cut.
