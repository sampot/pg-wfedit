/** Vertical (TB) layout — WFEDIT-SPEC E2／E5／E6. */

import { getPrimaryNext, listOutgoingEdges } from "./edges.js";

/**
 * @typedef {{ x: number, y: number }} Pos
 */

/**
 * Compute positions for all steps. Does not mutate the document unless
 * `apply` is true (writes step.ui.x / step.ui.y).
 *
 * @param {Record<string, unknown>} doc
 * @param {{ apply?: boolean }} [opts]
 * @returns {Map<string, Pos>}
 */
export function computeLayout(doc, opts = {}) {
  const apply = Boolean(opts.apply);
  /** @type {Map<string, Pos>} */
  const pos = new Map();
  if (!doc || typeof doc !== "object") return pos;

  /** @type {Record<string, Record<string, unknown>>} */
  const steps =
    doc.steps && typeof doc.steps === "object"
      ? /** @type {any} */ (doc.steps)
      : {};
  const start = typeof doc.start === "string" ? doc.start : "";
  const ids = Object.keys(steps);

  // Main chain depth
  /** @type {Map<string, number>} */
  const depth = new Map();
  if (start && steps[start]) {
    let cur = start;
    let y = 0;
    const guard = new Set();
    while (cur && steps[cur] && !guard.has(cur)) {
      guard.add(cur);
      depth.set(cur, y);
      pos.set(cur, { x: 0, y });
      const next = getPrimaryNext(steps[cur]);
      if (!next || !steps[next] || guard.has(next)) break;
      cur = next;
      y += 1;
    }
  }

  // Branch nodes: BFS from placed nodes
  const queue = [...pos.keys()];
  const seen = new Set(queue);
  while (queue.length) {
    const id = queue.shift();
    if (!id) continue;
    const step = steps[id];
    if (!step) continue;
    const base = pos.get(id) || { x: 0, y: 0 };
    const primary = getPrimaryNext(step);
    const outs = listOutgoingEdges(step).filter((e) => e.kind !== "onError");
    let branchSlot = 0;
    for (const edge of outs) {
      if (seen.has(edge.to) || !steps[edge.to]) continue;
      if (edge.to === primary && pos.has(edge.to)) {
        seen.add(edge.to);
        queue.push(edge.to);
        continue;
      }
      // side branch
      branchSlot += 1;
      const side = branchSlot % 2 === 1 ? 1 : -1;
      const mag = Math.ceil(branchSlot / 2);
      const childPos = {
        x: base.x + side * mag,
        y: base.y + 1,
      };
      // if already on main chain with coords, keep deeper y preference
      if (!pos.has(edge.to)) {
        pos.set(edge.to, childPos);
      }
      seen.add(edge.to);
      queue.push(edge.to);
    }
    // onError lightly offset
    for (const edge of listOutgoingEdges(step).filter(
      (e) => e.kind === "onError"
    )) {
      if (seen.has(edge.to) || !steps[edge.to]) continue;
      pos.set(edge.to, { x: (base.x || 0) + 1, y: (base.y || 0) + 1 });
      seen.add(edge.to);
      queue.push(edge.to);
    }
  }

  // Orphans at bottom
  let orphanY =
    [...pos.values()].reduce((m, p) => Math.max(m, p.y), -1) + 2;
  if (orphanY < 0) orphanY = 0;
  let orphanX = 0;
  for (const id of ids) {
    if (pos.has(id)) continue;
    pos.set(id, { x: orphanX, y: orphanY });
    orphanX += 1;
  }

  if (apply) {
    for (const [id, p] of pos) {
      const step = steps[id];
      if (!step) continue;
      const ui =
        step.ui && typeof step.ui === "object" && !Array.isArray(step.ui)
          ? { ...step.ui }
          : {};
      ui.x = p.x;
      ui.y = p.y;
      step.ui = ui;
    }
  }

  return pos;
}

/**
 * Resolve draw positions: prefer stored ui.x/y when both present.
 * @param {Record<string, unknown>} doc
 * @returns {Map<string, Pos>}
 */
export function resolvePositions(doc) {
  const computed = computeLayout(doc, { apply: false });
  /** @type {Map<string, Pos>} */
  const out = new Map();
  const steps =
    doc?.steps && typeof doc.steps === "object"
      ? /** @type {any} */ (doc.steps)
      : {};
  for (const [id, fallback] of computed) {
    const step = steps[id];
    const ui = step?.ui && typeof step.ui === "object" ? step.ui : null;
    if (
      ui &&
      typeof ui.x === "number" &&
      Number.isFinite(ui.x) &&
      typeof ui.y === "number" &&
      Number.isFinite(ui.y)
    ) {
      out.set(id, { x: ui.x, y: ui.y });
    } else {
      out.set(id, fallback);
    }
  }
  return out;
}
