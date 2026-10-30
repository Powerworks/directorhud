# DirectorHUD — Event Model (Phase 1 core loop)

Modeled per the vault's Event-Driven Systems discipline:
**Commands (intent) → Events (facts) → Read Projections (views).**

```
                 ┌──────────────────────────┐
 stream in ─────►│  C: processMessage       │         READ PROJECTIONS
 (event time)    │     C: forceCloseCurrent │────────►  P1: WindowSnapshot
                 │     (end-of-stream)      │         P2: armed / windowsIncorporated
                 └─────────────┬────────────┘         P3: current window MPS/density
                               │  EVENTS
                               ▼
                 ┌──────────────────────────┐
                 │  E: MessageIngested*     │
                 │  E: WindowClosed         │  (each bucket in, baseline updated)
                 │  E: SpikeDetected        │◄─────── ┌──────────────
                 └──────────────────────────┘        │ downstream
                                  │                  ▼
                                  ▼          Phase 2: WebSocket → HUD ticker
                       60s context backfill     Phase 2: Codex headline prompt
                                  │
                                  ▼
                       Phase 3: FFmpeg filtergraph cmd → child_process → mp4
```

\* implicit (bucket counters move as messages arrive — no listener noise).

## Lifetime of a SpikeDetected

```
 E.SpikeDetected {
   firedAt,                  // close of triggering window (event time)
   windowIndex / windowStart / windowEnd,
   messageCount, mps,        // window statistics
   baselineMPS,              // pre-update EWMA
   emoteDensity,
   reason: "velocity" | "emote_density",
   triggerRatio,
   context: ChatMessage[]    // ≤60s backfill, ≤500 msgs
 }
```

## Command/Event acceptance matrix

| Command              | Given                       | When                          | Event emitted                |
| -------------------- | --------------------------- | ----------------------------- | ---------------------------- |
| processMessage(m)    | bucket filled, next arrives | bucket closes                 | WindowClosed (internal)      |
| processMessage(m)    | armed, window MPS > 3×base  | bucket assessed               | SpikeDetected(reason=velocity)|
| processMessage(m)    | armed, density ≥ 2.5        | bucket assessed               | SpikeDetected(reason=density)|
| forceCloseCurrent(t) | trailing window open        | stream end / shutdown poll    | SpikeDetected (partial span) |
| processMessage(m)    | windows < warmup            | any                           | none (calibration only)      |

## Notes

- A window can emit **at most one** `SpikeDetected` (per-bucket refractory).
- `WindowClosed` folds window MPS into the EWMA **after** judgement, so the
  baseline can only lag a genuine regime change by ≈1/α windows.
- No clocks anywhere: every timestamp in the model is event time from the
  message stream; `forceCloseCurrent` is the only wall-clock touchpoint,
  needed because the *last* window never gets a closing arrival.
