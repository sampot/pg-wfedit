/**
 * pg-wfedit — vertical workflow.v1 visual editor (Tool SAM).
 * IR: workflow.yaml；不跑引擎（DEC-034 / WFEDIT-SPEC）。
 */

import jsyaml from "https://esm.sh/js-yaml@4.1.0";
import { STEP_TYPES, listOutgoingEdgesMarked } from "./lib/edges.js";
import { validateWorkflow } from "./lib/validate.js";
import { computeLayout, resolvePositions } from "./lib/layout.js";

const DEF_PATH = "workflow.yaml";
const CELL_W = 220;
const CELL_H = 130;
const CARD_W = 188;
const CARD_H = 78;
const ORIGIN_X = 56;
const ORIGIN_Y = 36;

const pathLabel = document.getElementById("path-label");
const modeLabel = document.getElementById("mode-label");
const statusEl = document.getElementById("status");
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
  const shift = -minX;
  return { x: grid.x + shift, y: grid.y };
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
  const width = ORIGIN_X + (cols + 1) * CELL_W;
  const height = ORIGIN_Y + (maxY + 2) * CELL_H + 48;
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
    marker.setAttribute("refX", "9");
    marker.setAttribute("refY", "5");
    marker.setAttribute("markerWidth", "7");
    marker.setAttribute("markerHeight", "7");
    marker.setAttribute("orient", "auto-start-reverse");
    const poly = document.createElementNS(ns, "path");
    poly.setAttribute("d", "M 0 0 L 10 5 L 0 10 z");
    poly.setAttribute("fill", color);
    marker.appendChild(poly);
    defs.appendChild(marker);
  }
  svgEl.appendChild(defs);

  // orphan banner
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
    const y = ORIGIN_Y + (maxY + 1.15) * CELL_H;
    const ban = document.createElement("div");
    ban.className = "orphan-banner";
    ban.style.top = `${y}px`;
    ban.textContent = `孤立步驟（自 start 不可達）：${orphans.join(", ")}`;
    cardsEl.appendChild(ban);
  }

  // edges + insert handles
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
      const y1 = from.y + CARD_H / 2 - 4;
      const y2 = to.y - CARD_H / 2 + 4;
      const midY = (y1 + y2) / 2;
      const sameCol = fromPos.x === toPos.x && toPos.y > fromPos.y;
      const d = sameCol
        ? `M ${from.x} ${y1} C ${from.x} ${midY}, ${to.x} ${midY}, ${to.x} ${y2}`
        : `M ${from.x} ${y1} C ${from.x} ${y1 + 36}, ${to.x} ${y2 - 36}, ${to.x} ${y2}`;

      const path = document.createElementNS(ns, "path");
      path.setAttribute("d", d);
      path.setAttribute("fill", "none");
      const stroke =
        edge.kind === "onError"
          ? "var(--danger)"
          : edge.primary
            ? "var(--accent)"
            : "var(--edge)";
      path.setAttribute("stroke", stroke);
      path.setAttribute("stroke-width", edge.primary ? "2.4" : "1.6");
      path.setAttribute(
        "marker-end",
        edge.kind === "onError"
          ? "url(#arrow-danger)"
          : edge.primary
            ? "url(#arrow-primary)"
            : "url(#arrow-edge)"
      );
      if (edge.kind === "onError") path.setAttribute("stroke-dasharray", "5 4");
      if (!sameCol && toPos.y <= fromPos.y) {
        // back-edge
        path.setAttribute(
          "d",
          `M ${from.x} ${y1} C ${from.x + 50} ${y1 + 20}, ${to.x + 50} ${to.y}, ${to.x + CARD_W / 2 - 8} ${to.y}`
        );
      }
      svgEl.appendChild(path);

      const mx = (from.x + to.x) / 2;
      const my = sameCol ? midY : (y1 + y2) / 2;

      if (edge.label && edge.label !== "next") {
        const label = document.createElementNS(ns, "text");
        label.setAttribute("x", String(mx + 10));
        label.setAttribute("y", String(my - 6));
        label.setAttribute("fill", "var(--branch)");
        label.setAttribute("font-size", "11");
        label.setAttribute("font-weight", edge.primary ? "600" : "400");
        label.textContent = edge.label;
        svgEl.appendChild(label);
      }

      // insert-on-edge (forward edges only)
      if (writable() && !yamlBroken && toPos.y > fromPos.y) {
        const plus = document.createElement("button");
        plus.type = "button";
        plus.className = "edge-insert";
        plus.title = `在 ${id} → ${edge.to} 之間插入`;
        plus.textContent = "+";
        plus.style.left = `${mx - 12}px`;
        plus.style.top = `${my - 12}px`;
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
    const outs = listOutgoingEdgesMarked(step);
    const outHint = outs
      .filter((e) => e.kind !== "onError")
      .map((e) => (e.primary ? `★${e.label || "next"}→${e.to}` : `${e.label || "→"}${e.to}`))
      .slice(0, 3)
      .join(" · ");
    btn.innerHTML = `
      <span class="step-type">${escapeHtml(String(step.type || "?"))}${
        id === start ? " · start" : ""
      }</span>
      <span class="step-id">${escapeHtml(id)}</span>
      ${title ? `<span class="step-title">${escapeHtml(String(title))}</span>` : ""}
      <span class="step-meta">${escapeHtml(stepSummary(step))}</span>
      ${outHint ? `<span class="step-outs">${escapeHtml(outHint)}</span>` : ""}
    `;
    btn.addEventListener("click", () => selectStep(id));
    cardsEl.appendChild(btn);
  }
}

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

  const idOpts = Object.keys(steps)
    .map(
      (sid) =>
        `<option value="${escapeHtml(sid)}">${escapeHtml(sid)}</option>`
    )
    .join("");
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
  void idOpts;
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

/** Point one outgoing edge at `newTo`. */
function setEdgeTarget(step, edge, newTo) {
  if (!step || !edge) return;
  if (edge.kind === "next") step.next = newTo;
  else if (edge.kind === "else") step.else = newTo;
  else if (edge.kind === "onError") step.onError = newTo;
  else if (edge.kind === "on") {
    if (!step.on || typeof step.on !== "object") step.on = {};
    step.on[edge.label] = newTo;
  } else if (edge.kind === "when") {
    const when = Array.isArray(step.when) ? step.when : [];
    const row = when.find(
      (r) => r && String(r.expr ?? "when") === edge.label && r.next === edge.to
    );
    if (row) row.next = newTo;
    else if (when[0]) when[0].next = newTo;
  } else if (edge.kind === "timeout" && step.timeout) {
    step.timeout.next = newTo;
  }
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

void loadGrantAndFile().catch((e) => {
  const code = e && typeof e === "object" && "code" in e ? String(e.code) : "";
  const msg = e instanceof Error ? e.message : String(e);
  const standaloneHint =
    code === "tool_inactive" ||
    code === "not_found" ||
    /env\.TOOL|工具|Not Found|404/i.test(msg);
  bootStandalone();
  if (standaloneHint) {
    setStatus(
      "standalone：可編範例；掛成工具後可編工作沙盒的 workflow.yaml"
    );
    return;
  }
  setStatus(
    msg + "（已改本機試寫；要用工具請從遊樂場掛載）",
    "bad"
  );
});
