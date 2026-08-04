/**
 * pg-wfedit — vertical workflow.v1 visual editor (Tool SAM).
 * IR: workflow.yaml；不跑引擎（DEC-034 / WFEDIT-SPEC）。
 */

import jsyaml from "https://esm.sh/js-yaml@4.1.0";
import {
  STEP_TYPES,
  getPrimaryNext,
  listOutgoingEdgesMarked,
  setPrimaryNext,
} from "./lib/edges.js";
import { validateWorkflow } from "./lib/validate.js";
import { computeLayout, resolvePositions } from "./lib/layout.js";
import {
  listMainChain,
  moveIndex,
  reorderMainChain,
} from "./lib/reorder.js";

const DEF_PATH = "workflow.yaml";
const CARD_W = 188;
/** Fixed card height in px (must match CSS `.step-card` height). */
const CARD_H = 110;
/** Air between card bottom and next card top. */
const GAP_Y = 52;
const CELL_H = CARD_H + GAP_Y;
const CELL_W = 240;
const ORIGIN_X = 72;
const ORIGIN_Y = 32;
/** Side lane offset for back-edges / non-primary loops (to the right of cards). */
const SIDE_LANE = 36;
const DRAG_THRESHOLD = 6;

const pathLabel = document.getElementById("path-label");
const modeLabel = document.getElementById("mode-label");
const statusEl = document.getElementById("status");
const canvasWrap = document.getElementById("canvas-wrap");
const canvas = document.getElementById("canvas");
const cardsEl = document.getElementById("cards");
const svgEl = document.getElementById("edges-svg");
const inspectorTitle = document.getElementById("inspector-title");
const inspectorBody = document.getElementById("inspector-body");
const issuesEl = document.getElementById("issues");
const graphPane = document.getElementById("graph-pane");
const yamlPane = document.getElementById("yaml-pane");
const yamlEditor = document.getElementById("yaml-editor");

const btnGraph = document.getElementById("btn-graph");
const btnYaml = document.getElementById("btn-yaml");
const btnAdd = document.getElementById("btn-add");
const btnLayout = document.getElementById("btn-layout");
const btnValidate = document.getElementById("btn-validate");
const btnSample = document.getElementById("btn-sample");
const btnReload = document.getElementById("btn-reload");
const btnSave = document.getElementById("btn-save");
const btnClose = document.getElementById("btn-close");

/** @type {"standalone" | "tool"} */
let session = "standalone";
let focusPath = DEF_PATH;
let mode = "read";
let contentHash = "";
let dirty = false;
/** @type {"graph" | "yaml"} */
let view = "graph";
/** @type {Record<string, unknown> | null} */
let ast = null;
let yamlBroken = false;
let selectedId = "";
/** @type {Map<string, { x: number, y: number }>} */
let positions = new Map();
/** @type {any} move-card or link-next drag state */
let drag = null;

function setStatus(text, tone = "") {
  statusEl.textContent = text || "";
  statusEl.classList.toggle("error", tone === "bad");
  statusEl.classList.toggle("ok", tone === "ok");
}

