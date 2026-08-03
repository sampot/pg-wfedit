/** Outgoing edges & primary-next heuristic (WFEDIT-SPEC E6). */

export const STEP_TYPES = [
  "action",
  "await_ui",
  "await_child",
  "timer",
  "choice",
  "terminal",
];

/**
 * @typedef {{ kind: string, label: string, to: string, primary?: boolean }} Edge
 */

/**
 * @param {Record<string, unknown>} step
 * @returns {Edge[]}
 */
export function listOutgoingEdges(step) {
  if (!step || typeof step !== "object") return [];
  const type = String(step.type || "");
  /** @type {Edge[]} */
  const edges = [];

  if (type === "terminal") {
    // no next
  } else if (type === "choice") {
    const when = Array.isArray(step.when) ? step.when : [];
    for (const row of when) {
      if (row && typeof row === "object" && row.next) {
        edges.push({
          kind: "when",
          label: String(row.expr ?? "when"),
          to: String(row.next),
        });
      }
    }
    if (step.else) {
      edges.push({ kind: "else", label: "else", to: String(step.else) });
    }
  } else if (type === "await_ui" || type === "await_child") {
    const on = step.on && typeof step.on === "object" ? step.on : {};
    for (const [signal, to] of Object.entries(on)) {
      edges.push({ kind: "on", label: String(signal), to: String(to) });
    }
    if (type === "await_child" && step.next) {
      edges.push({ kind: "next", label: "next", to: String(step.next) });
    }
    if (
      type === "await_ui" &&
      step.timeout &&
      typeof step.timeout === "object" &&
      step.timeout.next
    ) {
      edges.push({
        kind: "timeout",
        label: "timeout",
        to: String(step.timeout.next),
      });
    }
  } else {
    // action | timer | unknown
    if (step.next) {
      edges.push({ kind: "next", label: "next", to: String(step.next) });
    }
  }

  if (step.onError) {
    edges.push({
      kind: "onError",
      label: "onError",
      to: String(step.onError),
    });
  }

  return edges;
}

/**
 * @param {Record<string, unknown>} step
 * @returns {string | null}
 */
export function getPrimaryNext(step) {
  if (!step || typeof step !== "object") return null;
  const type = String(step.type || "");
  if (type === "terminal") return null;

  const ui = step.ui && typeof step.ui === "object" ? step.ui : null;
  if (ui && typeof ui.primaryNext === "string" && ui.primaryNext) {
    const edges = listOutgoingEdges(step);
    if (edges.some((e) => e.to === ui.primaryNext)) return ui.primaryNext;
  }

  if (type === "choice") {
    const when = Array.isArray(step.when) ? step.when : [];
    if (when[0] && typeof when[0] === "object" && when[0].next) {
      return String(when[0].next);
    }
    if (step.else) return String(step.else);
    return null;
  }

  if (type === "await_ui" || type === "await_child") {
    const on = step.on && typeof step.on === "object" ? step.on : {};
    const keys = Object.keys(on);
    if (keys.length) return String(on[keys[0]]);
    if (type === "await_child" && step.next) return String(step.next);
    return null;
  }

  if (step.next) return String(step.next);
  return null;
}

/**
 * Mark which outgoing edge is primary.
 * @param {Record<string, unknown>} step
 * @returns {Edge[]}
 */
export function listOutgoingEdgesMarked(step) {
  const primary = getPrimaryNext(step);
  const edges = listOutgoingEdges(step);
  let marked = false;
  return edges.map((e) => {
    if (!marked && primary && e.to === primary && e.kind !== "onError") {
      marked = true;
      return { ...e, primary: true };
    }
    return { ...e, primary: false };
  });
}
