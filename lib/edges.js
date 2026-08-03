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

/**
 * Point the primary outgoing edge at `to` (or clear when null/"").
 * Leaves non-primary exits (reject／onError 等) untouched.
 * @param {Record<string, unknown>} step
 * @param {string | null | undefined} to
 * @returns {boolean}
 */
export function setPrimaryNext(step, to) {
  if (!step || typeof step !== "object") return false;
  const type = String(step.type || "");
  if (type === "terminal") return false;

  const target = to != null && String(to).trim() ? String(to).trim() : "";
  const current = getPrimaryNext(step);

  if (type === "choice") {
    const when = Array.isArray(step.when) ? step.when : [];
    if (when[0] && typeof when[0] === "object") {
      if (target) when[0].next = target;
      else delete when[0].next;
    } else if (target) {
      step.else = target;
    } else {
      delete step.else;
    }
  } else if (type === "await_ui" || type === "await_child") {
    if (!step.on || typeof step.on !== "object" || Array.isArray(step.on)) {
      step.on = {};
    }
    const on = step.on;
    let key = Object.keys(on).find((k) => String(on[k]) === String(current));
    if (!key) key = Object.keys(on)[0];
    if (key) {
      if (target) on[key] = target;
      else delete on[key];
    } else if (type === "await_child") {
      if (target) step.next = target;
      else delete step.next;
    } else if (target) {
      // No signals yet — keep a stable key for the primary exit.
      on.approve = target;
    }
  } else {
    // action | timer | unknown
    if (target) step.next = target;
    else delete step.next;
  }

  if (step.ui && typeof step.ui === "object" && !Array.isArray(step.ui)) {
    if (
      typeof step.ui.primaryNext === "string" &&
      step.ui.primaryNext &&
      (step.ui.primaryNext === current ||
        !listOutgoingEdges(step).some((e) => e.to === step.ui.primaryNext))
    ) {
      if (target) step.ui.primaryNext = target;
      else delete step.ui.primaryNext;
    }
  }
  return true;
}
