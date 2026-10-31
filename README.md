# DirectorHUD

An autonomous broadcast director for Twitch. Detects chat spikes in real time,
flashes an on-stream HUD alert with an 8–12 word AI headline, and drives a
Codex-generated FFmpeg filtergraph that slices/reframes/burns captions onto
vertical clips ready for TikTok.

**TwitchCon Hackathon 2026.** Repository companion to the project brief in the
Obsidian vault (`Scoopy/`).

- Submission site (register here): <https://twitchcon-codex.devpost.com/>
- Rules: <https://twitchcon-codex.devpost.com/rules>
- Deadline: **Nov 2, 2026, 2:00 PM PT** · Judging Nov 5–15 · Winners at TwitchCon San Diego ~Nov 15
- Codex use is a Stage-One pass/fail requirement AND 25% of the score
  ("Technological implementation") — keep the Codex CLI session ID from
  `/status` for the submission form, plus video footage of it in action.

## Judging criteria (equally weighted, Stage Two)

| Criterion | What wins it |
| --------- | ------------ |
| Innovation/Idea | Novel concept — not a rebuild of the listed example directions |
| Potential Impact | Real streamer/raid usage, not an empty test channel |
| Technological implementation | Build quality **+ how well Codex is used** (session ID is the evidence) |
| Design | Easy to use, fun to watch; one-word commands beat forms on stream |

```
[ Twitch Chat ] ──► [ Spike Detector (this repo) ] ──► Sparkline: MPS, density
                            │  1. ∀ window: velocity > K×baseline
                            │                    OR density ≥ D
                            ▼
                   SpikeDetected event + 60s chat context
                            │
                            ▼
                 Phase 2: Codex headline + WebSocket HUD
                 Phase 3: Codex FFmpeg filtergraph → mp4
```

## Stack (Phase 1)

| Concern              | Choice                                  | Why                                                        |
| -------------------- | --------------------------------------- | ---------------------------------------------------------- |
| Runtime              | Node.js ≥ 22.18, native TS type-stripping | No ts-node/esbuild in the hot path; zero-config.           |
| Language             | TypeScript 5.9 (strict, erasable-only)  | Same discipline as the production playbooks.               |
| Twitch ingest        | `tmi.js` (IRC) behind `ChatProvider`    | EventSub webhook needs a public URL; IRC is loopback-ready. |
| Mock ingest          | Seeded synthetic stream (`mulberry32`)  | Deterministic replay for tests and demos.                  |
| Headline (Phase 2)   | OpenAI chat completions (fetch)         | Cheapest model by default; teaser fallback always works.  |
| HUD (Phase 2)        | Single-file overlay + `ws` WebSocket f/s  | One Asset, one terminal page, zero build step.           |
| Tests                | `node:test` + `assert/strict`           | Built in — no Vitest/Jest dependency.                      |
| CI smoke gate        | `npm run demo`                          | Seeded 120s stream must fire exactly 2 spikes or exit ≠0.   |
| Build                | `tsc` → `dist/`                         | Optional; the sources run natively.                        |

## Quickstart

```bash
git clone <repo> directorhud && cd directorhud
npm install

npm test           # 64 acceptance tests, ~3s, fully deterministic
npm run demo       # headless 120s simulation → smoke gate (exit 0 = PASS)
npm run build      # tsc → dist/ (optional)
npm start          # provider=auto (mock unless Twitch creds in .env)

# OBS Browser Source (HUD overlay): http://localhost:8788/ — 1920×1080,
# local file caching OFF. The overlay shows a labeled LOCAL DEMO loop when
# disconnected — never stream with the server down.
```

Node 22.18+ required (type-stripping is on-by-default there).
`.env` keys: `TWITCH_CHANNEL`, `TWITCH_OAUTH`, `TWITCH_BOT_NAME`, `OPENAI_API_KEY`,
`OPENAI_MODEL` (default `gpt-4o-mini`), `DIRECTORHUD_HUD_PORT` (8788),
detector tunables (`DIRECTORHUD_WINDOW_MS`, `_WARMUP_WINDOWS`, `_EWMA_ALPHA`,
`_VELOCITY_K`, `_EMOTE_DENSITY_MIN`, `_CONTEXT_MS`).

