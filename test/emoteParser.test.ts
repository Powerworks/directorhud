import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { countEmotes, makeChatMessage } from "../src/domain/chatMessage.ts";

describe("countEmotes — Twitch IRC v3 emotes tag parser", () => {
  test("empty string → 0", () => {
    assert.equal(countEmotes(""), 0);
  });

  test("single fragment, single range → 1", () => {
    assert.equal(countEmotes("Kappa:0-4"), 1);
  });

  test("single fragment, multiple ranges → one per range", () => {
    assert.equal(countEmotes("KEKW:0-3,7-10"), 2);
  });

  test("multiple fragments summed", () => {
    assert.equal(countEmotes("emote1:0-2;emote2:4-6,9-11"), 3);
  });

  test("malformed fragments are ignored, never throw", () => {
    assert.equal(countEmotes("no-colon-here"), 0);
    assert.equal(countEmotes("id:"), 0);
    assert.equal(countEmotes(":0-2"), 0);
    assert.equal(countEmotes("id:abc-def"), 0);
  });

  test("mixed good + malformed keeps the good ones", () => {
    assert.equal(countEmotes("Kappa:0-4;broken;PEPE:9-13"), 2);
  });
});

describe("makeChatMessage", () => {
  test("derives emoteCount from the tag and builds deterministic ids", () => {
    const m = makeChatMessage({
      timestamp: 1_000,
      channel: "pwrkns",
      author: "viewer7",
      text: "LUL KEKW",
      emotesTag: "lul:0-2;kekw:4-7",
    });
    assert.equal(m.emoteCount, 2);
    assert.equal(m.id, "pwrkns:viewer7:1000");
  });

  test("countEmotes stays consistent with regenerated tags", () => {
    const text = "LUL nice KEKW LUL KEKW";
    //       0-2  ...   11-14 16-18 20-23
    const tag = "lul:0-2;11-14;16-18;20-23".replace(/;\d+-\d+$/, "");
    assert.equal(countEmotes(tag), 1);
  });
});
