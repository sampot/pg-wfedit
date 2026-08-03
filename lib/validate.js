/** workflow.v1 static checks (WFEDIT-SPEC §7). */

import { STEP_TYPES, listOutgoingEdges } from "./edges.js";

const STEP_ID_RE = /^[a-z][a-z0-9_]*$/;

/**
 * @typedef {{ code: string, message: string, stepId?: string, level?: "error" | "warn" }} Issue
 */

/**
 * @param {unknown} doc
 * @returns {{ ok: boolean, errors: Issue[], warnings: Issue[] }}
 */
export function validateWorkflow(doc) {
  /** @type {Issue[]} */
  const errors = [];
  /** @type {Issue[]} */
  const warnings = [];

  if (!doc || typeof doc !== "object" || Array.isArray(doc)) {
    return {
      ok: false,
      errors: [
        {
          code: "workflow_invalid_definition",
          message: "根節點必須是物件",
        },
      ],
      warnings,
    };
  }

  /** @type {Record<string, unknown>} */
  const root = doc;

  if (root.apiVersion !== "1" && root.apiVersion !== 1) {
    errors.push({
      code: "workflow_invalid_definition",
      message: 'apiVersion 必須為 "1"',
    });
  }
  if (root.kind !== "Workflow") {
    errors.push({
      code: "workflow_invalid_definition",
      message: 'kind 必須為 "Workflow"',
    });
  }
  if (typeof root.workflowId !== "string" || !root.workflowId.trim()) {
    errors.push({
      code: "workflow_invalid_definition",
      message: "需要 workflowId",
    });
  }
  if (typeof root.start !== "string" || !root.start) {
    errors.push({
      code: "workflow_invalid_definition",
      message: "需要 start",
    });
  }
  if (!root.steps || typeof root.steps !== "object" || Array.isArray(root.steps)) {
    errors.push({
      code: "workflow_invalid_definition",
      message: "需要 steps 物件",
    });
    return { ok: false, errors, warnings };
  }

  /** @type {Record<string, Record<string, unknown>>} */
  const steps = /** @type {any} */ (root.steps);
  const ids = Object.keys(steps);

  for (const id of ids) {
    if (!STEP_ID_RE.test(id)) {
      errors.push({
        code: "workflow_invalid_definition",
        message: `stepId 不合規：${id}`,
        stepId: id,
      });
    }
    const step = steps[id];
    if (!step || typeof step !== "object") {
      errors.push({
        code: "workflow_invalid_definition",
        message: `步驟 ${id} 必須是物件`,
        stepId: id,
      });
      continue;
    }
    const type = String(step.type || "");
    if (!STEP_TYPES.includes(type)) {
      errors.push({
        code: "workflow_invalid_definition",
        message: `未知 type：${type || "(空)"}`,
        stepId: id,
      });
      continue;
    }

    if (type === "action") {
      const hasRun = typeof step.run === "string";
      const hasFile = typeof step.runFile === "string";
      const hasBuiltin = typeof step.builtin === "string";
      if (!hasRun && !hasFile && !hasBuiltin) {
        errors.push({
          code: "workflow_invalid_definition",
          message: "action 需要 run、runFile 或 builtin",
          stepId: id,
        });
      }
      if (hasRun && hasFile) {
        errors.push({
          code: "workflow_invalid_definition",
          message: "run 與 runFile 互斥",
          stepId: id,
        });
      }
    }

    if (type === "await_ui") {
      const on = step.on && typeof step.on === "object" ? step.on : null;
      if (!on || !Object.keys(on).length) {
        errors.push({
          code: "workflow_invalid_definition",
          message: "await_ui 需要非空 on",
          stepId: id,
        });
      }
    }

    if (type === "choice") {
      if (!Array.isArray(step.when) || !step.when.length) {
        errors.push({
          code: "workflow_invalid_definition",
          message: "choice 需要 when 列表",
          stepId: id,
        });
      }
      if (!step.else) {
        errors.push({
          code: "workflow_invalid_definition",
          message: "choice 需要 else",
          stepId: id,
        });
      }
    }

    if (type === "timer") {
      const hasDelay = step.delayMs != null;
      const hasAt = typeof step.at === "string";
      if (!hasDelay && !hasAt) {
        errors.push({
          code: "workflow_invalid_definition",
          message: "timer 需要 delayMs 或 at",
          stepId: id,
        });
      }
      if (!step.next) {
        errors.push({
          code: "workflow_invalid_definition",
          message: "timer 需要 next",
          stepId: id,
        });
      }
    }

    if (type === "await_child") {
      if (!step.spawn) {
        errors.push({
          code: "workflow_invalid_definition",
          message: "await_child 需要 spawn",
          stepId: id,
        });
      }
    }

    if (type === "terminal" && step.next) {
      errors.push({
        code: "workflow_invalid_definition",
        message: "terminal 不應有 next",
        stepId: id,
      });
    }

    for (const edge of listOutgoingEdges(step)) {
      if (!steps[edge.to]) {
        errors.push({
          code: "workflow_invalid_definition",
          message: `邊 ${edge.kind}→${edge.to} 指向未知步驟`,
          stepId: id,
        });
      }
    }

    const ui = step.ui && typeof step.ui === "object" ? step.ui : null;
    if (ui && typeof ui.primaryNext === "string" && ui.primaryNext) {
      const outs = listOutgoingEdges(step).map((e) => e.to);
      if (!outs.includes(ui.primaryNext)) {
        warnings.push({
          code: "wfedit_primary_next",
          message: `ui.primaryNext 不是合法出邊：${ui.primaryNext}`,
          stepId: id,
          level: "warn",
        });
      }
    }
  }

  if (typeof root.start === "string" && root.start && !steps[root.start]) {
    errors.push({
      code: "workflow_invalid_definition",
      message: `start 指向未知步驟：${root.start}`,
    });
  }

  // reachability
  if (typeof root.start === "string" && steps[root.start]) {
    const seen = new Set();
    const q = [root.start];
    while (q.length) {
      const id = q.shift();
      if (!id || seen.has(id)) continue;
      seen.add(id);
      const step = steps[id];
      if (!step) continue;
      for (const e of listOutgoingEdges(step)) {
        if (!seen.has(e.to)) q.push(e.to);
      }
    }
    for (const id of ids) {
      if (!seen.has(id)) {
        warnings.push({
          code: "wfedit_unreachable",
          message: `自 start 不可達：${id}`,
          stepId: id,
          level: "warn",
        });
      }
    }
    let terminalReachable = false;
    for (const id of seen) {
      if (steps[id]?.type === "terminal") {
        terminalReachable = true;
        break;
      }
    }
    if (!terminalReachable) {
      warnings.push({
        code: "wfedit_no_terminal",
        message: "自 start 無法到達任何 terminal",
        level: "warn",
      });
    }
  }

  return { ok: errors.length === 0, errors, warnings };
}
