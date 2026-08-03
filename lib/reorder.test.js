import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { getPrimaryNext } from "./edges.js";
import {
  listMainChain,
  moveIndex,
  reorderMainChain,
} from "./reorder.js";

describe("listMainChain", () => {
  it("follows primary next", () => {
    const doc = {
      start: "a",
      steps: {
        a: { type: "action", next: "b" },
        b: { type: "action", next: "c" },
        c: { type: "terminal", outcome: "completed" },
        side: { type: "terminal", outcome: "failed" },
      },
    };
    assert.deepEqual(listMainChain(doc), ["a", "b", "c"]);
  });
});

describe("moveIndex", () => {
  it("moves later item earlier", () => {
    assert.deepEqual(moveIndex(["a", "b", "c"], "c", 1), ["a", "c", "b"]);
  });

  it("moves item to start", () => {
    assert.deepEqual(moveIndex(["a", "b", "c"], "b", 0), ["b", "a", "c"]);
  });

  it("returns null on no-op", () => {
    assert.equal(moveIndex(["a", "b", "c"], "b", 1), null);
    assert.equal(moveIndex(["a", "b", "c"], "b", 2), null);
  });
});

describe("reorderMainChain", () => {
  it("rejects terminal in middle", () => {
    const doc = {
      start: "a",
      steps: {
        a: { type: "action", next: "b" },
        b: { type: "action", next: "c" },
        c: { type: "terminal", outcome: "completed" },
      },
    };
    const r = reorderMainChain(doc, "c", 1);
    assert.equal(r.ok, false);
  });

  it("reorders action chain", () => {
    const doc = {
      start: "draft",
      steps: {
        draft: { type: "action", next: "approve" },
        approve: { type: "action", next: "publish" },
        publish: { type: "action", next: "done" },
        done: { type: "terminal", outcome: "completed" },
      },
    };
    const r = reorderMainChain(doc, "publish", 1);
    assert.equal(r.ok, true);
    assert.deepEqual(listMainChain(doc), [
      "draft",
      "publish",
      "approve",
      "done",
    ]);
    assert.equal(doc.steps.draft.next, "publish");
    assert.equal(doc.steps.publish.next, "approve");
    assert.equal(doc.steps.approve.next, "done");
  });

  it("rewrites await_ui primary signal only", () => {
    const doc = {
      start: "draft",
      steps: {
        draft: { type: "action", next: "approve" },
        approve: {
          type: "await_ui",
          on: { approve: "publish", reject: "draft" },
        },
        publish: { type: "action", next: "done" },
        done: { type: "terminal", outcome: "completed" },
      },
    };
    const r = reorderMainChain(doc, "publish", 1);
    assert.equal(r.ok, true);
    assert.deepEqual(listMainChain(doc), [
      "draft",
      "publish",
      "approve",
      "done",
    ]);
    assert.equal(doc.steps.draft.next, "publish");
    assert.equal(doc.steps.publish.next, "approve");
    assert.equal(getPrimaryNext(doc.steps.approve), "done");
    assert.equal(doc.steps.approve.on.reject, "draft");
  });

  it("can promote a step to start", () => {
    const doc = {
      start: "a",
      steps: {
        a: { type: "action", next: "b" },
        b: { type: "action", next: "c" },
        c: { type: "terminal", outcome: "completed" },
      },
    };
    const r = reorderMainChain(doc, "b", 0);
    assert.equal(r.ok, true);
    assert.equal(doc.start, "b");
    assert.deepEqual(listMainChain(doc), ["b", "a", "c"]);
  });
});
