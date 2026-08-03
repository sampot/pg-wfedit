import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { getPrimaryNext, listOutgoingEdges } from "./edges.js";

describe("getPrimaryNext", () => {
  it("uses next for action", () => {
    assert.equal(getPrimaryNext({ type: "action", next: "b" }), "b");
  });

  it("uses first on key for await_ui", () => {
    assert.equal(
      getPrimaryNext({
        type: "await_ui",
        on: { approve: "publish", reject: "draft" },
      }),
      "publish"
    );
  });

  it("respects ui.primaryNext when valid", () => {
    assert.equal(
      getPrimaryNext({
        type: "await_ui",
        on: { approve: "publish", reject: "draft" },
        ui: { primaryNext: "draft" },
      }),
      "draft"
    );
  });

  it("uses first when for choice", () => {
    assert.equal(
      getPrimaryNext({
        type: "choice",
        when: [{ expr: "vars.x == 1", next: "a" }],
        else: "b",
      }),
      "a"
    );
  });

  it("returns null for terminal", () => {
    assert.equal(getPrimaryNext({ type: "terminal" }), null);
  });
});

describe("listOutgoingEdges", () => {
  it("includes onError", () => {
    const edges = listOutgoingEdges({
      type: "action",
      next: "ok",
      onError: "fail",
    });
    assert.deepEqual(
      edges.map((e) => e.to),
      ["ok", "fail"]
    );
  });
});
