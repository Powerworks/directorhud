# ADR-002: Codex-generated FFmpeg filtergraph, local-recording source

**Status:** Accepted — Phase 3 implementation (2026-10-31).
**Context:** TwitchCon hackathon timeline (submission Nov 2, 2:00 PM PT);
Codex use is a Stage-One pass/fail requirement AND 25% of score
("Technological implementation"), with the Codex CLI session ID required
as submission evidence.

## Decision

**Video source:** DirectorHUD does not capture Twitch video itself. It
assumes OBS (already running for the HUD Browser Source) is set to record
continuously to a local file (standard OBS feature — Settings → Output →
Recording). `ClipGenerator` slices a clip from that file by **timestamp
offset** — `spike.firedAt` minus a pre-roll window, for a configured
duration — using `ffmpeg -ss <offset> -t <duration>`. No separate
Twitch-side video ingest, no VOD download, no extra process.

**Filtergraph generation:** on each spike, `CodexFiltergraphClient` shells
out to `codex exec` (non-interactive, `--json` + `--output-last-message`)
with the spike's headline/caption text and target geometry (1080×1920,
TikTok-ready), asking for an FFmpeg `-vf` filtergraph string that
crops/scales to vertical and burns the caption via `drawtext`. The Codex
CLI session ID from the JSONL event stream is captured into
`clip-manifest.jsonl` — the exact artifact the hackathon's Stage-One
check and scoring need.

**Fallback:** identical pipeline-safety rule as the Phase 2 headline
layer — Codex is a decoration, never a blocker. A deterministic,
hand-built filtergraph (center-crop to 1080×1920 + `drawtext` with the
same caption, escaped) fires on any Codex failure (missing CLI, timeout,
malformed output, non-zero exit), so a live demo can never hang or
silently drop a clip waiting on a model call.

## Considered alternatives

| Option | Verdict | Why |
| ------ | ------- | --- |
| DirectorHUD captures Twitch video directly (streamlink/EventSub clip API) | Rejected | New external dependency + Twitch API scope under deadline; OBS is already in the loop for the HUD overlay — reuse it. |
| Hand-written filtergraph only, no Codex involvement in Phase 3 | Rejected | Fails the hackathon's Stage-One Codex requirement outright — Codex use is pass/fail, not optional polish. |
| Codex call is synchronous/blocking in the hot chat-ingest path | Rejected | Same reasoning as Phase 2 — ffmpeg + Codex can take seconds; the detector/HUD path must never stall on it. |
| Full video analysis (scene detection, face tracking) to drive the crop | Deferred | Real production feature, not a 2-day hackathon scope; center-crop is an honest v1. |

## Consequences

- **New operational requirement:** OBS must have continuous local
  recording enabled before a session, or clip generation has nothing to
  slice — this needs to be in the demo-day runbook, not just code.
- **Clip timing is approximate**, not frame-exact: it trusts the
  recording file's start wall-clock time matches `Date.now()` on the same
  machine (true for the solo-streamer/single-laptop setup this hackathon
  targets; would need timecode sync for a multi-machine rig).
- **`clip-manifest.jsonl`** becomes the audit trail for both the
  submission (Codex session IDs) and debugging (which spike → which clip
  → which filtergraph, success or fallback).
