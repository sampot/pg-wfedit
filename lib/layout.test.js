import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { computeLayout } from "./layout.js";

const doc = {
  apiVersion: "1",
  kind: "Workflow",
  workflowId: "demo",
  start: "draft",
  steps: {
    draft: { type: "action", builtin: "noop", next: "approve" },
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

  it("apply writes ui.x/y", () => {
    const clone = structuredClone(doc);
    computeLayout(clone, { apply: true });
    assert.equal(clone.steps.draft.ui.x, 0);
    assert.equal(clone.steps.draft.ui.y, 0);
  });
});