Node 22.18+ required (type-stripping is on-by-default there).

## Phase map (per the brief)

| Phase | Milestone                        | Status        |
| ----- | -------------------------------- | ------------- |
| 1     | Spike detection & Twitch ingest  | ✅ committed `b878795` |
| 2     | Codex headline + HUD frontend    | ✅ done — API path + teaser fallback + overlay |
| 3     | FFmpeg generation & pipeline     | ✅ done — Codex-generated filtergraph + deterministic fallback, opt-in via `DIRECTORHUD_RECORDING_PATH` (see `docs/adr/002`) |
| 4     | E2E in OBS, polish               | 🔜 due Sun EOD |
| 5     | Demo video & repo packaging      | 🔜 due Mon EOD |
| 6     | Submission (Nov 2, 2PM PT)       | 🔜 due Mon morning |

## Phase 2 pipeline (now live)

`provider → SpikeDetector → SpikeDetected → HeadlineService → ws → overlay`

- **Headline** — OpenAI chat completions over the 60s context (model selectable,
  cheapest-class default). **Every** failure or short payload degrades to a
  deterministic teaser so a live demo cannot hang on the API. Sanitization
  strips C0/DEL control chars before anything reaches the HUD; the overlay
  writes DOM via `textContent` only — hostile chat text can never become markup.
- **HUD** — 1920×1080 dark overlay, ticker band, reason pill (VELOCITY /
  EMOTE STORM), mps/baseline/ratio strip, 4.5s pill auto-hide. Protocol:
  `WS /events` JSON frame per spike.

Submission-relevant notes locked at the top of this README: Devpost link, the
Codex CLI free tier for Sunday's evidence session, and that demos must show
real Twitch (the mock is dev-only).

## Detector contract (acceptance criteria)

Implemented as `Given/When/Then` in `test/spikeDetector.test.ts` — deterministic,
timer-free, hand-verified arithmetic:

1. **GIVEN** a 4 msg/s baseline — WHEN 2x (8 msg/s) traffic lasts a window —
   THEN nothing fires.
2. **GIVEN** baseline 4 — WHEN a window hits exactly 3.0x — THEN nothing
   fires (strict inequality).
3. **GIVEN** baseline 4 — WHEN a window hits 4x — THEN one `SpikeDetected`
   with `reason="velocity"`, `mps=16`, `baselineMPS=4`.
4. **GIVEN** baseline velocity — WHEN a window is 3+ emotes/message — THEN
   `reason="emote_density"` with `mps` left at baseline.
5. **GIVEN** both conditions at once — THEN velocity wins (documented
   precedence).
6. **GIVEN** the calibration phase — THEN nothing fires and `armed` flips
   exactly at `warmupWindows` closed windows.
7. **GIVEN** a sustained burst — THEN it fires once; the EWMA baseline
   adapts (`4 → 7.6 → 10.1…`) and a second burst only re-fires after
   recovery toward baseline.
8. **GIVEN** a closed window — THEN the event carries the 60s backfill
   projection (context), timezone- and wall-clock-free (event time only).
9. **GIVEN** a trailing partial window at stream end — THEN `forceCloseCurrent`
   evaluates it at honest partial span, exactly once.
10. **GIVEN** bucket-boundary traffic — THEN attribution to the correct
    window is exact (no off-by-one drift).

## Configuration

`.env` (never commit) — see `.env.example`. Provider selection, Twitch
credentials, and six detector tunables (`windowMs`, `warmupWindows`,
`ewmaAlpha`, `velocityThreshold`, `emoteDensityThreshold`, `contextBackfillMs`).

## Architecture notes

- **Event time, not processing time.** `t0` anchors at the first message;
  bucket boundaries are derived pure functions of message timestamps. The
  detector has no timers and no wall clock — replay any recorded stream and
  you get byte-identical events.
- **Baseline lies downstream of judgement.** A window is compared against
  the pre-update EWMA, then folded in — otherwise bursts would mask
  themselves.
- **Per-window refractory.** A bucket fires at most once; adaptation handles
  suppression, not mutable state hacks.
- See `docs/adr/001-sliding-window-spike-detection.md` and
  `docs/event-model.md` for the modeling record.
