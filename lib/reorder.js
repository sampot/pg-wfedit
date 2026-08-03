/** Main-chain reorder helpers (WFEDIT Phase 3). */

import { getPrimaryNext, setPrimaryNext } from "./edges.js";

/**
 * Walk start → primaryNext… (stops on cycle / missing).
 * @param {Record<string, unknown>} doc
 * @returns {string[]}
 */
export function listMainChain(doc) {
  if (!doc || typeof doc !== "object") return [];
  const steps =
    doc.steps && typeof doc.steps === "object"
      ? /** @type {Record<string, Record<string, unknown>>} */ (doc.steps)
      : {};
  const start = typeof doc.start === "string" ? doc.start : "";
  /** @type {string[]} */
  const chain = [];
  const guard = new Set();
  let cur = start;
  while (cur && steps[cur] && !guard.has(cur)) {
    guard.add(cur);
    chain.push(cur);
    const next = getPrimaryNext(steps[cur]);
    if (!next || !steps[next]) break;
    cur = next;
  }
  return chain;
}

/**
 * @param {string[]} chain
 * @param {string} movingId
 * @param {number} insertIndex index in the original chain (0 = before first)
 * @returns {string[] | null} new order, or null if invalid / no-op
 */
export function moveIndex(chain, movingId, insertIndex) {
  const from = chain.indexOf(movingId);
  if (from < 0) return null;
  let to = Math.max(0, Math.min(Number(insertIndex) || 0, chain.length));
  const next = chain.slice();
  next.splice(from, 1);
  if (to > from) to -= 1;
  to = Math.max(0, Math.min(to, next.length));
  next.splice(to, 0, movingId);
  if (next.every((id, i) => id === chain[i])) return null;
  return next;
}

/**
 * Apply a full main-chain order: update `start` + primary exits.
 * @param {Record<string, unknown>} doc
 * @param {string[] | null} newChain
 * @returns {{ ok: true, chain: string[] } | { ok: false, reason: string }}
 */
export function applyMainChainOrder(doc, newChain) {
  if (!newChain || !newChain.length) {
    return { ok: false, reason: "no-op or empty" };
  }
  const steps =
    doc.steps && typeof doc.steps === "object"
      ? /** @type {Record<string, Record<string, unknown>>} */ (doc.steps)
      : null;
  if (!steps) return { ok: false, reason: "no steps" };

  for (const id of newChain) {
    if (!steps[id]) return { ok: false, reason: `missing ${id}` };
  }
  for (let i = 0; i < newChain.length - 1; i += 1) {
    if (String(steps[newChain[i]].type || "") === "terminal") {
      return { ok: false, reason: "terminal in middle of chain" };
    }
  }

  doc.start = newChain[0];
  for (let i = 0; i < newChain.length - 1; i += 1) {
    setPrimaryNext(steps[newChain[i]], newChain[i + 1]);
  }
  return { ok: true, chain: newChain };
}

/**
 * Move `movingId` on the main chain to `insertIndex` (0 = new start).
 * @param {Record<string, unknown>} doc
 * @param {string} movingId
 * @param {number} insertIndex
 */
export function reorderMainChain(doc, movingId, insertIndex) {
  const chain = listMainChain(doc);
  if (!chain.includes(movingId)) {
    return { ok: false, reason: "not on main chain" };
  }
  const next = moveIndex(chain, movingId, insertIndex);
  return applyMainChainOrder(doc, next);
}