async function api(path, options = {}) {
  const res = await fetch(path, {
    headers: { "content-type": "application/json", ...(options.headers || {}) },
    ...options,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error(data.error || res.statusText || "請求失敗");
    err.code = data.code;
    throw err;
  }
  return data;
}

function writable() {
  return session === "standalone" || (session === "tool" && mode === "readwrite");
}

function syncChrome() {
  pathLabel.textContent =
    session === "tool" ? focusPath || "—" : "本機試寫";
  modeLabel.textContent =
    session === "tool"
      ? `${mode || ""}${dirty ? " · 未存" : ""}`
      : dirty
        ? "standalone · 未存"
        : "standalone";
  btnSave.hidden = session !== "tool";
  btnClose.hidden = session !== "tool";
  btnSample.hidden = session === "tool";
  btnSave.disabled = !writable() || !dirty || session !== "tool" || !focusPath;
  btnAdd.disabled = !writable() || yamlBroken;
  btnLayout.disabled = !writable() || !ast || yamlBroken;
  const graphLocked = yamlBroken;
  btnGraph.disabled = false;
  if (graphLocked && view === "graph") {
    /* still allow viewing last good AST */
  }
}

function dumpYaml(doc) {
  return jsyaml.dump(doc, {
    indent: 2,
    lineWidth: 100,
    noRefs: true,
    sortingKeys: false,
    forceQuotes: false,
  });
}

function parseYamlText(text) {
  try {
    const value = jsyaml.load(text);
    return { ok: true, value };
  } catch (e) {
    return {
      ok: false,
      error: e instanceof Error ? e.message : String(e),
    };
  }
}

function markDirty() {
  dirty = true;
  syncChrome();
}

function ensureSteps() {
  if (!ast || typeof ast !== "object") {
    ast = {
      apiVersion: "1",
      kind: "Workflow",
      workflowId: "untitled",
      start: "start",
      steps: {
        start: { type: "terminal", outcome: "completed", title: "結束" },
      },
    };
  }
  if (!ast.steps || typeof ast.steps !== "object") ast.steps = {};
  return /** @type {Record<string, Record<string, unknown>>} */ (ast.steps);
}

function setAstFromDoc(doc) {
  ast = doc && typeof doc === "object" ? doc : null;
  yamlBroken = false;
  if (ast) {
    positions = resolvePositions(ast);
  } else {
    positions = new Map();
  }
}

function runValidate(showOk = true) {
  if (!ast) {
    renderIssues([
      {
        code: "workflow_invalid_definition",
        message: "尚無定義",
        level: "error",
      },
    ]);
    if (showOk) setStatus("尚無定義", "bad");
    return false;
  }
  const r = validateWorkflow(ast);
  const items = [
    ...r.errors.map((e) => ({ ...e, level: "error" })),
    ...r.warnings.map((w) => ({ ...w, level: "warn" })),
  ];
  renderIssues(items);
  if (!r.ok) {
    if (showOk) setStatus(`校驗失敗（${r.errors.length}）`, "bad");
    return false;
  }
  if (showOk) {
    setStatus(
      r.warnings.length
        ? `通過（${r.warnings.length} 則警告）`
        : "校驗通過",
      "ok"
    );
  }
  return true;
}

function renderIssues(items) {
  if (!items.length) {
    issuesEl.hidden = true;
    issuesEl.innerHTML = "";
    return;
  }
  issuesEl.hidden = false;
  issuesEl.innerHTML = items
    .map(
      (it) =>
        `<li class="${it.level === "warn" ? "warn" : "err"}" data-step="${it.stepId || ""}">${escapeHtml(it.message)}</li>`
    )
    .join("");
}

function escapeHtml(s) {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function px(pos) {
  return {
    left: ORIGIN_X + pos.x * CELL_W,
    top: ORIGIN_Y + pos.y * CELL_H,
  };
}

function cardCenter(pos) {
  const p = px(pos);
  return { x: p.left + CARD_W / 2, y: p.top + CARD_H / 2 };
}

function stepSummary(step) {
  const type = String(step.type || "");
  if (type === "action") {
    if (step.builtin) return `builtin: ${step.builtin}`;
    if (step.runFile) return `runFile`;
    if (step.run) return "run: |";
  }
  if (type === "await_ui") {
    const n = step.on ? Object.keys(step.on).length : 0;
    return `${n} signals`;
  }
  if (type === "choice") {
    const n = Array.isArray(step.when) ? step.when.length : 0;
    return `${n} when + else`;
  }
  if (type === "timer") {
    return step.delayMs != null ? `${step.delayMs}ms` : String(step.at || "");
  }
  if (type === "terminal") return String(step.outcome || "completed");
  return type;
}

function drawPos(grid) {
  let minX = 0;
  for (const p of positions.values()) minX = Math.min(minX, p.x);
  return { x: grid.x - minX, y: grid.y };
}

/**
 * Route an edge.
 * - Main-chain (same column, down): straight centered vertical
 * - Side / same row: horizontal into neighbor
 * - Back / up (e.g. reject→draft): right-side orthogonal loop
 *
 * @param {number} [sideSlot] stagger for multiple side/back edges
 */
function routeEdge(from, to, fromPos, toPos, sideSlot = 0) {
  const halfH = CARD_H / 2;
  const halfW = CARD_W / 2;
  // Anchor at card border centers (geometric center of the box)
  const xBot = from.x;
  const yBot = from.y + halfH;
  const xTop = to.x;
  const yTop = to.y - halfH;

  // Same row → horizontal
  if (fromPos.y === toPos.y && fromPos.x !== toPos.x) {
    const dir = toPos.x > fromPos.x ? 1 : -1;
    const xExit = from.x + dir * halfW;
    const xEnter = to.x - dir * halfW;
    const midX = (xExit + xEnter) / 2;
    return {
      d: `M ${xExit} ${from.y} L ${xEnter} ${to.y}`,
      labelAt: { x: midX - 10, y: from.y - 10 },
      insertAt: null,
      startAt: { x: xExit, y: from.y },
      endAt: { x: xEnter, y: to.y },
      forward: true,
      kind: "horizontal",
    };
  }

  // Main chain: same column, downward — straight line through centers
  if (toPos.y > fromPos.y && fromPos.x === toPos.x) {
    const midY = (yBot + yTop) / 2;
    return {
      d: `M ${xBot} ${yBot} L ${xTop} ${yTop}`,
      labelAt: { x: xBot + 12, y: midY + 4 },
      insertAt: { x: xBot, y: midY },
      startAt: { x: xBot, y: yBot },
      endAt: { x: xTop, y: yTop },
      forward: true,
      kind: "main",
    };
  }

  // Forward to another column (branch down-right/left)
  if (toPos.y > fromPos.y) {
    const midY = (yBot + yTop) / 2;
    return {
      d: `M ${xBot} ${yBot} C ${xBot} ${midY}, ${xTop} ${midY}, ${xTop} ${yTop}`,
      labelAt: { x: (xBot + xTop) / 2 + 8, y: midY - 4 },
      insertAt: { x: (xBot + xTop) / 2, y: midY },
      startAt: { x: xBot, y: yBot },
      endAt: { x: xTop, y: yTop },
      forward: true,
      kind: "branch",
    };
  }

  // Back-edge / upward (e.g. reject → draft, or onError up to a side terminal)
  const yExit = from.y;
  const yEnter = to.y;
  if (to.x > from.x + 8) {
    // Target is to the right: climb in the gutter BETWEEN columns (never on card edge)
    const gutter = (from.x + halfW + (to.x - halfW)) / 2;
    const laneX = gutter + sideSlot * 14;
    return {
      d: `M ${from.x + halfW} ${yExit} L ${laneX} ${yExit} L ${laneX} ${yEnter} L ${to.x - halfW} ${yEnter}`,
      labelAt: { x: laneX + 6, y: (yExit + yEnter) / 2 },
      insertAt: null,
      startAt: { x: from.x + halfW, y: yExit },
      endAt: { x: to.x - halfW, y: yEnter },
      forward: false,
      kind: "back",
    };
  }
  // Same column: loop further right than any card edge
  const laneX = from.x + halfW + SIDE_LANE + 12 + sideSlot * 22;
  return {
    d: `M ${from.x + halfW} ${yExit} L ${laneX} ${yExit} L ${laneX} ${yEnter} L ${to.x + halfW} ${yEnter}`,
    labelAt: { x: laneX + 8, y: (yExit + yEnter) / 2 },
    insertAt: null,
    startAt: { x: from.x + halfW, y: yExit },
    endAt: { x: to.x + halfW, y: yEnter },
    forward: false,
    kind: "back",
  };
}

function renderGraph() {
  cardsEl.innerHTML = "";
  svgEl.innerHTML = "";
  if (!ast) {
    cardsEl.innerHTML = `<p class="empty">無流程定義</p>`;
    return;
  }
  const steps = ensureSteps();
  positions = resolvePositions(ast);

  let maxX = 0;
  let minX = 0;
  let maxY = 0;
  for (const p of positions.values()) {
    maxX = Math.max(maxX, p.x);
    minX = Math.min(minX, p.x);
    maxY = Math.max(maxY, p.y);
  }
  const cols = maxX - minX + 1;
  // Extra right pad for back-edge side lanes
  const width = ORIGIN_X + cols * CELL_W + SIDE_LANE + 80;
  const height = ORIGIN_Y + (maxY + 1) * CELL_H + 32;
  canvas.style.width = `${width}px`;
  canvas.style.height = `${height}px`;
  svgEl.setAttribute("width", String(width));
  svgEl.setAttribute("height", String(height));
  svgEl.setAttribute("viewBox", `0 0 ${width} ${height}`);

  const ns = "http://www.w3.org/2000/svg";
  const defs = document.createElementNS(ns, "defs");
  for (const [id, color] of [
    ["arrow-primary", "var(--accent)"],
    ["arrow-edge", "var(--edge)"],
    ["arrow-danger", "var(--danger)"],
  ]) {
    const marker = document.createElementNS(ns, "marker");
    marker.setAttribute("id", id);
    marker.setAttribute("viewBox", "0 0 10 10");
    marker.setAttribute("refX", "8");
    marker.setAttribute("refY", "5");
    marker.setAttribute("markerWidth", "6");
    marker.setAttribute("markerHeight", "6");
    marker.setAttribute("orient", "auto");
    const poly = document.createElementNS(ns, "path");
    poly.setAttribute("d", "M 0 0 L 10 5 L 0 10 z");
    poly.setAttribute("fill", color);
    marker.appendChild(poly);
    defs.appendChild(marker);
  }
  svgEl.appendChild(defs);

  const start = String(ast.start || "");
  const reachable = new Set();
  if (start && steps[start]) {
    const q = [start];
    while (q.length) {
      const id = q.shift();
      if (!id || reachable.has(id)) continue;
      reachable.add(id);
      for (const e of listOutgoingEdgesMarked(steps[id])) {
        if (!reachable.has(e.to)) q.push(e.to);
      }
    }
  }
  const orphans = Object.keys(steps).filter((id) => !reachable.has(id));
  if (orphans.length) {
    const y = ORIGIN_Y + (maxY + 0.85) * CELL_H;
    const ban = document.createElement("div");
    ban.className = "orphan-banner";
    ban.style.top = `${y}px`;
    ban.textContent = `孤立步驟（自 start 不可達）：${orphans.join(", ")}`;
    cardsEl.appendChild(ban);
  }

  // edges first (under cards)
  let sideSlot = 0;
  for (const [id, step] of Object.entries(steps)) {
    const fromGrid = positions.get(id);
    if (!fromGrid) continue;
    const fromPos = drawPos(fromGrid);
    const from = cardCenter(fromPos);
    for (const edge of listOutgoingEdgesMarked(step)) {
      const toGrid = positions.get(edge.to);
      if (!toGrid) continue;
      const toPos = drawPos(toGrid);
      const to = cardCenter(toPos);
      const needsSide = toPos.y < fromPos.y;
      const route = routeEdge(
        from,
        to,
        fromPos,
        toPos,
        needsSide ? sideSlot++ : 0
      );

      const path = document.createElementNS(ns, "path");
      path.setAttribute("d", route.d);
      path.setAttribute("fill", "none");
      const stroke =
        edge.kind === "onError"
          ? "var(--danger)"
          : edge.primary || route.kind === "main"
            ? "var(--accent)"
            : "var(--edge)";
      path.setAttribute("stroke", stroke);
      path.setAttribute(
        "stroke-width",
        edge.primary || route.kind === "main" ? "2.25" : "1.5"
      );
      path.setAttribute(
        "marker-end",
        edge.kind === "onError"
          ? "url(#arrow-danger)"
          : edge.primary || route.kind === "main"
            ? "url(#arrow-primary)"
            : "url(#arrow-edge)"
      );
      if (edge.kind === "onError" || route.kind === "back") {
        path.setAttribute("stroke-dasharray", "5 4");
      }
      // Keep stroke centered under markers
      path.setAttribute("stroke-linecap", "round");
      path.dataset.from = id;
      path.dataset.to = edge.to;
      path.dataset.kind = edge.kind;
      svgEl.appendChild(path);

      const showEdgeLabel = Boolean(edge.label && edge.label !== "next");
      // Reserve space so × sits to the left of the label (esp. onError / reject).
      const labelPad = writable() && !yamlBroken && showEdgeLabel ? 18 : 0;
      if (showEdgeLabel) {
        const label = document.createElementNS(ns, "text");
        label.setAttribute("x", String(route.labelAt.x + labelPad));
        label.setAttribute("y", String(route.labelAt.y));
        label.setAttribute("fill", "var(--branch)");
        label.setAttribute("font-size", "11");
        label.setAttribute(
          "font-weight",
          edge.primary || route.kind === "main" ? "600" : "400"
        );
        label.textContent = edge.label;
        svgEl.appendChild(label);
      }

      if (writable() && !yamlBroken && route.endAt) {
        // Drag arrow tip → retarget or drop empty to delete
        const endBtn = document.createElement("button");
        endBtn.type = "button";
        endBtn.className = `edge-end-handle${
          edge.kind === "onError" ? " danger" : ""
        }${edge.primary ? " primary" : ""}`;
        endBtn.title = `拖曳改「${edge.label}」連到哪張卡；放到空白／刪除區可刪除`;
        endBtn.setAttribute(
          "aria-label",
          `拖曳 ${id}.${edge.label} → ${edge.to}`
        );
        endBtn.style.left = `${route.endAt.x - 8}px`;
        endBtn.style.top = `${route.endAt.y - 8}px`;
        endBtn.addEventListener("pointerdown", (ev) => {
          onLinkPointerDown(ev, id, edge, {
            originX: route.startAt?.x ?? from.x,
            originY: route.startAt?.y ?? from.y + CARD_H / 2,
            rewire: true,
          });
        });
        cardsEl.appendChild(endBtn);

        const delBtn = document.createElement("button");
        delBtn.type = "button";
        delBtn.className = "edge-delete";
        delBtn.title = `刪除 ${id} → ${edge.to}（${edge.label}）`;
        delBtn.textContent = "×";
        if (showEdgeLabel) {
          // Left of label text
          delBtn.style.left = `${route.labelAt.x - 2}px`;
          delBtn.style.top = `${route.labelAt.y - 10}px`;
        } else if (route.insertAt) {
          delBtn.style.left = `${route.insertAt.x + 14}px`;
          delBtn.style.top = `${route.insertAt.y - 10}px`;
        } else {
          const delAt = route.labelAt || route.endAt;
          delBtn.style.left = `${delAt.x}px`;
          delBtn.style.top = `${delAt.y - 10}px`;
        }
        delBtn.addEventListener("click", (ev) => {
          ev.stopPropagation();
          deleteEdge(id, edge);
        });
        cardsEl.appendChild(delBtn);
      }

      // insert only on main-chain primary edges
      if (
        writable() &&
        !yamlBroken &&
        route.kind === "main" &&
        edge.primary &&
        route.insertAt
      ) {
        const plus = document.createElement("button");
        plus.type = "button";
        plus.className = "edge-insert";
        plus.title = `在 ${id} → ${edge.to} 之間插入`;
        plus.textContent = "+";
        plus.style.left = `${route.insertAt.x - 12}px`;
        plus.style.top = `${route.insertAt.y - 12}px`;
        plus.addEventListener("click", (ev) => {
          ev.stopPropagation();
          insertOnEdge(id, edge);
        });
        cardsEl.appendChild(plus);
      }
    }
  }

  // cards
  for (const [id, step] of Object.entries(steps)) {
    const grid = positions.get(id) || { x: 0, y: 0 };
    const p = px(drawPos(grid));
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = `step-card type-${String(step.type || "unknown")}${
      step.type === "terminal" ? " terminal" : ""
    }${selectedId === id ? " selected" : ""}${
      id === start ? " is-start" : ""
    }`;
    btn.style.left = `${p.left}px`;
    btn.style.top = `${p.top}px`;
    btn.dataset.id = id;
    const title = (step.ui && step.ui.label) || step.title || "";
    btn.innerHTML = `
      <span class="step-type">${escapeHtml(String(step.type || "?"))}${
        id === start ? " · start" : ""
      }</span>
      <span class="step-id">${escapeHtml(id)}</span>
      ${title ? `<span class="step-title">${escapeHtml(String(title))}</span>` : ""}
      <span class="step-meta">${escapeHtml(stepSummary(step))}</span>
    `;
    btn.addEventListener("click", (ev) => {
      if (btn.dataset.suppressClick === "1") {
        ev.preventDefault();
        ev.stopPropagation();
        delete btn.dataset.suppressClick;
        return;
      }
      selectStep(id);
    });
    if (writable() && !yamlBroken) {
      btn.classList.add("draggable");
      btn.addEventListener("pointerdown", (ev) => {
        if (ev.target.closest(".link-handle")) return;
        onCardPointerDown(ev, id, btn);
      });
      if (String(step.type || "") !== "terminal") {
        const outs = listOutgoingEdgesMarked(step);
        const primaryEdge = outs.find((e) => e.primary) || null;
        const handle = document.createElement("button");
        handle.type = "button";
        handle.className = "link-handle";
        handle.title =
          "拖到目標步驟設定 next；若已有連線，放到空白處可刪除";
        handle.setAttribute("aria-label", `從 ${id} 拉線設定 next`);
        handle.addEventListener("pointerdown", (ev) => {
          onLinkPointerDown(ev, id, primaryEdge, { rewire: Boolean(primaryEdge) });
        });
        btn.appendChild(handle);

        // Extra exits without a drawn target still need a source port
        const extras = outs.filter((e) => !e.primary);
        extras.forEach((edge, i) => {
          const alt = document.createElement("button");
          alt.type = "button";
          alt.className = `link-handle alt${
            edge.kind === "onError" ? " danger" : ""
          }`;
          alt.title = `拖曳改「${edge.label}」；放到空白處刪除`;
          alt.setAttribute(
            "aria-label",
            `從 ${id}.${edge.label} 拉線`
          );
          alt.style.setProperty("--alt-i", String(i));
          alt.addEventListener("pointerdown", (ev) => {
            onLinkPointerDown(ev, id, edge, { rewire: true });
          });
          btn.appendChild(alt);
        });
      }
    }
    cardsEl.appendChild(btn);
  }
}

function canvasPoint(clientX, clientY) {
  const rect = canvasWrap.getBoundingClientRect();
  return {
    x: clientX - rect.left + canvasWrap.scrollLeft,
    y: clientY - rect.top + canvasWrap.scrollTop,
  };
}

function minDrawX() {
  let minX = 0;
  for (const p of positions.values()) minX = Math.min(minX, p.x);
  return minX;
}

/** @returns {{ index: number, left: number, top: number }[]} */
function mainChainDropSlots(movingId) {
  if (!ast) return [];
  const chain = listMainChain(ast);
  if (!chain.includes(movingId)) return [];
  const steps = ensureSteps();
  const minX = minDrawX();
  /** @type {{ index: number, left: number, top: number }[]} */
  const slots = [];
  for (let index = 0; index <= chain.length; index += 1) {
    const next = moveIndex(chain, movingId, index);
    if (!next) continue;
    let valid = true;
    for (let i = 0; i < next.length - 1; i += 1) {
      if (String(steps[next[i]]?.type || "") === "terminal") {
        valid = false;
        break;
      }
    }
    if (!valid) continue;
    const y = ORIGIN_Y + index * CELL_H - GAP_Y / 2 - 3;
    const left = ORIGIN_X + (0 - minX) * CELL_W;
    slots.push({ index, left, top: Math.max(4, y) });
  }
  return slots;
}

function clearDropSlots() {
  cardsEl.querySelectorAll(".drop-slot").forEach((el) => el.remove());
}

function showDropSlots(movingId) {
  clearDropSlots();
  for (const slot of mainChainDropSlots(movingId)) {
    const el = document.createElement("div");
    el.className = "drop-slot";
    el.dataset.index = String(slot.index);
    el.style.left = `${slot.left}px`;
    el.style.top = `${slot.top}px`;
    el.style.width = `${CARD_W}px`;
    cardsEl.appendChild(el);
  }
}

function highlightNearestSlot(clientX, clientY) {
  const pt = canvasPoint(clientX, clientY);
  const slots = [...cardsEl.querySelectorAll(".drop-slot")];
  let best = null;
  let bestDist = Infinity;
  for (const el of slots) {
    const left = Number.parseFloat(el.style.left) || 0;
    const top = Number.parseFloat(el.style.top) || 0;
    const cx = left + CARD_W / 2;
    const cy = top + 4;
    const dist = Math.hypot(pt.x - cx, pt.y - cy);
    el.classList.toggle("active", false);
    if (dist < bestDist) {
      bestDist = dist;
      best = el;
    }
  }
  if (best && bestDist < CELL_H * 0.65) {
    best.classList.add("active");
    return Number(best.dataset.index);
  }
  return null;
}

function onCardPointerDown(ev, id, el) {
  if (!writable() || yamlBroken || ev.button !== 0) return;
  if (
    ev.target.closest(
      ".edge-insert, .link-handle, .edge-end-handle, .edge-delete, .link-delete-zone"
    )
  ) {
    return;
  }
  const p = canvasPoint(ev.clientX, ev.clientY);
  const left = Number.parseFloat(el.style.left) || 0;
  const top = Number.parseFloat(el.style.top) || 0;
  drag = {
    mode: "move",
    id,
    pointerId: ev.pointerId,
    startX: ev.clientX,
    startY: ev.clientY,
    grabDX: p.x - left,
    grabDY: p.y - top,
    active: false,
    moved: false,
    el,
  };
  try {
    el.setPointerCapture(ev.pointerId);
  } catch {
    /* ignore */
  }
}

/**
 * @param {PointerEvent} ev
 * @param {string} fromId
 * @param {import("./lib/edges.js").Edge | null} edge
 * @param {{ originX?: number, originY?: number, rewire?: boolean }} [opts]
 */
function onLinkPointerDown(ev, fromId, edge, opts = {}) {
  if (!writable() || yamlBroken || ev.button !== 0) return;
  ev.preventDefault();
  ev.stopPropagation();
  const fromEl = cardsEl.querySelector(`[data-id="${CSS.escape(fromId)}"]`);
  if (!fromEl) return;
  const fr = fromEl.getBoundingClientRect();
  const origin =
    opts.originX != null && opts.originY != null
      ? { x: opts.originX, y: opts.originY }
      : canvasPoint(fr.left + fr.width / 2, fr.bottom - 2);
  const ns = "http://www.w3.org/2000/svg";
  const path = document.createElementNS(ns, "path");
  path.setAttribute("class", "link-preview");
  path.setAttribute("fill", "none");
  path.setAttribute(
    "stroke",
    edge?.kind === "onError" ? "var(--danger)" : "var(--accent)"
  );
  path.setAttribute("stroke-width", "2.25");
  path.setAttribute("stroke-dasharray", "6 4");
  path.setAttribute(
    "marker-end",
    edge?.kind === "onError" ? "url(#arrow-danger)" : "url(#arrow-primary)"
  );
  svgEl.appendChild(path);

  const canDelete = Boolean(
    opts.rewire || (edge && edge.to) || getPrimaryNext(ensureSteps()[fromId])
  );

  // Dim the existing wire being rewired
  if (edge?.to) {
    svgEl.querySelectorAll("path").forEach((p) => {
      if (
        p.dataset.from === fromId &&
        p.dataset.to === edge.to &&
        p.dataset.kind === edge.kind
      ) {
        p.classList.add("edge-dimmed");
      }
    });
  }

  drag = {
    mode: "link",
    fromId,
    edge,
    pointerId: ev.pointerId,
    startX: ev.clientX,
    startY: ev.clientY,
    originX: origin.x,
    originY: origin.y,
    active: false,
    path,
    canDelete,
  };
  try {
    (ev.currentTarget instanceof Element
      ? ev.currentTarget
      : fromEl
    ).setPointerCapture(ev.pointerId);
  } catch {
    /* ignore */
  }
  selectedId = fromId;
  renderInspector();
  canvasWrap.classList.add("is-linking");
  if (canDelete) showLinkDeleteZone(true);
}

function showLinkDeleteZone(on) {
  let zone = document.getElementById("link-delete-zone");
  if (!on) {
    zone?.remove();
    return;
  }
  if (!zone) {
    zone = document.createElement("div");
    zone.id = "link-delete-zone";
    zone.className = "link-delete-zone";
    zone.textContent = "放到此處刪除連線";
    canvasWrap.appendChild(zone);
  }
  zone.classList.remove("active");
}

function hitTestDeleteZone(clientX, clientY) {
  const zone = document.getElementById("link-delete-zone");
  if (!zone) return false;
  const r = zone.getBoundingClientRect();
  return (
    clientX >= r.left &&
    clientX <= r.right &&
    clientY >= r.top &&
    clientY <= r.bottom
  );
}

function clearLinkTargets() {
  cardsEl
    .querySelectorAll(".step-card.link-target")
    .forEach((el) => el.classList.remove("link-target"));
  document
    .getElementById("link-delete-zone")
    ?.classList.remove("active");
}

function hitTestStepId(clientX, clientY) {
  const stack = document.elementsFromPoint(clientX, clientY);
  for (const node of stack) {
    if (!(node instanceof Element)) continue;
    if (node.closest(".link-delete-zone")) return null;
    const card = node.closest(".step-card");
    if (card && card instanceof HTMLElement && card.dataset.id) {
      return card.dataset.id;
    }
  }
  return null;
}

function updateLinkPreview(clientX, clientY) {
  if (!drag || drag.mode !== "link" || !drag.path) return;
  const pt = canvasPoint(clientX, clientY);
  const x1 = drag.originX;
  const y1 = drag.originY;
  const x2 = pt.x;
  const y2 = pt.y;
  const midY = (y1 + y2) / 2;
  drag.path.setAttribute(
    "d",
    `M ${x1} ${y1} C ${x1} ${midY}, ${x2} ${midY}, ${x2} ${y2}`
  );
  clearLinkTargets();
  if (hitTestDeleteZone(clientX, clientY)) {
    document.getElementById("link-delete-zone")?.classList.add("active");
    return;
  }
  const over = hitTestStepId(clientX, clientY);
  if (over && over !== drag.fromId) {
    const el = cardsEl.querySelector(`[data-id="${CSS.escape(over)}"]`);
    el?.classList.add("link-target");
  } else if (drag.canDelete && !over) {
    // Hint: empty canvas will delete
    document.getElementById("link-delete-zone")?.classList.add("active");
  }
}

function clearEdge(fromId, edge) {
  const steps = ensureSteps();
  const from = steps[fromId];
  if (!from) return false;
  if (edge) setEdgeTarget(from, edge, "");
  else setPrimaryNext(from, "");
  return true;
}

function deleteEdge(fromId, edge) {
  if (!ast || !writable() || yamlBroken) return;
  if (!clearEdge(fromId, edge)) return;
  selectedId = fromId;
  markDirty();
  computeLayout(ast, { apply: true });
  positions = resolvePositions(ast);
  renderAll();
  runValidate(false);
  setStatus(`已刪除 ${fromId}.${edge?.label || "next"} → ${edge?.to || ""}`, "ok");
}

function endLinkDrag(ev, commit) {
  if (!drag || drag.mode !== "link") return;
  const state = drag;
  drag = null;
  canvasWrap.classList.remove("is-linking");
  clearLinkTargets();
  showLinkDeleteZone(false);
  state.path?.remove();
  const captureEl =
    document.elementFromPoint(state.startX, state.startY) ||
    cardsEl.querySelector(`[data-id="${CSS.escape(state.fromId)}"]`);
  try {
    if (captureEl instanceof Element) {
      captureEl.releasePointerCapture(state.pointerId);
    }
  } catch {
    /* ignore */
  }
  const fromCard = cardsEl.querySelector(
    `[data-id="${CSS.escape(state.fromId)}"]`
  );
  if (fromCard) fromCard.dataset.suppressClick = "1";

  if (!commit || !ast || !state.active) {
    renderGraph();
    return;
  }

  const wantDelete =
    hitTestDeleteZone(ev.clientX, ev.clientY) ||
    (!hitTestStepId(ev.clientX, ev.clientY) && state.canDelete);
  const toId = hitTestStepId(ev.clientX, ev.clientY);
  const steps = ensureSteps();
  const from = steps[state.fromId];
  if (!from) {
    renderGraph();
    return;
  }

  const label = state.edge?.label || "next";

  // Drop on self / delete zone / empty (when rewiring) → clear
  if (toId === state.fromId || wantDelete) {
    if (!state.canDelete && toId !== state.fromId) {
      renderGraph();
      setStatus("拉線取消（請放到目標步驟上）");
      return;
    }
    clearEdge(state.fromId, state.edge);
    selectedId = state.fromId;
    markDirty();
    computeLayout(ast, { apply: true });
    positions = resolvePositions(ast);
    renderAll();
    runValidate(false);
    setStatus(`已刪除 ${state.fromId}.${label} 連線`, "ok");
    return;
  }

  if (!toId || !steps[toId]) {
    renderGraph();
    setStatus("拉線取消（請放到目標步驟上）");
    return;
  }

  const prev = state.edge
    ? state.edge.to
    : getPrimaryNext(from) || "";
  if (prev === toId) {
    renderGraph();
    return;
  }

  if (state.edge) setEdgeTarget(from, { ...state.edge }, toId);
  else setPrimaryNext(from, toId);

  selectedId = state.fromId;
  markDirty();
  computeLayout(ast, { apply: true });
  positions = resolvePositions(ast);
  renderAll();
  runValidate(false);
  setStatus(`已將 ${state.fromId}.${label} → ${toId}`, "ok");
}

function endMoveDrag(ev, commit) {
  if (!drag || drag.mode !== "move") return;
  const state = drag;
  drag = null;
  canvasWrap.classList.remove("is-dragging");
  const activeIndex = commit
    ? highlightNearestSlot(ev.clientX, ev.clientY)
    : null;
  clearDropSlots();
  if (state.el) {
    state.el.classList.remove("dragging");
    try {
      state.el.releasePointerCapture(state.pointerId);
    } catch {
      /* ignore */
    }
  }
  if (!state.active) return;
  if (state.el) state.el.dataset.suppressClick = "1";
  if (!commit || !ast) {
    renderGraph();
    return;
  }

  const chain = listMainChain(ast);
  if (activeIndex != null && chain.includes(state.id)) {
    const result = reorderMainChain(ast, state.id, activeIndex);
    if (!result.ok) {
      renderGraph();
      setStatus(result.reason || "無法重排", "bad");
      return;
    }
    computeLayout(ast, { apply: true });
    positions = resolvePositions(ast);
    selectedId = state.id;
    markDirty();
    renderAll();
    runValidate(false);
    setStatus(`已拖曳重排主鏈（${result.chain.join(" → ")}）`, "ok");
    return;
  }

  // Free snap: write ui.x / ui.y (layout only)
  const pt = canvasPoint(ev.clientX, ev.clientY);
  const minX = minDrawX();
  const gridX = Math.round((pt.x - ORIGIN_X - CARD_W / 2) / CELL_W) + minX;
  const gridY = Math.max(
    0,
    Math.round((pt.y - ORIGIN_Y - CARD_H / 2) / CELL_H)
  );
  const steps = ensureSteps();
  const step = steps[state.id];
  if (!step) {
    renderGraph();
    return;
  }
  const prev = positions.get(state.id) || { x: 0, y: 0 };
  if (prev.x === gridX && prev.y === gridY) {
    renderGraph();
    return;
  }
  const ui =
    step.ui && typeof step.ui === "object" && !Array.isArray(step.ui)
      ? { ...step.ui }
      : {};
  ui.x = gridX;
  ui.y = gridY;
  ui.layout = "wfedit.v1";
  step.ui = ui;
  positions = resolvePositions(ast);
  selectedId = state.id;
  markDirty();
  renderAll();
  setStatus(`已移動 ${state.id} → (${gridX}, ${gridY})`, "ok");
}

function endDrag(ev, commit) {
  if (!drag) return;
  if (drag.mode === "link") endLinkDrag(ev, commit);
  else endMoveDrag(ev, commit);
}

window.addEventListener("pointermove", (ev) => {
  if (!drag || ev.pointerId !== drag.pointerId) return;
  if (drag.mode === "link") {
    const dx = ev.clientX - drag.startX;
    const dy = ev.clientY - drag.startY;
    if (!drag.active && Math.hypot(dx, dy) >= DRAG_THRESHOLD) {
      drag.active = true;
    }
    if (drag.active) updateLinkPreview(ev.clientX, ev.clientY);
    return;
  }
  const dx = ev.clientX - drag.startX;
  const dy = ev.clientY - drag.startY;
  if (!drag.active) {
    if (Math.hypot(dx, dy) < DRAG_THRESHOLD) return;
    drag.active = true;
    drag.moved = true;
    selectedId = drag.id;
    renderInspector();
    drag.el?.classList.add("dragging");
    canvasWrap.classList.add("is-dragging");
    showDropSlots(drag.id);
  }
  const pt = canvasPoint(ev.clientX, ev.clientY);
  if (drag.el) {
    drag.el.style.left = `${pt.x - drag.grabDX}px`;
    drag.el.style.top = `${pt.y - drag.grabDY}px`;
  }
  highlightNearestSlot(ev.clientX, ev.clientY);
});

window.addEventListener("pointerup", (ev) => {
  if (!drag || ev.pointerId !== drag.pointerId) return;
  endDrag(ev, true);
});

window.addEventListener("pointercancel", (ev) => {
  if (!drag || ev.pointerId !== drag.pointerId) return;
  endDrag(ev, false);
});

function selectStep(id) {
  selectedId = id;
  renderGraph();
  renderInspector();
}

function renderInspector() {
  const steps = ast ? ensureSteps() : {};
  const step = selectedId ? steps[selectedId] : null;
  if (!step) {
    inspectorTitle.textContent = "未選取";
    inspectorBody.innerHTML = `<p class="empty">點選步驟卡以編輯</p>`;
    return;
  }
  inspectorTitle.textContent = selectedId;
  const disabled = !writable() || yamlBroken ? "disabled" : "";
  const typeOpts = STEP_TYPES.map(
    (t) =>
      `<option value="${t}" ${step.type === t ? "selected" : ""}>${t}</option>`
  ).join("");

  let typeFields = "";
  const type = String(step.type || "");
  if (type === "action") {
    typeFields = `
      <label class="field"><span>builtin</span><input data-k="builtin" value="${escapeHtml(step.builtin || "")}" ${disabled} /></label>
      <label class="field"><span>runFile</span><input data-k="runFile" value="${escapeHtml(step.runFile || "")}" ${disabled} /></label>
      <label class="field"><span>run</span><textarea data-k="run" ${disabled}>${escapeHtml(step.run || "")}</textarea></label>
      <label class="field"><span>next</span><input data-k="next" value="${escapeHtml(step.next || "")}" ${disabled} /></label>
      <label class="field"><span>onError</span><input data-k="onError" value="${escapeHtml(step.onError || "")}" ${disabled} /></label>
      <button type="button" id="btn-extract-run" class="ghost" ${disabled || !step.run ? "disabled" : ""}>抽成 runFile</button>
    `;
  } else if (type === "await_ui") {
    typeFields = `
      <label class="field"><span>on（YAML map）</span><textarea data-k="onYaml" ${disabled}>${escapeHtml(dumpYaml(step.on || {}))}</textarea></label>
      <label class="field"><span>form（YAML）</span><textarea data-k="formYaml" ${disabled}>${escapeHtml(step.form ? dumpYaml(step.form) : "")}</textarea></label>
    `;
  } else if (type === "choice") {
    typeFields = `
      <label class="field"><span>when（YAML 列表）</span><textarea data-k="whenYaml" ${disabled}>${escapeHtml(dumpYaml(step.when || []))}</textarea></label>
      <label class="field"><span>else</span><input data-k="else" value="${escapeHtml(step.else || "")}" ${disabled} /></label>
    `;
  } else if (type === "timer") {
    typeFields = `
      <label class="field"><span>delayMs</span><input data-k="delayMs" type="number" value="${step.delayMs ?? ""}" ${disabled} /></label>
      <label class="field"><span>at</span><input data-k="at" value="${escapeHtml(step.at || "")}" ${disabled} /></label>
      <label class="field"><span>next</span><input data-k="next" value="${escapeHtml(step.next || "")}" ${disabled} /></label>
    `;
  } else if (type === "await_child") {
    typeFields = `
      <label class="field"><span>spawn（YAML）</span><textarea data-k="spawnYaml" ${disabled}>${escapeHtml(step.spawn ? dumpYaml(step.spawn) : "")}</textarea></label>
      <label class="field"><span>on（YAML）</span><textarea data-k="onYaml" ${disabled}>${escapeHtml(step.on ? dumpYaml(step.on) : "")}</textarea></label>
      <label class="field"><span>next</span><input data-k="next" value="${escapeHtml(step.next || "")}" ${disabled} /></label>
    `;
  } else if (type === "terminal") {
    typeFields = `
      <label class="field"><span>outcome</span>
        <select data-k="outcome" ${disabled}>
          ${["completed", "failed", "cancelled"]
            .map(
              (o) =>
                `<option value="${o}" ${step.outcome === o || (!step.outcome && o === "completed") ? "selected" : ""}>${o}</option>`
            )
            .join("")}
        </select>
      </label>
      <label class="field"><span>summary</span><input data-k="summary" value="${escapeHtml(step.summary || "")}" ${disabled} /></label>
    `;
  }

  const edges = listOutgoingEdgesMarked(step);
  const edgeRows = edges
    .map((e, i) => {
      const opts = Object.keys(steps)
        .map(
          (sid) =>
            `<option value="${escapeHtml(sid)}" ${
              sid === e.to ? "selected" : ""
            }>${escapeHtml(sid)}</option>`
        )
        .join("");
      return `<label class="field edge-row"><span>${escapeHtml(
        e.kind
      )}${e.primary ? " ★" : ""} · ${escapeHtml(e.label)}</span>
        <select data-edge="${i}" ${disabled}>${opts}</select></label>`;
    })
    .join("");

  inspectorBody.innerHTML = `
    <label class="field"><span>stepId</span><input data-k="stepId" value="${escapeHtml(selectedId)}" ${disabled} /></label>
    <label class="field"><span>type</span><select data-k="type" ${disabled}>${typeOpts}</select></label>
    <label class="field"><span>title</span><input data-k="title" value="${escapeHtml(step.title || "")}" ${disabled} /></label>
    ${typeFields}
    <label class="field"><span>ui.primaryNext</span><input data-k="primaryNext" value="${escapeHtml(step.ui?.primaryNext || "")}" ${disabled} /></label>
    ${
      edges.length
        ? `<div class="edge-block"><span class="edge-block-title">出邊（改目標＝編圖）</span>${edgeRows}</div>`
        : ""
    }
    <div class="field-row">
      <button type="button" id="btn-apply-step" class="primary" ${disabled}>套用</button>
      <button type="button" id="btn-del-step" class="ghost" ${disabled}>刪除步驟</button>
    </div>
  `;

  document.getElementById("btn-apply-step")?.addEventListener("click", () => {
    applyInspector();
  });
  document.getElementById("btn-del-step")?.addEventListener("click", () => {
    deleteStep(selectedId);
  });
  document.getElementById("btn-extract-run")?.addEventListener("click", () => {
    void extractRunFile(selectedId);
  });
  for (const sel of inspectorBody.querySelectorAll("select[data-edge]")) {
    sel.addEventListener("change", () => {
      const idx = Number(sel.getAttribute("data-edge"));
      const edge = edges[idx];
      const newTo = sel.value;
      if (!edge || !newTo || !steps[newTo]) return;
      setEdgeTarget(step, edge, newTo);
      markDirty();
      renderAll();
      setStatus(`已改 ${edge.kind}/${edge.label} → ${newTo}`, "ok");
      runValidate(false);
    });
  }
}

async function extractRunFile(id) {
  if (!ast || !writable() || !id) return;
  const steps = ensureSteps();
  const step = steps[id];
  if (!step || typeof step.run !== "string" || !step.run.trim()) {
    setStatus("沒有可抽的 run", "bad");
    return;
  }
  const path = `steps/${id}.js`;
  const body = `/** Extracted from workflow step \`${id}\` */\nexport default async function run(ctx) {\n${indentBlock(step.run, 2)}\n}\n`;
  if (session === "tool") {
    try {
      await api("/api/tool/file", {
        method: "PUT",
        body: JSON.stringify({ path, content: body }),
      });
    } catch (e) {
      setStatus(
        (e instanceof Error ? e.message : String(e)) +
          "（需 grant 含 steps/）",
        "bad"
      );
      return;
    }
  }
  step.runFile = `./${path}`;
  delete step.run;
  delete step.builtin;
  markDirty();
  renderAll();
  setStatus(
    session === "tool"
      ? `已抽成 ${path} 並改引用`
      : `已改 runFile→./${path}（standalone 未寫檔；掛工具後再抽一次以落盤）`,
    "ok"
  );
}

function indentBlock(src, n) {
  const pad = " ".repeat(n);
  return String(src)
    .replace(/\r\n/g, "\n")
    .split("\n")
    .map((line) => (line ? pad + line : line))
    .join("\n");
}

function readInspectorValue(el) {
  if (el.type === "number") {
    const n = el.value === "" ? undefined : Number(el.value);
    return Number.isFinite(n) ? n : undefined;
  }
  return el.value;
}

function applyInspector() {
  if (!ast || !writable() || yamlBroken || !selectedId) return;
  const steps = ensureSteps();
  const step = steps[selectedId];
  if (!step) return;

  const fields = inspectorBody.querySelectorAll("[data-k]");
  /** @type {Record<string, HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>} */
  const map = {};
  for (const el of fields) {
    map[el.getAttribute("data-k")] = el;
  }

  let newId = selectedId;
  if (map.stepId) {
    const id = String(map.stepId.value || "").trim();
    if (!/^[a-z][a-z0-9_]*$/.test(id)) {
      setStatus("stepId 須符合 ^[a-z][a-z0-9_]*$", "bad");
      return;
    }
    if (id !== selectedId) {
      if (steps[id]) {
        setStatus("stepId 已存在", "bad");
        return;
      }
      steps[id] = step;
      delete steps[selectedId];
      if (ast.start === selectedId) ast.start = id;
      // rewrite edges pointing to old id
      for (const s of Object.values(steps)) {
        rewriteRefs(s, selectedId, id);
      }
      newId = id;
    }
  }

  if (map.type) step.type = map.type.value;
  if (map.title) {
    const t = map.title.value.trim();
    if (t) step.title = t;
    else delete step.title;
  }

  const type = String(step.type || "");
  if (type === "action") {
    setStr(step, "builtin", map.builtin?.value);
    setStr(step, "runFile", map.runFile?.value);
    setStr(step, "run", map.run?.value);
    setStr(step, "next", map.next?.value);
    setStr(step, "onError", map.onError?.value);
  } else if (type === "await_ui") {
    const on = parseYamlField(map.onYaml?.value, {});
    if (!on.ok) return setStatus(on.error, "bad");
    step.on = on.value;
    if (map.formYaml?.value.trim()) {
      const form = parseYamlField(map.formYaml.value, null);
      if (!form.ok) return setStatus(form.error, "bad");
      step.form = form.value;
    } else delete step.form;
  } else if (type === "choice") {
    const when = parseYamlField(map.whenYaml?.value, []);
    if (!when.ok) return setStatus(when.error, "bad");
    step.when = when.value;
    setStr(step, "else", map.else?.value);
  } else if (type === "timer") {
    const delay = readInspectorValue(map.delayMs);
    if (delay != null) step.delayMs = delay;
    else delete step.delayMs;
    setStr(step, "at", map.at?.value);
    setStr(step, "next", map.next?.value);
  } else if (type === "await_child") {
    if (map.spawnYaml?.value.trim()) {
      const sp = parseYamlField(map.spawnYaml.value, {});
      if (!sp.ok) return setStatus(sp.error, "bad");
      step.spawn = sp.value;
    }
    if (map.onYaml?.value.trim()) {
      const on = parseYamlField(map.onYaml.value, {});
      if (!on.ok) return setStatus(on.error, "bad");
      step.on = on.value;
    } else delete step.on;
    setStr(step, "next", map.next?.value);
  } else if (type === "terminal") {
    if (map.outcome) step.outcome = map.outcome.value;
    setStr(step, "summary", map.summary?.value);
    delete step.next;
  }

  if (map.primaryNext) {
    const pn = map.primaryNext.value.trim();
    const ui =
      step.ui && typeof step.ui === "object" ? { ...step.ui } : {};
    if (pn) ui.primaryNext = pn;
    else delete ui.primaryNext;
    if (Object.keys(ui).length) step.ui = ui;
    else delete step.ui;
  }

  selectedId = newId;
  markDirty();
  renderAll();
  setStatus("已套用步驟", "ok");
  runValidate(false);
}

function parseYamlField(text, fallback) {
  if (text == null || !String(text).trim()) return { ok: true, value: fallback };
  const r = parseYamlText(text);
  if (!r.ok) return r;
  return { ok: true, value: r.value ?? fallback };
}

function setStr(obj, key, value) {
  const v = String(value || "").trim();
  if (v) obj[key] = v;
  else delete obj[key];
}

function rewriteRefs(step, from, to) {
  if (step.next === from) step.next = to;
  if (step.else === from) step.else = to;
  if (step.onError === from) step.onError = to;
  if (step.on && typeof step.on === "object") {
    for (const k of Object.keys(step.on)) {
      if (step.on[k] === from) step.on[k] = to;
    }
  }
  if (Array.isArray(step.when)) {
    for (const row of step.when) {
      if (row && row.next === from) row.next = to;
    }
  }
  if (step.timeout && step.timeout.next === from) step.timeout.next = to;
  if (step.ui?.primaryNext === from) step.ui.primaryNext = to;
}

function allocStepId(prefix = "step") {
  const steps = ensureSteps();
  let n = 1;
  let id = `${prefix}_${n}`;
  while (steps[id]) {
    n += 1;
    id = `${prefix}_${n}`;
  }
  return id;
}

/** Point one outgoing edge at `newTo` (empty clears that exit). */
function setEdgeTarget(step, edge, newTo) {
  if (!step || !edge) return;
  const target = String(newTo || "").trim();
  if (edge.kind === "next") {
    if (target) step.next = target;
    else delete step.next;
  } else if (edge.kind === "else") {
    if (target) step.else = target;
    else delete step.else;
  } else if (edge.kind === "onError") {
    if (target) step.onError = target;
    else delete step.onError;
  } else if (edge.kind === "on") {
    if (!step.on || typeof step.on !== "object") step.on = {};
    if (target) step.on[edge.label] = target;
    else delete step.on[edge.label];
  } else if (edge.kind === "when") {
    const when = Array.isArray(step.when) ? step.when : [];
    const row = when.find(
      (r) => r && String(r.expr ?? "when") === edge.label && r.next === edge.to
    );
    if (row) {
      if (target) row.next = target;
      else delete row.next;
    } else if (when[0]) {
      if (target) when[0].next = target;
      else delete when[0].next;
    }
  } else if (edge.kind === "timeout" && step.timeout) {
    if (target) step.timeout.next = target;
    else delete step.timeout.next;
  }
}

/** After insert/delete/rewire: rewrite ui so cards don't stack on old coords. */
function relayoutStructure() {
  if (!ast) return;
  computeLayout(ast, { apply: true });
  positions = resolvePositions(ast);
}

function insertOnEdge(fromId, edge) {
  if (!ast || !writable() || yamlBroken) return;
  const steps = ensureSteps();
  const from = steps[fromId];
  if (!from || !edge?.to) return;
  const id = allocStepId();
  const oldTo = edge.to;
  steps[id] = {
    type: "action",
    title: "新步驟",
    builtin: "noop",
    next: oldTo,
  };
  setEdgeTarget(from, edge, id);
  selectedId = id;
  relayoutStructure();
  markDirty();
  renderAll();
  setStatus(`已在 ${fromId} → ${oldTo} 插入 ${id}`, "ok");
  runValidate(false);
}

function deleteStep(id) {
  if (!ast || !writable() || !id) return;
  const steps = ensureSteps();
  if (!steps[id]) return;
  if (ast.start === id) {
    setStatus("不能刪除 start 步驟；請先改 start", "bad");
    return;
  }
  delete steps[id];
  selectedId = "";
  relayoutStructure();
  markDirty();
  renderAll();
  setStatus(`已刪除 ${id}`, "ok");
}

function addStep() {
  if (!ast || !writable() || yamlBroken) return;
  const steps = ensureSteps();
  const id = allocStepId();
  steps[id] = { type: "action", title: "新步驟", builtin: "noop", next: "" };
  const anchor =
    selectedId && steps[selectedId] ? selectedId : String(ast.start || "");
  if (anchor && steps[anchor] && steps[anchor].type !== "terminal") {
    const prevNext = steps[anchor].next;
    if (steps[anchor].type === "action" || steps[anchor].type === "timer") {
      steps[id].next = prevNext || "";
      steps[anchor].next = id;
    }
  }
  selectedId = id;
  relayoutStructure();
  markDirty();
  renderAll();
  setStatus(`已新增 ${id}`, "ok");
}

function applyLayout() {
  if (!ast || !writable()) return;
  computeLayout(ast, { apply: true });
  positions = resolvePositions(ast);
  markDirty();
  renderAll();
  setStatus("已整理版面（寫入 ui.x／ui.y）", "ok");
}

function setView(next) {
  view = next;
  btnGraph.classList.toggle("active", view === "graph");
  btnYaml.classList.toggle("active", view === "yaml");
  if (view === "graph") {
    graphPane.classList.remove("hidden");
    graphPane.hidden = false;
    yamlPane.classList.remove("visible");
    yamlPane.hidden = true;
    if (yamlBroken) {
      setStatus("YAML 無效：圖為上次成功狀態（唯讀直到 YAML 修好）", "bad");
    } else if (ast) {
      // sync yaml → already in ast
      renderGraph();
      renderInspector();
    }
  } else {
    graphPane.hidden = true;
    yamlPane.hidden = false;
    yamlPane.classList.add("visible");
    if (ast && !yamlBroken) {
      yamlEditor.value = dumpYaml(ast);
    }
  }
  syncChrome();
}

function onYamlInput() {
  if (!writable()) return;
  const text = yamlEditor.value;
  const parsed = parseYamlText(text);
  if (!parsed.ok) {
    yamlBroken = true;
    markDirty();
    setStatus(`YAML 解析失敗：${parsed.error}`, "bad");
    syncChrome();
    return;
  }
  if (!parsed.value || typeof parsed.value !== "object") {
    yamlBroken = true;
    markDirty();
    setStatus("YAML 根節點必須是物件", "bad");
    return;
  }
  yamlBroken = false;
  setAstFromDoc(parsed.value);
  markDirty();
  setStatus("YAML 已套用至 AST", "ok");
  runValidate(false);
}

function renderAll() {
  if (view === "graph") {
    renderGraph();
    renderInspector();
  } else if (ast && !yamlBroken) {
    yamlEditor.value = dumpYaml(ast);
  }
  syncChrome();
}

async function loadSample() {
  const res = await fetch("./sample-workflow.yaml");
  const text = await res.text();
  const parsed = parseYamlText(text);
  if (!parsed.ok) {
    setStatus(parsed.error, "bad");
    return;
  }
  setAstFromDoc(parsed.value);
  dirty = false;
  selectedId = String(ast?.start || "");
  renderAll();
  runValidate(false);
  setStatus("已載入範例（standalone）", "ok");
}

async function loadGrantAndFile() {
  setStatus("載入授權…");
  const grant = await api("/api/tool/grant");
  session = "tool";
  mode = grant.mode || "read";
  const paths = Array.isArray(grant.paths) ? grant.paths : [];
  focusPath =
    grant.focusPath ||
    paths.find((p) => /workflow\.ya?ml$/i.test(p)) ||
    paths[0] ||
    DEF_PATH;
  syncChrome();
  setStatus("載入檔案…");
  const file = await api(
    "/api/tool/file?" + new URLSearchParams({ path: focusPath })
  );
  const parsed = parseYamlText(file.content ?? "");
  if (!parsed.ok) {
    yamlEditor.value = file.content ?? "";
    yamlBroken = true;
    ast = null;
    contentHash = file.hash || "";
    dirty = false;
    setView("yaml");
    setStatus(`載入的 YAML 無效：${parsed.error}`, "bad");
    syncChrome();
    return;
  }
  setAstFromDoc(parsed.value);
  contentHash = file.hash || "";
  dirty = false;
  selectedId = String(ast?.start || "");
  setView("graph");
  renderAll();
  runValidate(false);
  setStatus(mode === "readwrite" ? "已載入（可編輯）" : "已載入（唯讀）", "ok");
}

async function save() {
  if (session !== "tool" || !focusPath || mode !== "readwrite") return;
  if (yamlBroken || !ast) {
    setStatus("請先修好 YAML／定義再儲存", "bad");
    return;
  }
  if (!runValidate(true)) return;
  const content = dumpYaml(ast);
  setStatus("儲存中…");
  btnSave.disabled = true;
  try {
    const body = { path: focusPath, content };
    if (contentHash) body.expectedHash = contentHash;
    const result = await api("/api/tool/file", {
      method: "PUT",
      body: JSON.stringify(body),
    });
    contentHash = result.hash || "";
    dirty = false;
    syncChrome();
    setStatus("已儲存（註解可能已丟失）", "ok");
  } catch (e) {
    setStatus(e instanceof Error ? e.message : String(e), "bad");
    syncChrome();
  }
}

function bootStandalone() {
  session = "standalone";
  focusPath = DEF_PATH;
  mode = "readwrite";
  contentHash = "";
  dirty = false;
  void loadSample();
}

btnGraph.addEventListener("click", () => setView("graph"));
btnYaml.addEventListener("click", () => setView("yaml"));
btnAdd.addEventListener("click", () => addStep());
btnLayout.addEventListener("click", () => applyLayout());
btnValidate.addEventListener("click", () => runValidate(true));
btnSample.addEventListener("click", () => void loadSample());
btnReload.addEventListener("click", () => {
  if (session === "tool") {
    void loadGrantAndFile().catch((e) =>
      setStatus(e instanceof Error ? e.message : String(e), "bad")
    );
  } else {
    void loadSample();
  }
});
btnSave.addEventListener("click", () => void save());
btnClose.addEventListener("click", () => {
  void api("/api/tool/close", {
    method: "POST",
    body: JSON.stringify({ dirty }),
  })
    .then(() => setStatus("已請求關閉"))
    .catch((e) =>
      setStatus(e instanceof Error ? e.message : String(e), "bad")
    );
});

yamlEditor.addEventListener("input", () => {
  if (!writable()) return;
  dirty = true;
  syncChrome();
  onYamlInput();
});

issuesEl.addEventListener("click", (ev) => {
  const li = ev.target.closest("li[data-step]");
  if (!li) return;
  const id = li.getAttribute("data-step");
  if (id) {
    setView("graph");
    selectStep(id);
  }
});

async function boot() {
  try {
    const health = await api("/api/health");
    if (health.tool) {
      await loadGrantAndFile();
      return;
    }
    bootStandalone();
    setStatus(
      "standalone：可編範例；掛成工具後可編工作沙盒的 workflow.yaml"
    );
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    bootStandalone();
    setStatus(
      msg + "（已改本機試寫；要用工具請從遊樂場掛載）",
      "bad"
    );
  }
}

void boot();
