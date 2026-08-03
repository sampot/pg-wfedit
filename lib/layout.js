/** Vertical (TB) layout — WFEDIT-SPEC E2／E5／E6. */

import { getPrimaryNext, listOutgoingEdges } from "./edges.js";

/**
 * @typedef {{ x: number, y: number }} Pos
 */

/** Grid coords used by this editor (small integers). Pixel-ish legacy ui is ignored. */
export function isWfeditGridCoord(x, y) {
  if (typeof x !== "number" || typeof y !== "number") return false;
  if (!Number.isFinite(x) || !Number.isFinite(y)) return false;
  // Allow halves later; for now integers in a compact board.
  if (!Number.isInteger(x) || !Number.isInteger(y)) return false;
  if (Math.abs(x) > 24 || y < 0 || y > 80) return false;
  return true;
}

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
  if (start && steps[start]) {
    let cur = start;
    let y = 0;
    const guard = new Set();
    while (cur && steps[cur] && !guard.has(cur)) {
      guard.add(cur);
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
      if (!steps[edge.to]) continue;
      if (seen.has(edge.to)) {
        // back-edge / already placed — keep for drawing only
        continue;
      }
      if (edge.to === primary) {
        // should already be on main chain; if not, place below
        if (!pos.has(edge.to)) {
          pos.set(edge.to, { x: 0, y: base.y + 1 });
        }
        seen.add(edge.to);
        queue.push(edge.to);
        continue;
      }
      branchSlot += 1;
      const side = branchSlot % 2 === 1 ? 1 : -1;
      const mag = Math.ceil(branchSlot / 2);
      pos.set(edge.to, {
        x: base.x + side * mag,
        y: base.y + 1,
      });
      seen.add(edge.to);
      queue.push(edge.to);
    }
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
      ui.layout = "wfedit.v1";
      step.ui = ui;
    }
  }

  return pos;
}

/**
 * Resolve draw positions.
 * Prefer stored ui only when it looks like wfedit grid coords (or ui.layout).
 * Legacy pixel / horizontal designer coords are ignored → TB auto layout.
 *
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

  let trustStored = false;
  let storedCount = 0;
  let gridCount = 0;
  for (const id of Object.keys(steps)) {
    const ui = steps[id]?.ui;
    if (!ui || typeof ui !== "object") continue;
    storedCount += 1;
    if (ui.layout === "wfedit.v1" || isWfeditGridCoord(ui.x, ui.y)) {
      gridCount += 1;
    }
  }
  // Trust stored only if a majority look like our grid (or tagged).
  trustStored = storedCount > 0 && gridCount >= Math.ceil(storedCount * 0.6);

  for (const [id, fallback] of computed) {
    const step = steps[id];
    const ui = step?.ui && typeof step.ui === "object" ? step.ui : null;
    if (
      trustStored &&
      ui &&
      (ui.layout === "wfedit.v1" || isWfeditGridCoord(ui.x, ui.y))
    ) {
      out.set(id, { x: ui.x, y: ui.y });
    } else {
      out.set(id, fallback);
    }
  }
  return out;
}
