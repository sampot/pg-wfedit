import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  computeLayout,
  isWfeditGridCoord,
  resolvePositions,
} from "./layout.js";

const doc = {
  apiVersion: "1",
  kind: "Workflow",
  workflowId: "demo",
  start: "draft",
  steps: {
    draft: { type: "action", builtin: "noop", next: "approve", onError: "failed" },
    approve: {
      type: "await_ui",
      on: { approve: "publish", reject: "draft" },
    },
    publish: { type: "action", builtin: "noop", next: "done" },
    done: { type: "terminal", outcome: "completed" },
    failed: { type: "terminal", outcome: "failed" },
  },
};

describe("computeLayout", () => {
  it("stacks main chain vertically at x=0", () => {
    const pos = computeLayout(doc);
    assert.equal(pos.get("draft")?.x, 0);
    assert.equal(pos.get("draft")?.y, 0);
    assert.equal(pos.get("approve")?.y, 1);
    assert.equal(pos.get("publish")?.y, 2);
    assert.equal(pos.get("done")?.y, 3);
  });

  it("places onError beside the source row", () => {
    const pos = computeLayout(doc);
    assert.ok(pos.get("failed"));
    assert.notEqual(pos.get("failed")?.x, 0);
    assert.equal(pos.get("failed")?.y, pos.get("draft")?.y);
  });

  it("apply writes ui.x/y and layout tag", () => {
    const clone = structuredClone(doc);
    computeLayout(clone, { apply: true });
    assert.equal(clone.steps.draft.ui.x, 0);
    assert.equal(clone.steps.draft.ui.y, 0);
    assert.equal(clone.steps.draft.ui.layout, "wfedit.v1");
  });
});

describe("resolvePositions", () => {
  it("ignores legacy pixel ui and uses TB layout", () => {
    const legacy = structuredClone(doc);
    legacy.steps.draft.ui = { x: 80, y: 120 };
    legacy.steps.approve.ui = { x: 280, y: 120 };
    legacy.steps.publish.ui = { x: 480, y: 80 };
    legacy.steps.done.ui = { x: 680, y: 80 };
    legacy.steps.failed.ui = { x: 480, y: 220 };
    const pos = resolvePositions(legacy);
    assert.equal(pos.get("draft")?.x, 0);
    assert.equal(pos.get("draft")?.y, 0);
    assert.equal(pos.get("approve")?.y, 1);
  });

  it("trusts wfedit.v1 grid ui", () => {
    const tagged = structuredClone(doc);
    computeLayout(tagged, { apply: true });
    tagged.steps.draft.ui.x = 2;
    tagged.steps.draft.ui.y = 0;
    const pos = resolvePositions(tagged);
    assert.equal(pos.get("draft")?.x, 2);
  });
});

describe("isWfeditGridCoord", () => {
  it("rejects pixel-scale values", () => {
    assert.equal(isWfeditGridCoord(80, 120), false);
    assert.equal(isWfeditGridCoord(0, 1), true);
  });
});
