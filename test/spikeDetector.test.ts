/**
 * SpikeDetector acceptance tests — synthetic chat streams, zero timers.
 * Window = 1s, warmup = 2 windows unless overridden. Baseline built from
 * 4 msg/s windows => 4.0 MPS. Expected values computed by hand and checked
 * against strict inequality semantics (3.0x never fires; 3.000…1x does).
 */
import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { makeChatMessage } from "../src/domain/chatMessage.ts";
import type { ChatMessage } from "../src/domain/chatMessage.ts";
import { SpikeDetector } from "../src/detector/SpikeDetector.ts";
import type { SpikeDetected } from "../src/domain/events.ts";

const T0 = 1_000_000_000_000;
const WINDOW = { windowMs: 1_000, warmupWindows: 2 };

function msg(offsetMs: number, text = "talk", emotesTag = ""): ChatMessage {
  return makeChatMessage({
    timestamp: T0 + offsetMs,
    channel: "pwrkns",
    author: "viewer1",
    text,
    emotesTag,
  });
}

/**
 * `countPerSecond` msgs at deterministic slots inside each window.
 * Slot 0 is exactly on the window start by design: bucket boundaries anchor
 * at t0 (first message ever seen), so synthetic windows must line up flush —
 * otherwise the first slot silently truncates into the earlier bucket.
 */
function steadyMsgs(
  startOffset: number,
  countPerSecond: number,
  seconds: number,
  emotesTag: string = "",
): ChatMessage[] {
  const out: ChatMessage[] = [];
  for (let sec = 0; sec < seconds; sec += 1) {
    for (let i = 0; i < countPerSecond; i += 1) {
      const slot = Math.floor((i * 1000) / countPerSecond);
      out.push(msg(startOffset + sec * 1000 + slot, "talk", emotesTag));
    }
  }
  return out;
}

function runStream(messages: ChatMessage[]): SpikeDetected[] {
  const spikes: SpikeDetected[] = [];
  const d = new SpikeDetector(WINDOW, (e) => spikes.push(e));
  for (const m of messages) d.processMessage(m);
  return spikes;
}

