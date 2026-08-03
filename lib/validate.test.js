import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { validateWorkflow } from "./validate.js";

const good = {
  apiVersion: "1",
  kind: "Workflow",
  workflowId: "demo",
  start: "a",
  steps: {
    a: { type: "action", builtin: "noop", next: "b" },
    b: { type: "terminal", outcome: "completed" },
  },
};

describe("validateWorkflow", () => {
  it("accepts minimal valid doc", () => {
    const r = validateWorkflow(good);
    assert.equal(r.ok, true);
    assert.equal(r.errors.length, 0);
  });

  it("rejects missing start target", () => {
    const r = validateWorkflow({ ...good, start: "missing" });
    assert.equal(r.ok, false);
    assert.ok(r.errors.some((e) => /start/.test(e.message)));
  });

  it("rejects run+runFile", () => {
    const r = validateWorkflow({
      ...good,
      steps: {
        a: {
          type: "action",
          run: "return { ok: true }",
          runFile: "./x.js",
          next: "b",
        },
        b: { type: "terminal" },
      },
    });
    assert.equal(r.ok, false);
    assert.ok(r.errors.some((e) => /互斥/.test(e.message)));
  });

  it("warns unreachable", () => {
    const r = validateWorkflow({
      ...good,
      steps: {
        ...good.steps,
        orphan: { type: "terminal", outcome: "cancelled" },
      },
    });
    assert.equal(r.ok, true);
    assert.ok(r.warnings.some((w) => w.stepId === "orphan"));
  });
});
