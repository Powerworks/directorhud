# ADR-001: Tumbling sliding-window detector with EWMA baseline

**Status:** Accepted — Phase 1 implementation (2026-10-30).
**Context:** TwitchCon hackathon timeline (submission Nov 2); solo-stream
scale (tens to low-hundreds of msgs/s at worst); no infra budget beyond a
laptop and OBS.

## Decision

Detect chat spikes over **tumbling time buckets** (`windowMs = 10s`,
aligned to the stream's first message), comparing window MPS against an
**exponentially weighted moving average (EWMA)** of recent quiet-window MPS,
with a hard velocity trigger at `3.0x` plus a second, independent emote-density
trigger (`≥ 2.5 emote occurrences / message`). First `N=6` windows are a
calibration phase during which no event can fire.

## Considered alternatives

| Option | Verdict | Why |
| ------ | ------- | --- |
| Fixed absolute threshold (e.g. "fires above 50 msg/s always") | Rejected | Channels differ wildly; a startup stream never arms, a big channel cries wolf. |
| Static pre-warm baseline from like-channels | Rejected | Needs config + data you don't have at 2 AM before a deadline; EWMA needs nothing. |
| Sliding window with ms-exact decay | Rejected | O(n) per evaluation without a sorted structure; buckets give O(1) amortized with identical semantics at this scale. |
| Redis/time-series engine (e.g. Redis streams + sorted set) | Rejected | Network dependency, process boundary, deployment cost — for one in-process stream it's architecture astronautics. |
| Statistical outlier detector (median/IQR, z-score) | Deferred | More principled for adversarial distributions; overkill for a demo and harder to explain in a 3-min video. Revisit if a client wants production hardening. |
| ML classifier on text | Rejected at Phase 1 | The brief's Codex layer covers semantic judgement; the detector only raises its hand. |

## Consequences

- **Deterministic** — replay any captured stream, get identical events.
- **Adaptive** — baseline floats with true channel activity, no ops.
- **Two known semantics to be aware of:**
  1. A sustained ≥3x burst fires on its **first** window, then goes quiet
     while EWMA catches up (recovery takes ~10 windows at α=0.3). Correct
     for single highlight moments; visibly lulls on long hype trains.
  2. The emote-density rule has **no adaptation memory** — a sustained
     emote storm re-fires every window. Intended: chronic spam storms
     should keep alarming.
- **Non-goal for now:** global (cross-stream) state, multiple channels per
  process, persistence. Each stream is its own detector instance.