describe("Given a channel with a 4 msg/s baseline", () => {
  test("When 8 msg/s (2x) arrives for a window, Then no spike fires", () => {
    const spikes = runStream([
      ...steadyMsgs(0, 4, 2), // windows 0,1 — calibrate
      ...steadyMsgs(2000, 8, 1),
      ...steadyMsgs(3000, 4, 1), // closes the burst window
    ]);
    assert.deepEqual(spikes, []);
  });

  test("When 12 msg/s (exactly 3x) arrives, Then no spike (strict >)", () => {
    const spikes = runStream([
      ...steadyMsgs(0, 4, 2),
      ...steadyMsgs(2000, 12, 1),
      ...steadyMsgs(3000, 4, 1),
    ]);
    assert.equal(spikes.length, 0);
  });

  test("When 16 msg/s (4x) arrives, Then a velocity spike fires at ratio 4", () => {
    const spikes = runStream([
      ...steadyMsgs(0, 4, 2),
      ...steadyMsgs(2000, 16, 1), // burst lands in window 2
      ...steadyMsgs(3000, 4, 1),  // first arrival of window 3 closes it
    ]);
    assert.equal(spikes.length, 1);
    const s = spikes[0]!;
    assert.equal(s.reason, "velocity");
    assert.equal(s.windowIndex, 2);
    assert.equal(s.messageCount, 16);
    assert.equal(s.mps, 16);
    assert.ok(Math.abs(s.baselineMPS - 4) < 1e-9, `baseline ${s.baselineMPS}`);
    assert.ok(Math.abs(s.triggerRatio - 4) < 1e-9);
    assert.equal(s.windowStart, T0 + 2000);
    assert.equal(s.windowEnd, T0 + 3000);
  });

  test("When 4 msg/s of pure-emote posts arrive, Then an emote-density spike fires", () => {
    const tag = "e:0-3,5-8,10-13"; // 3 emotes per message => density 3.0
    const spikes = runStream([
      ...steadyMsgs(0, 4, 2),
      ...steadyMsgs(2000, 4, 1, tag),
      ...steadyMsgs(3000, 4, 1),
    ]);
    assert.equal(spikes.length, 1);
    const s = spikes[0]!;
    assert.equal(s.reason, "emote_density");
    assert.ok(Math.abs(s.emoteDensity - 3.0) < 1e-9);
    assert.ok(Math.abs(s.mps - 4.0) < 1e-9, "density fires must not fake velocity");
  });

  test("When velocity and density would both fire, Then velocity has precedence", () => {
    const tag = "e:0-3,5-8,10-13";
    const spikes = runStream([
      ...steadyMsgs(0, 4, 2),
      ...steadyMsgs(2000, 16, 1, tag),
      ...steadyMsgs(3000, 4, 1),
    ]);
    assert.equal(spikes.length, 1);
    assert.equal(spikes[0]!.reason, "velocity");
  });

  test("GIVEN warmup=2, WHEN one window closes, THEN unarmed; When two close, THEN armed", () => {
    const bursts: SpikeDetected[] = [];
    const d = new SpikeDetector(WINDOW, (e) => bursts.push(e));
    for (const m of steadyMsgs(0, 4, 2)) d.processMessage(m);
    assert.equal(d.windowsIncorporated, 1, "only win0 closed — win1 is still open");
    assert.equal(d.armed, false);
    for (const m of steadyMsgs(2000, 4, 1)) d.processMessage(m); // closes win1
    assert.equal(d.windowsIncorporated, 2);
    assert.equal(d.armed, true, "warmupWindows=2 means incorporated >= 2 arms it");
    assert.equal(bursts.length, 0, "calibration windows never carry triggers anyway");
  });

  test("When a sustained 4x burst lasts 3 windows, Then it fires once, baseline adapts", () => {
    const bursts: SpikeDetected[] = [];
    const d = new SpikeDetector(WINDOW, (e) => bursts.push(e));
    for (const m of [
      ...steadyMsgs(0, 4, 2),
      ...steadyMsgs(2000, 16, 3), // windows 2,3,4 all burst
      ...steadyMsgs(5000, 4, 1),
    ]) d.processMessage(m);
    assert.equal(bursts.length, 1, "EWMA: 4 -> 7.6 -> 10.12, so 16 never beats 3x again");
  });

  test("When bursts are separated by recovery, Then each re-firing is independent", () => {
    const bursts: SpikeDetected[] = [];
    const d = new SpikeDetector(WINDOW, (e) => bursts.push(e));
    for (const m of [
      ...steadyMsgs(0, 4, 2),
      ...steadyMsgs(2000, 16, 1),
      ...steadyMsgs(3000, 4, 10), // long recovery => baseline back to ~4
      ...steadyMsgs(13_000, 16, 1),
      ...steadyMsgs(14_000, 4, 1),
    ]) d.processMessage(m);
    assert.equal(bursts.length, 2);
    assert.ok(bursts.every((s) => s.reason === "velocity"));
  });

  test("When a burst straddles a window boundary, Then attribution is exact", () => {
    const bursts: SpikeDetected[] = [];
    const d = new SpikeDetector(WINDOW, (e) => bursts.push(e));
    const messages = [
      ...steadyMsgs(0, 4, 1), // window 0: 4 msgs
      // window 1: only 3 msgs (one slot pushed into window 2's territory)
      msg(1125), msg(1375), msg(1625),
      // the boundary message at EXACTLY offset 2000 belongs to window 2:
      msg(2000, "boundary"),
      // window 2: 16 scheduled msgs + that boundary one = 17
      ...steadyMsgs(2000, 16, 1),
      ...steadyMsgs(3000, 4, 1),
    ];
    for (const m of messages) d.processMessage(m);
    assert.equal(bursts.length, 1);
    assert.equal(bursts[0]!.windowIndex, 2);
    assert.equal(bursts[0]!.messageCount, 17, "16 scripted + the exact-boundary msg");
  });
});

describe("Context backfill projection", () => {
  test("GIVEN 4 msg/s for 80s + 4x burst at win76-77, WHEN the burst window closes, THEN context holds ~60s", () => {
    const config = { ...WINDOW, contextBackfillMs: 60_000 };
    const bursts: SpikeDetected[] = [];
    const d = new SpikeDetector(config, (e) => bursts.push(e));
    const messages = [
      ...steadyMsgs(0, 4, 76),
      ...steadyMsgs(76_000, 16, 2),
      ...steadyMsgs(78_000, 4, 2),
    ];
    for (const m of messages) d.processMessage(m);
    assert.equal(bursts.length, 1);
    const s = bursts[0]!;
    const ctx = s.context;
    // Raised at win77 close (≈T0+78_125): context ≤60s back from firedAt
    // plus the raised window itself. Wins 17..77 ≈ 60s×4 + 32 burst msgs.
    const quiet = ctx.filter((m) => m.emoteCount === 0 && m.text === "talk").length;
    assert.ok(quiet >= 230, `expected ~60s of quiet chatter, got ${quiet}`);
    const newest = ctx[ctx.length - 1]!.timestamp;
    assert.ok(newest <= s.firedAt, "no future messages leak into context");
    assert.ok(ctx.every((m) => m.timestamp >= s.firedAt - 61_000));
    assert.ok(ctx[0]!.timestamp < s.firedAt - 58_000, "context really reaches back");
  });
});

describe("forceCloseCurrent — end-of-stream finalization", () => {
  test("GIVEN an open trailing window, WHEN forced, THEN it incorporates exactly once with honest partial MPS", () => {
    const bursts: SpikeDetected[] = [];
    const d = new SpikeDetector(WINDOW, (e) => bursts.push(e));
    for (const m of [...steadyMsgs(0, 4, 2), ...steadyMsgs(2000, 16, 2)]) {
      d.processMessage(m);
    }
    // Window 3 holds 16 msgs (offsets 3000..3937), never closed by arrival.
    assert.equal(d.windowsIncorporated, 3, "wins 0,1,2 closed via arrivals");

    d.forceCloseCurrent(T0 + 3999);
    d.forceCloseCurrent(T0 + 3999);
    assert.equal(d.windowsIncorporated, 4, "force-close is additive exactly once");

    const snap = d.snapshot();
    assert.equal(snap.windowIndex, 3, "snapshot reports the most recent bucket, even open");
    assert.ok(Math.abs(snap.mps - 16) < 1e-6, "grossed over windowMs");
  });

  test("GIVEN no messages, WHEN forceClose, THEN nothing happens", () => {
    const d = new SpikeDetector(WINDOW);
    assert.doesNotThrow(() => d.forceCloseCurrent(T0 + 500));
    assert.equal(d.windowsIncorporated, 0);
  });
});

describe("Snapshot read model", () => {
  test("BEFORE arm, snapshot reports unarmed with null baseline", () => {
    const d = new SpikeDetector(WINDOW);
    const snap = d.snapshot();
    assert.equal(snap.messageCount, 0);
    assert.equal(snap.armed, false);
    assert.equal(snap.baselineMPS, null);
  });

  test("AFTER arm, snapshot reports windows incorporated and live baseline", () => {
    const d = new SpikeDetector(WINDOW);
    for (const m of steadyMsgs(0, 4, 3)) d.processMessage(m);
    const snap = d.snapshot();
    assert.equal(snap.armed, true);
    assert.equal(snap.windowsIncorporated, 2);
    assert.ok(Math.abs((snap.baselineMPS ?? 0) - 4) < 1e-9);
  });
});

describe("Out-of-order arrival", () => {
  test("GIVEN a late message older than t0, WHEN ingested, THEN it never creates buckets", () => {
    const bursts: SpikeDetected[] = [];
    const d = new SpikeDetector(WINDOW, (e) => bursts.push(e));
    d.processMessage(msg(5000)); // sets t0 at offset 5000
    d.processMessage(msg(1000)); // late arrival — beyond t0
    assert.equal(d.windowsIncorporated, 0);
    assert.equal(bursts.length, 0);
  });
});
