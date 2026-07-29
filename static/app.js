const $ = (id) => document.getElementById(id);

const WIDGETS = ["text", "textarea", "number", "checkbox", "select", "json"];
const LABELLED_FIELD = "is_labelled";
const PATH_SEP = ".";
const AUTOSAVE_IDLE_MS = 2500;      // 用户停止输入该时长后才自动保存
const AUTOSAVE_INTERVAL_MS = 20000; // 固定周期兜底自动保存

const state = {
  offset: 0,
  limit: 30,
  total: 0,
  datasetTotal: 0,        // 数据集总条数（不受筛选影响，用于上一条/下一条）
  q: "",
  filterChanged: "any",
  dataFilters: {},
  selectedIndex: null,
  currentRow: null,       // 当前记录的原始数据
  deletedKeys: new Set(), // 本条待删除的 key
  extraKeys: [],          // 本条新增的、模版之外的 key
  template: null,
  tplDraft: null,         // 模版编辑器中的草稿
  templateLibrary: null,
  autoSaveTimer: null,
  lastInputAt: 0,         // 最近一次输入时间（用于空闲判定）
  inferConfigs: null,     // /api/infer/config 返回的各模式默认配置
};

const SIDEBAR_COLLAPSED_KEY = "annotation_sidebar_collapsed_v1";

// ---------------------------------------------------------------------------
// 嵌套路径读写：与后端一致，优先把 key 当字面量，否则按 "." 分段寻址
// ---------------------------------------------------------------------------

function isPlainObject(v) {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

function hasByPath(row, path) {
  if (path in row) return true;
  let cur = row;
  for (const part of path.split(PATH_SEP)) {
    if (!isPlainObject(cur) || !(part in cur)) return false;
    cur = cur[part];
  }
  return true;
}

function getByPath(row, path) {
  if (path in row) return row[path];
  let cur = row;
  for (const part of path.split(PATH_SEP)) {
    if (!isPlainObject(cur) || !(part in cur)) return undefined;
    cur = cur[part];
  }
  return cur;
}

function setByPath(row, path, value) {
  if (!path.includes(PATH_SEP) || path in row) {
    row[path] = value;
    return;
  }
  const parts = path.split(PATH_SEP);
  let cur = row;
  for (const part of parts.slice(0, -1)) {
    if (cur[part] === null || cur[part] === undefined) cur[part] = {};
    if (!isPlainObject(cur[part])) {
      row[path] = value;
      return;
    }
    cur = cur[part];
  }
  cur[parts[parts.length - 1]] = value;
}

function deleteByPath(row, path) {
  if (path in row) {
    delete row[path];
    return;
  }
  const parts = path.split(PATH_SEP);
  let cur = row;
  for (const part of parts.slice(0, -1)) {
    if (!isPlainObject(cur) || !(part in cur)) return;
    cur = cur[part];
  }
  if (isPlainObject(cur)) delete cur[parts[parts.length - 1]];
}

// ---------------------------------------------------------------------------
// 基础工具
// ---------------------------------------------------------------------------

function toast(msg, kind = "ok", ms = 2000) {
  const t = $("toast");
  t.textContent = msg;
  t.classList.remove("hidden", "ok", "err");
  t.classList.add(kind === "err" ? "err" : "ok");
  window.clearTimeout(toast._timer);
  toast._timer = window.setTimeout(() => t.classList.add("hidden"), ms);
}

async function apiGet(url) {
  const r = await fetch(url);
  if (!r.ok) throw new Error(await r.text());
  return r.json();
}

async function apiJson(method, url, body) {
  const r = await fetch(url, {
    method,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body ?? {}),
  });
  if (!r.ok) throw new Error(await r.text());
  return r.json();
}

function isSidebarCollapsed() {
  return $("sidebar").classList.contains("collapsed");
}

function setSidebarCollapsed(collapsed) {
  const sb = $("sidebar");
  const btn = $("sidebarToggle");
  sb.classList.toggle("collapsed", collapsed);
  btn.textContent = collapsed ? "展开" : "收起";
  btn.setAttribute("aria-expanded", collapsed ? "false" : "true");
  try {
    localStorage.setItem(SIDEBAR_COLLAPSED_KEY, collapsed ? "1" : "0");
  } catch {}
}

// ---------------------------------------------------------------------------
// 元信息 & 列表
// ---------------------------------------------------------------------------

async function refreshMeta() {
  const m = await apiGet("/api/meta");
  state.datasetTotal = m.total;
  const workingPath = m.working_path || "首次保存时生成时间戳文件";
  $("metaLine").textContent =
    `${m.total} 条 | 已标注 ${m.dirty_count} 条 | 数据: ${m.data_path} | 工作文件: ${workingPath}`;
  $("saveModeSel").value = m.save_mode;
  if ($("tplPathHint")) {
    $("tplPathHint").textContent = `当前模版文件：${m.template_path}（可随代码/数据一起归档，实现复现）`;
  }
}

async function chooseSession() {
  const info = await apiGet("/api/resume-options");
  if (!info.versions.length) {
    await apiJson("POST", "/api/session/select", { action: "restart" });
    return;
  }

  const choices = info.versions.map((v, i) => {
    const savedAt = new Date(v.modified_at_ms).toLocaleString();
    return `${i + 1}. ${v.name}（${savedAt}）`;
  });
  const message = [
    `检测到 ${info.source_path} 的历史标注存档：`,
    "",
    "0. 重新开始",
    ...choices,
    "",
    "请输入编号；取消也将重新开始。",
  ].join("\n");
  const answer = window.prompt(message, "1");
  const index = answer === null ? 0 : Number.parseInt(answer.trim(), 10);

  if (index === 0) {
    await apiJson("POST", "/api/session/select", { action: "restart" });
    return;
  }
  if (Number.isInteger(index) && index >= 1 && index <= info.versions.length) {
    await apiJson("POST", "/api/session/select", {
      action: "resume",
      name: info.versions[index - 1].name,
    });
    return;
  }
  window.alert("编号无效，请重新选择。");
  return chooseSession();
}

function buildRowsUrl() {
  const p = new URLSearchParams();
  p.set("offset", String(state.offset));
  p.set("limit", String(state.limit));
  p.set("changed", state.filterChanged);
  if (state.q) p.set("q", state.q);
  if (Object.keys(state.dataFilters).length) {
    p.set("filters", JSON.stringify(state.dataFilters));
  }
  return `/api/rows?${p.toString()}`;
}

function renderDataFilters() {
  const box = $("dataFilters");
  box.innerHTML = "";
  const fields = (state.template?.fields || []).filter((f) => f.filterable);
  const allowed = new Set(fields.map((f) => f.key));
  for (const key of Object.keys(state.dataFilters)) {
    if (!allowed.has(key)) delete state.dataFilters[key];
  }
  if (!fields.length) {
    box.classList.add("hidden");
    return;
  }
  box.classList.remove("hidden");

  for (const spec of fields) {
    const control = document.createElement("div");
    control.className = "dataFilter";
    const label = document.createElement("label");
    label.textContent = spec.label || spec.key;
    label.title = spec.key;

    let input;
    if (spec.widget === "select" || spec.widget === "checkbox") {
      input = document.createElement("select");
      const choices = spec.widget === "checkbox"
        ? [["", "全部"], ["true", "是"], ["false", "否"]]
        : [["", "全部"], ...(spec.options || []).map((v) => [v, v])];
      for (const [value, text] of choices) {
        const option = document.createElement("option");
        option.value = value;
        option.textContent = text;
        input.appendChild(option);
      }
      const current = state.dataFilters[spec.key];
      input.value = spec.widget === "checkbox" && typeof current === "boolean"
        ? String(current)
        : (current ?? "");
    } else {
      input = document.createElement("input");
      input.type = spec.widget === "number" ? "number" : "text";
      input.placeholder = spec.widget === "number" ? "精确值" : "包含文本";
      input.value = state.dataFilters[spec.key] ?? "";
      input.addEventListener("keydown", (e) => {
        if (e.key === "Enter") applyDataFilter(spec, input.value);
      });
    }
    input.addEventListener("change", () => applyDataFilter(spec, input.value));
    control.appendChild(label);
    control.appendChild(input);
    box.appendChild(control);
  }

  if (Object.keys(state.dataFilters).length) {
    const clear = document.createElement("button");
    clear.type = "button";
    clear.className = "clearFiltersBtn";
    clear.textContent = "清空筛选";
    clear.addEventListener("click", async () => {
      state.dataFilters = {};
      state.offset = 0;
      renderDataFilters();
      await refreshList();
    });
    box.appendChild(clear);
  }
}

async function applyDataFilter(spec, rawValue) {
  if (rawValue === "") {
    delete state.dataFilters[spec.key];
  } else if (spec.widget === "checkbox") {
    state.dataFilters[spec.key] = rawValue === "true";
  } else if (spec.widget === "number") {
    const value = Number(rawValue);
    if (Number.isNaN(value)) return;
    state.dataFilters[spec.key] = value;
  } else {
    state.dataFilters[spec.key] = rawValue;
  }
  state.offset = 0;
  renderDataFilters();
  await refreshList();
}

function renderList(items) {
  const list = $("list");
  list.innerHTML = "";
  for (const it of items) {
    const row = document.createElement("div");
    row.className = "row" + (it.index === state.selectedIndex ? " selected" : "");
    row.tabIndex = 0;

    const idx = document.createElement("div");
    idx.className = "rIdx";
    idx.textContent = `#${it.index + 1}`;

    const main = document.createElement("div");
    main.className = "rMain";
    const t = document.createElement("div");
    t.className = "rTitle";
    t.textContent = it.title || "(空)";
    main.appendChild(t);
    if (it.subtitle) {
      const s = document.createElement("div");
      s.className = "rSub";
      s.textContent = it.subtitle;
      main.appendChild(s);
    }

    const tags = document.createElement("div");
    tags.className = "rowTags";
    if (it.tag) {
      const tag = document.createElement("div");
      tag.className = "tag";
      tag.textContent = it.tag;
      tags.appendChild(tag);
    }
    if (it.dirty) {
      const d = document.createElement("div");
      d.className = "tag dirty";
      d.textContent = "已标注";
      tags.appendChild(d);
    }

    row.appendChild(idx);
    row.appendChild(main);
    row.appendChild(tags);
    row.addEventListener("click", () => selectRow(it.index));
    row.addEventListener("keydown", (e) => {
      if (e.key === "Enter") selectRow(it.index);
    });
    list.appendChild(row);
  }
}

function updateListSummary() {
  const start = Math.min(state.offset + 1, state.total);
  const end = Math.min(state.offset + state.limit, state.total);
  $("listSummary").textContent =
    state.total === 0 ? "无结果" : `显示 ${start}-${end} / 共 ${state.total}`;
  $("prevBtn").disabled = state.offset <= 0;
  $("nextBtn").disabled = state.offset + state.limit >= state.total;
}

async function refreshList() {
  const data = await apiGet(buildRowsUrl());
  state.total = data.total;
  renderList(data.items);
  updateListSummary();
}

// ---------------------------------------------------------------------------
// 标注工作区：按模版渲染字段
// ---------------------------------------------------------------------------

function fieldSpecFor(key) {
  const f = (state.template?.fields || []).find((f) => f.key === key);
  if (f) return f;
  // 模版之外的 key（数据里有但模版没记录，或本条新增的）
  return { key, label: key, hint: "", widget: "json", rows: 4, editable: true, hidden: false, group: "", options: [], _extra: true };
}

function valueToWidgetText(v, widget) {
  if (v === null || v === undefined) return "";
  if (widget === "json") return typeof v === "string" ? v : JSON.stringify(v, null, 2);
  if (typeof v === "string") return v;
  return JSON.stringify(v);
}

function makeFieldEditor(spec, value) {
  const wrap = document.createElement("div");
  wrap.className = "field";
  wrap.dataset.key = spec.key;

  const head = document.createElement("div");
  head.className = "fieldHead";
  const label = document.createElement("div");
  label.className = "fieldLabel";
  label.textContent = spec.label || spec.key;
  if (spec.label && spec.label !== spec.key) {
    const kk = document.createElement("span");
    kk.className = "fieldKey";
    kk.textContent = spec.key;
    label.appendChild(kk);
  }
  if (spec.hint) {
    const hint = document.createElement("span");
    hint.className = "fieldHint";
    hint.textContent = spec.hint;
    label.appendChild(hint);
  }
  head.appendChild(label);

  const headRight = document.createElement("div");
  headRight.className = "fieldHeadRight";
  if (!spec.editable) {
    const ro = document.createElement("span");
    ro.className = "roBadge";
    ro.textContent = "只读";
    headRight.appendChild(ro);
  } else if (spec.key !== LABELLED_FIELD) {
    const del = document.createElement("button");
    del.type = "button";
    del.className = "fieldDelBtn";
    del.textContent = "删除 key";
    del.title = "从当前记录中删除该 key（保存后生效）";
    del.addEventListener("click", () => {
      state.deletedKeys.add(spec.key);
      wrap.classList.add("deleted");
      del.replaceWith(makeUndoBtn(spec.key, wrap));
      scheduleAutoSave();
    });
    headRight.appendChild(del);
  }
  head.appendChild(headRight);
  wrap.appendChild(head);

  let input;
  const w = spec.widget;
  if (w === "textarea" || w === "json") {
    input = document.createElement("textarea");
    input.rows = spec.rows || 4;
    input.value = valueToWidgetText(value, w);
    if (w === "json") input.classList.add("mono");
  } else if (w === "checkbox") {
    input = document.createElement("input");
    input.type = "checkbox";
    input.checked = Boolean(value);
    input.className = "chk";
  } else if (w === "number") {
    input = document.createElement("input");
    input.type = "number";
    input.step = "any";
    input.value = value === null || value === undefined ? "" : String(value);
  } else if (w === "select") {
    input = document.createElement("select");
    const opts = [...(spec.options || [])];
    const cur = value === null || value === undefined ? "" : String(value);
    if (cur && !opts.includes(cur)) opts.unshift(cur);
    const empty = document.createElement("option");
    empty.value = "";
    empty.textContent = "（空）";
    input.appendChild(empty);
    for (const o of opts) {
      const op = document.createElement("option");
      op.value = o;
      op.textContent = o;
      input.appendChild(op);
    }
    input.value = cur;
  } else {
    input = document.createElement("input");
    input.type = "text";
    input.value = valueToWidgetText(value, w);
  }

  input.className = (input.className ? input.className + " " : "") + "fieldInput";
  input.dataset.key = spec.key;
  input.dataset.widget = w;
  if (!spec.editable) input.disabled = true;
  input.addEventListener("input", scheduleAutoSave);
  input.addEventListener("change", scheduleAutoSave);
  wrap.appendChild(input);
  return wrap;
}

function makeUndoBtn(key, wrap) {
  const undo = document.createElement("button");
  undo.type = "button";
  undo.className = "fieldDelBtn";
  undo.textContent = "撤销删除";
  undo.addEventListener("click", () => {
    state.deletedKeys.delete(key);
    wrap.classList.remove("deleted");
    renderDetail();
  });
  return undo;
}

function makeRenderedFieldEditor(spec) {
  const el = makeFieldEditor(spec, getByPath(state.currentRow, spec.key));
  if (state.deletedKeys.has(spec.key)) {
    el.classList.add("deleted");
    const btn = el.querySelector(".fieldDelBtn");
    if (btn) btn.replaceWith(makeUndoBtn(spec.key, el));
  }
  return el;
}

function renderDetail() {
  const row = state.currentRow;
  if (row === null) return;
  const container = $("fieldsContainer");
  container.innerHTML = "";

  const tplFields = state.template?.fields || [];
  const rendered = new Set();

  // 相邻且并列组（group）相同的字段收进同一行；is_labelled 以标题旁的 tag 呈现
  let i = 0;
  while (i < tplFields.length) {
    const spec = tplFields[i];
    rendered.add(spec.key);
    if (spec.key === LABELLED_FIELD || spec.hidden) {
      i += 1;
      continue;
    }
    const group = (spec.group || "").trim();
    if (!group) {
      container.appendChild(makeRenderedFieldEditor(spec));
      i += 1;
      continue;
    }
    const members = [spec];
    let j = i + 1;
    while (j < tplFields.length) {
      const next = tplFields[j];
      if ((next.group || "").trim() !== group) break;
      rendered.add(next.key);
      if (next.key !== LABELLED_FIELD && !next.hidden) members.push(next);
      j += 1;
    }
    const groupBox = document.createElement("div");
    groupBox.className = "fieldGroup";
    groupBox.style.gridTemplateColumns = `repeat(${members.length}, minmax(0, 1fr))`;
    for (const m of members) groupBox.appendChild(makeRenderedFieldEditor(m));
    container.appendChild(groupBox);
    i = j;
  }
  for (const spec of tplFields) rendered.add(spec.key);

  // 数据中存在但模版未收录的 key + 本条新增的 key。
  // 嵌套模版字段（如 "a.b"）视为已覆盖其顶层 key（"a"）。
  const coveredTop = new Set();
  for (const k of rendered) {
    coveredTop.add(k);
    if (k.includes(PATH_SEP) && !(k in row)) coveredTop.add(k.split(PATH_SEP)[0]);
  }
  const extras = [
    ...Object.keys(row).filter((k) => !coveredTop.has(k)),
    ...state.extraKeys.filter((k) => !coveredTop.has(k) && !(k in row)),
  ];
  if (extras.length) {
    const divider = document.createElement("div");
    divider.className = "extraDivider";
    divider.textContent = "模版之外的字段";
    container.appendChild(divider);
    for (const k of extras) container.appendChild(makeRenderedFieldEditor(fieldSpecFor(k)));
  }

  renderLabelledTag();
}

function renderLabelledTag() {
  const tag = $("labelledTag");
  if (state.currentRow === null) {
    tag.classList.add("hidden");
    return;
  }
  const on = Boolean(state.currentRow[LABELLED_FIELD]);
  tag.classList.remove("hidden");
  tag.classList.toggle("on", on);
  tag.textContent = on ? "已标注" : "未标注";
}

async function toggleLabelled() {
  if (state.selectedIndex === null) return;
  const next = !state.currentRow[LABELLED_FIELD];
  try {
    await apiJson("PATCH", `/api/row/${state.selectedIndex}`, {
      set: { [LABELLED_FIELD]: next },
    });
    state.currentRow[LABELLED_FIELD] = next;
    renderLabelledTag();
    toast(next ? "已标记为已标注" : "已标记为未标注");
    await refreshMeta();
    await refreshList();
  } catch (e) {
    toast("切换标注状态失败：" + (e?.message ?? String(e)), "err", 3500);
  }
}

function updateRowNav() {
  const show = state.selectedIndex !== null;
  $("rowNav").classList.toggle("hidden", !show);
  if (!show) return;
  $("prevRowBtn").disabled = state.selectedIndex <= 0;
  $("nextRowBtn").disabled = state.selectedIndex >= state.datasetTotal - 1;
  $("rowNavPos").textContent = `#${state.selectedIndex + 1} / ${state.datasetTotal}`;
}

async function selectRow(index) {
  state.selectedIndex = index;
  state.deletedKeys = new Set();
  state.extraKeys = [];
  await refreshList();

  const d = await apiGet(`/api/row/${index}`);
  state.currentRow = d.row;
  $("detailEmpty").classList.add("hidden");
  $("detail").classList.remove("hidden");
  $("detailTitle").textContent = `标注工作区 — #${index + 1}`;
  $("applyMsg").textContent = "";
  showAnnotateView();
  renderDetail();
  updateRowNav();
}

async function gotoRow(delta) {
  if (state.selectedIndex === null) return;
  const target = state.selectedIndex + delta;
  if (target < 0 || target >= state.datasetTotal) return;
  const ok = await applyCurrent({ silent: true, navigating: true });
  if (!ok) {
    toast("当前条目保存失败，已阻止切换", "err", 3000);
    return;
  }
  await selectRow(target);
}

// ---------------------------------------------------------------------------
// 收集编辑结果并保存
// ---------------------------------------------------------------------------

function collectChanges() {
  const row = state.currentRow;
  const sets = {};
  const errors = [];
  const inputs = $("fieldsContainer").querySelectorAll(".fieldInput");
  for (const input of inputs) {
    const key = input.dataset.key;
    if (input.disabled || state.deletedKeys.has(key)) continue;
    const widget = input.dataset.widget;
    let v;
    if (widget === "checkbox") {
      v = input.checked;
    } else if (widget === "number") {
      if (input.value.trim() === "") v = null;
      else {
        v = Number(input.value);
        if (Number.isNaN(v)) {
          errors.push(`${key}: 不是合法数字`);
          continue;
        }
      }
    } else if (widget === "json") {
      const txt = input.value.trim();
      if (txt === "") v = null;
      else {
        try {
          v = JSON.parse(txt);
        } catch {
          errors.push(`${key}: JSON 解析失败`);
          continue;
        }
      }
    } else if (widget === "select") {
      v = input.value === "" ? null : input.value;
    } else {
      v = input.value;
    }
    const old = getByPath(row, key);
    const same =
      (old === undefined && (v === "" || v === null)) ||
      JSON.stringify(old) === JSON.stringify(v);
    if (!same) sets[key] = v;
  }
  const deletes = [...state.deletedKeys].filter((k) => hasByPath(row, k));
  return { sets, deletes, errors };
}

async function applyCurrent({ silent = false, navigating = false } = {}) {
  if (state.selectedIndex === null) return true;
  const { sets, deletes, errors } = collectChanges();
  if (errors.length) {
    $("applyMsg").textContent = "有错误：" + errors.join("；");
    if (!silent) toast("保存失败：" + errors[0], "err", 3000);
    return false;
  }
  if (!Object.keys(sets).length && !deletes.length) {
    if (!silent) toast("没有需要保存的修改");
    return true;
  }
  try {
    const r = await apiJson("PATCH", `/api/row/${state.selectedIndex}`, {
      set: sets,
      delete: deletes,
    });
    // 同步本地数据
    for (const [k, v] of Object.entries(sets)) setByPath(state.currentRow, k, v);
    for (const k of deletes) deleteByPath(state.currentRow, k);
    const hadDeletes = deletes.length > 0;
    state.deletedKeys = new Set();
    state.extraKeys = state.extraKeys.filter((k) => hasByPath(state.currentRow, k));
    if (r.item) state.currentRow[LABELLED_FIELD] = Boolean(r.item.dirty);
    // 静默保存（自动保存）时不重建表单，避免打断正在输入的用户；
    // 有字段删除、或即将切换条目时才重新渲染。
    const typing = document.activeElement?.classList?.contains("fieldInput");
    if (!silent || hadDeletes || (!typing && !navigating)) {
      renderDetail();
    } else {
      renderLabelledTag();
    }
    if (r.auto_saved_path) {
      $("applyMsg").textContent = `已保存并自动写入 ${r.auto_saved_path}`;
      if (!silent) toast("已保存并写盘");
    } else {
      $("applyMsg").textContent = '已保存到内存（点击右上角"保存到文件"写盘）';
      if (!silent) toast("已保存此条");
    }
    await refreshMeta();
    await refreshList();
    return true;
  } catch (e) {
    $("applyMsg").textContent = "保存失败";
    toast("保存失败：" + (e?.message ?? String(e)), "err", 3500);
    return false;
  }
}

// 自动保存：在固定周期兜底之外，等待用户停止输入 AUTOSAVE_IDLE_MS 后再保存，
// 避免每次按键都触发保存打断输入。
function scheduleAutoSave() {
  if (state.template?.save_mode !== "auto") return;
  state.lastInputAt = Date.now();
  window.clearTimeout(state.autoSaveTimer);
  state.autoSaveTimer = window.setTimeout(autoSaveIfIdle, AUTOSAVE_IDLE_MS);
}

function autoSaveIfIdle() {
  if (state.template?.save_mode !== "auto") return;
  if (state.selectedIndex === null) return;
  if (Date.now() - state.lastInputAt < AUTOSAVE_IDLE_MS - 100) return; // 仍在输入
  applyCurrent({ silent: true });
}

function startAutoSaveLoop() {
  window.setInterval(() => {
    if (state.template?.save_mode !== "auto") return;
    if (state.selectedIndex === null) return;
    // 用户正在输入时跳过本次周期保存，停止输入后由空闲判定接手
    if (Date.now() - state.lastInputAt < AUTOSAVE_IDLE_MS) return;
    applyCurrent({ silent: true });
  }, AUTOSAVE_INTERVAL_MS);
}

async function addFieldToCurrent() {
  if (state.selectedIndex === null) {
    toast("请先选择一条记录", "err");
    return;
  }
  const raw = window.prompt("新字段的 key：");
  if (!raw) return;
  const key = raw.trim();
  if (!key) return;
  try {
    const r = await apiJson("POST", "/api/key/add", { key });
    if (!hasByPath(state.currentRow, key)) setByPath(state.currentRow, key, null);
    state.extraKeys = state.extraKeys.filter((k) => k !== key);
    renderDetail();
    const el = $("fieldsContainer").querySelector(`.field[data-key="${CSS.escape(key)}"]`);
    if (el) {
      el.scrollIntoView({ behavior: "smooth", block: "center" });
      el.querySelector(".fieldInput")?.focus();
    }
    if (r.auto_saved_path) {
      toast(`新增字段已全局生效并写盘：${r.auto_saved_path}`, "ok", 3500);
    } else {
      toast("新增字段已全局生效（缺失值填 null）");
    }
    await refreshMeta();
    await refreshList();
  } catch (e) {
    toast("新增字段失败：" + (e?.message ?? String(e)), "err", 3500);
  }
}

// ---------------------------------------------------------------------------
// 模型验证（推理）：模型与提示词配置存放在模版中，工作区只负责运行
// ---------------------------------------------------------------------------

async function loadInferConfigs() {
  try {
    const cfg = await apiGet("/api/infer/config");
    state.inferConfigs = cfg.modes || null;
  } catch {
    state.inferConfigs = null;
  }
}

// 把提示词中的 {字段key} 占位符替换为当前记录的字段值（支持嵌套路径）
function fillPromptPlaceholders(text, row) {
  if (!text || !row) return text || "";
  return text.replace(/\{([^{}]+)\}/g, (raw, key) => {
    const k = key.trim();
    if (!hasByPath(row, k)) return raw;
    const v = getByPath(row, k);
    if (v === null || v === undefined) return "";
    return typeof v === "string" ? v : JSON.stringify(v, null, 2);
  });
}

async function runInference() {
  const infer = state.template?.infer || {};
  if (!(infer.user_prompt || "").trim()) {
    toast("用户提示词为空，请先在模版设置的「模型推理配置」中填写", "err", 4000);
    return;
  }
  if (state.currentRow === null) {
    toast("请先选择一条记录", "err");
    return;
  }
  const body = {
    mode: infer.mode || "api",
    model: (infer.model || "").trim(),
    base_url: (infer.base_url || "").trim(),
    temperature: Number(infer.temperature) || 0,
    system_prompt: fillPromptPlaceholders(infer.system_prompt, state.currentRow),
    user_prompt: fillPromptPlaceholders(infer.user_prompt, state.currentRow),
  };
  const btn = $("runInferBtn");
  btn.disabled = true;
  $("inferStatus").textContent = "验证中，请稍候……";
  $("inferResult").value = "";
  try {
    const r = await apiJson("POST", "/api/infer", body);
    $("inferResult").value = r.response;
    $("inferStatus").textContent =
      `完成（${r.model} @ ${r.mode === "api" ? "API" : "本地"}，耗时 ${(r.elapsed_ms / 1000).toFixed(1)}s）`;
    toast("模型验证完成");
  } catch (e) {
    let msg = e?.message ?? String(e);
    try {
      msg = JSON.parse(msg).error || msg;
    } catch {}
    $("inferStatus").textContent = msg;
    toast(msg, "err", 5000);
  } finally {
    btn.disabled = false;
  }
}

// 验证区是否显示由模版的 infer_enabled 决定；配置摘要来自模版的 infer
function updateInferVisibility() {
  const enabled = Boolean(state.template?.infer_enabled);
  $("inferSection").classList.toggle("hidden", !enabled);
  if (!enabled) return;
  const infer = state.template?.infer || {};
  const modeLabel = infer.mode === "local" ? "本地模型" : "调用 API";
  const parts = [`${modeLabel}：${infer.model || "（未配置模型）"}`];
  if (!(infer.user_prompt || "").trim()) {
    parts.push("尚未配置用户提示词，请到模版设置中填写");
  }
  $("inferInfoLine").textContent = parts.join(" | ");
}

function wireInferPanel() {
  $("runInferBtn").addEventListener("click", runInference);
}

function wirePromptSource(sourceId, fileId, fileNameId, textId, onText) {
  const sourceSel = $(sourceId);
  const fileInput = $(fileId);
  const fileName = $(fileNameId);
  const text = $(textId);

  sourceSel.addEventListener("change", () => {
    const useFile = sourceSel.value === "file";
    fileInput.classList.toggle("hidden", !useFile);
    if (!useFile) {
      fileInput.value = "";
      fileName.textContent = "";
    }
  });

  fileInput.addEventListener("change", () => {
    const f = fileInput.files?.[0];
    if (!f) return;
    const reader = new FileReader();
    reader.onload = () => {
      text.value = String(reader.result ?? "");
      fileName.textContent = `已载入：${f.name}（可在下方继续编辑）`;
      onText?.();
    };
    reader.onerror = () => toast(`读取文件失败：${f.name}`, "err", 3500);
    reader.readAsText(f);
  });
}

// ---------------------------------------------------------------------------
// 模版编辑器
// ---------------------------------------------------------------------------

function showAnnotateView() {
  $("annotateView").classList.remove("hidden");
  $("templateView").classList.add("hidden");
  $("templateBtn").textContent = "模版设置";
}

async function showTemplateView() {
  state.tplDraft = JSON.parse(JSON.stringify(state.template));
  renderTemplateEditor();
  await refreshTemplateLibrary();
  $("annotateView").classList.add("hidden");
  $("templateView").classList.remove("hidden");
  $("templateBtn").textContent = "返回标注";
}

function displayTemplateName(name) {
  return name.replace(/\.template\.json$/, "");
}

async function refreshTemplateLibrary() {
  const library = await apiGet("/api/templates");
  state.templateLibrary = library;
  renderTemplateLibrary();
}

function renderTemplateLibrary() {
  const library = state.templateLibrary;
  const sel = $("tplPicker");
  sel.innerHTML = "";
  if (!library?.templates?.length) {
    const empty = document.createElement("option");
    empty.value = "";
    empty.textContent = "暂无可复用模版";
    sel.appendChild(empty);
    $("tplUseBtn").disabled = true;
    $("tplLibraryHint").textContent = "保存当前模版或另存为新模版后，会出现在这里。";
    return;
  }

  $("tplUseBtn").disabled = false;
  for (const item of library.templates) {
    const op = document.createElement("option");
    op.value = item.name;
    const tags = [];
    if (item.is_current) tags.push("当前");
    if (item.is_default) tags.push("当前数据默认");
    if (item.source_file) tags.push(`来源: ${item.source_file}`);
    if (item.error) tags.push(`不可用: ${item.error}`);
    op.textContent = `${displayTemplateName(item.name)}${tags.length ? `（${tags.join("；")}）` : ""}`;
    op.disabled = Boolean(item.error);
    sel.appendChild(op);
  }
  sel.value = library.current;
  $("tplLibraryHint").textContent =
    `当前使用：${displayTemplateName(library.current)}；默认同名模版：${displayTemplateName(library.default)}`;
}

function fillFieldSelect(sel, keys, current, allowEmpty = true) {
  sel.innerHTML = "";
  if (allowEmpty) {
    const empty = document.createElement("option");
    empty.value = "";
    empty.textContent = "（无）";
    sel.appendChild(empty);
  }
  for (const k of keys) {
    const op = document.createElement("option");
    op.value = k;
    op.textContent = k;
    sel.appendChild(op);
  }
  sel.value = keys.includes(current) ? current : "";
}

function renderTemplateEditor() {
  const tpl = state.tplDraft;
  const keys = tpl.fields.map((f) => f.key);
  fillFieldSelect($("tplTitleField"), keys, tpl.list?.title_field || "");
  fillFieldSelect($("tplSubtitleField"), keys, tpl.list?.subtitle_field || "");
  fillFieldSelect($("tplTagField"), keys, tpl.list?.tag_field || "");
  $("tplSaveMode").value = tpl.save_mode || "manual";
  $("tplInferEnabled").value = tpl.infer_enabled ? "true" : "false";
  renderTplInferConfig();

  const box = $("tplFields");
  box.innerHTML = "";
  tpl.fields.forEach((f, i) => box.appendChild(makeTplFieldRow(f, i)));
}

function renderTplInferConfig() {
  const tpl = state.tplDraft;
  const infer = tpl.infer || {};
  $("tplInferSection").classList.toggle("hidden", !tpl.infer_enabled);
  $("tplInferMode").value = infer.mode || "api";
  $("tplInferModel").value = infer.model || "";
  $("tplInferBaseUrl").value = infer.base_url || "";
  $("tplInferTemperature").value = String(infer.temperature ?? 0);
  $("tplSysPromptText").value = infer.system_prompt || "";
  $("tplUserPromptText").value = infer.user_prompt || "";
  updateTplInferKeyHint();
}

function updateTplInferKeyHint() {
  const mode = $("tplInferMode").value;
  const cfg = state.inferConfigs?.[mode];
  if (!cfg) {
    $("tplInferKeyHint").textContent = "";
    return;
  }
  if (mode === "api") {
    $("tplInferKeyHint").textContent = cfg.api_key_set
      ? `API Key 来自环境变量 ${cfg.api_key_env}（已设置）`
      : `注意：环境变量 ${cfg.api_key_env} 未设置，调用 API 会失败`;
  } else {
    $("tplInferKeyHint").textContent = "本地模型需先启动 OpenAI 兼容服务（如 vLLM / Ollama）";
  }
}

function makeTplFieldRow(f, i) {
  const row = document.createElement("div");
  row.className = "tplRow";
  row.draggable = true;
  row.dataset.index = String(i);

  const handle = document.createElement("div");
  handle.className = "tplHandle";
  handle.textContent = "⠿";
  handle.title = "拖动调整顺序";

  const key = document.createElement("input");
  key.type = "text";
  key.value = f.key;
  key.className = "mono";
  key.addEventListener("change", () => { f.key = key.value.trim(); });

  const label = document.createElement("input");
  label.type = "text";
  label.value = f.label || "";
  label.placeholder = f.key;
  label.addEventListener("change", () => { f.label = label.value.trim() || f.key; });

  const hint = document.createElement("input");
  hint.type = "text";
  hint.value = f.hint || "";
  hint.placeholder = "输入提示（可空）";
  hint.title = "以灰色小字显示在字段名旁的输入提示（保存在模版中，不改变数据）";
  hint.addEventListener("change", () => { f.hint = hint.value.trim(); });

  const widget = document.createElement("select");
  for (const w of WIDGETS) {
    const op = document.createElement("option");
    op.value = w;
    op.textContent = w;
    widget.appendChild(op);
  }
  widget.value = f.widget;
  widget.addEventListener("change", () => {
    f.widget = widget.value;
    rows.disabled = !(f.widget === "textarea" || f.widget === "json");
    options.disabled = f.widget !== "select";
  });

  const rows = document.createElement("input");
  rows.type = "number";
  rows.min = "1";
  rows.value = String(f.rows || 4);
  rows.disabled = !(f.widget === "textarea" || f.widget === "json");
  rows.title = "textarea / json 控件的高度（行数），即标注边框大小";
  rows.addEventListener("change", () => {
    f.rows = Math.max(1, parseInt(rows.value, 10) || 4);
  });

  const options = document.createElement("textarea");
  options.rows = 2;
  options.value = (f.options || []).join("\n");
  options.disabled = f.widget !== "select";
  options.addEventListener("change", () => {
    f.options = options.value.split("\n").map((s) => s.trim()).filter(Boolean);
  });

  const editable = document.createElement("input");
  editable.type = "checkbox";
  editable.checked = f.editable !== false;
  editable.addEventListener("change", () => { f.editable = editable.checked; });

  const hidden = document.createElement("input");
  hidden.type = "checkbox";
  hidden.checked = Boolean(f.hidden);
  hidden.addEventListener("change", () => { f.hidden = hidden.checked; });

  const group = document.createElement("input");
  group.type = "text";
  group.value = f.group || "";
  group.placeholder = "组名";
  group.title = "相邻且组名相同的字段将在工作区中并列一行（支持两个以上）；留空表示独占一行";
  group.addEventListener("change", () => { f.group = group.value.trim(); });

  const filterable = document.createElement("input");
  filterable.type = "checkbox";
  filterable.checked = Boolean(f.filterable);
  filterable.title = "在左侧列表中提供该字段的筛选控件";
  filterable.addEventListener("change", () => { f.filterable = filterable.checked; });

  const del = document.createElement("button");
  del.type = "button";
  del.className = "tplDelBtn";
  del.textContent = "删除";
  del.title = "从模版中移除该字段（不影响数据文件本身）";
  del.addEventListener("click", () => {
    state.tplDraft.fields.splice(state.tplDraft.fields.indexOf(f), 1);
    renderTemplateEditor();
  });

  row.appendChild(handle);
  row.appendChild(key);
  row.appendChild(label);
  row.appendChild(hint);
  row.appendChild(widget);
  row.appendChild(rows);
  row.appendChild(options);
  row.appendChild(wrapCenter(editable));
  row.appendChild(wrapCenter(hidden));
  row.appendChild(group);
  row.appendChild(wrapCenter(filterable));
  row.appendChild(del);

  // 拖拽排序
  row.addEventListener("dragstart", (e) => {
    e.dataTransfer.setData("text/plain", row.dataset.index);
    row.classList.add("dragging");
  });
  row.addEventListener("dragend", () => row.classList.remove("dragging"));
  row.addEventListener("dragover", (e) => e.preventDefault());
  row.addEventListener("drop", (e) => {
    e.preventDefault();
    const from = parseInt(e.dataTransfer.getData("text/plain"), 10);
    const to = parseInt(row.dataset.index, 10);
    if (Number.isNaN(from) || from === to) return;
    const fields = state.tplDraft.fields;
    const [moved] = fields.splice(from, 1);
    fields.splice(to, 0, moved);
    renderTemplateEditor();
  });

  // 输入控件在 draggable 容器里需要阻止拖拽劫持
  for (const el of [key, label, hint, widget, rows, options, group]) {
    el.addEventListener("mousedown", () => { row.draggable = false; });
    el.addEventListener("blur", () => { row.draggable = true; });
  }

  return row;
}

function wrapCenter(el) {
  const d = document.createElement("div");
  d.className = "tplCell";
  d.appendChild(el);
  return d;
}

function prepareTemplateDraft() {
  const tpl = state.tplDraft;
  tpl.list = tpl.list || {};
  tpl.list.title_field = $("tplTitleField").value;
  tpl.list.subtitle_field = $("tplSubtitleField").value;
  tpl.list.tag_field = $("tplTagField").value;
  tpl.save_mode = $("tplSaveMode").value;
  tpl.infer_enabled = $("tplInferEnabled").value === "true";
  tpl.infer = {
    mode: $("tplInferMode").value,
    model: $("tplInferModel").value.trim(),
    base_url: $("tplInferBaseUrl").value.trim(),
    temperature: Number($("tplInferTemperature").value) || 0,
    system_prompt: $("tplSysPromptText").value,
    user_prompt: $("tplUserPromptText").value,
  };
  tpl.search_fields = tpl.fields
    .filter((f) => ["text", "textarea", "select"].includes(f.widget))
    .map((f) => f.key);

  const keys = tpl.fields.map((f) => f.key);
  if (keys.some((k) => !k)) {
    toast("存在空的 key", "err");
    return null;
  }
  if (new Set(keys).size !== keys.length) {
    toast("存在重复的 key", "err");
    return null;
  }
  if (tpl.infer_enabled && !tpl.infer.model) {
    toast("已启用模型推理，请在「模型推理配置」中填写模型名", "err", 3500);
    return null;
  }
  return tpl;
}

async function saveTemplate() {
  const tpl = prepareTemplateDraft();
  if (!tpl) return;
  try {
    const r = await apiJson("PUT", "/api/template", tpl);
    state.template = tpl;
    renderDataFilters();
    updateInferVisibility();
    toast("模版已保存：" + r.template_path, "ok", 3000);
    await refreshMeta();
    await refreshTemplateLibrary();
    await refreshList();
    if (state.selectedIndex !== null) renderDetail();
  } catch (e) {
    toast("模版保存失败：" + (e?.message ?? String(e)), "err", 4000);
  }
}

async function applySelectedTemplate() {
  const name = $("tplPicker").value;
  if (!name) return;
  const current = state.templateLibrary?.current;
  if (name !== current && !window.confirm("套用已有模版会替换当前字段配置视图，未保存的模版编辑会丢失。确定？")) {
    return;
  }
  try {
    const r = await apiJson("POST", "/api/template/select", { name });
    state.template = r.template;
    state.tplDraft = JSON.parse(JSON.stringify(r.template));
    state.dataFilters = {};
    renderTemplateEditor();
    renderDataFilters();
    updateInferVisibility();
    toast("已套用模版：" + r.template_path, "ok", 3000);
    await refreshMeta();
    await refreshTemplateLibrary();
    await refreshList();
    if (state.selectedIndex !== null) renderDetail();
  } catch (e) {
    toast("套用模版失败：" + (e?.message ?? String(e)), "err", 4000);
  }
}

async function saveTemplateAs() {
  const tpl = prepareTemplateDraft();
  if (!tpl) return;
  const currentName = state.templateLibrary?.current || "";
  const baseName = displayTemplateName(currentName || "custom_template");
  const raw = window.prompt("新模版名称（会保存到 annotation_templates/，可不写后缀）：", baseName);
  if (raw === null) return;
  const name = raw.trim();
  if (!name) {
    toast("模版名称不能为空", "err");
    return;
  }
  try {
    const r = await apiJson("POST", "/api/template/save-as", { name, template: tpl });
    state.template = r.template;
    state.tplDraft = JSON.parse(JSON.stringify(r.template));
    renderTemplateEditor();
    renderDataFilters();
    updateInferVisibility();
    toast("已另存为模版：" + r.template_path, "ok", 3000);
    await refreshMeta();
    await refreshTemplateLibrary();
    await refreshList();
    if (state.selectedIndex !== null) renderDetail();
  } catch (e) {
    toast("另存模版失败：" + (e?.message ?? String(e)), "err", 4000);
  }
}

async function regenerateTemplate() {
  if (!window.confirm("将根据当前数据重新自动解析字段，覆盖现有模版。确定？")) return;
  try {
    const r = await apiJson("POST", "/api/template/generate", {});
    state.template = r.template;
    state.tplDraft = JSON.parse(JSON.stringify(r.template));
    renderTemplateEditor();
    state.dataFilters = {};
    renderDataFilters();
    updateInferVisibility();
    toast("已重新解析并保存模版");
    await refreshMeta();
    await refreshTemplateLibrary();
    await refreshList();
  } catch (e) {
    toast("重新解析失败：" + (e?.message ?? String(e)), "err", 4000);
  }
}

// ---------------------------------------------------------------------------
// 事件绑定与启动
// ---------------------------------------------------------------------------

function wire() {
  $("sidebarToggle").addEventListener("click", () =>
    setSidebarCollapsed(!isSidebarCollapsed()));

  $("q").addEventListener("keydown", async (e) => {
    if (e.key !== "Enter") return;
    state.q = $("q").value.trim();
    state.offset = 0;
    await refreshList();
  });

  $("filterChanged").addEventListener("change", async () => {
    state.filterChanged = $("filterChanged").value;
    state.offset = 0;
    await refreshList();
  });

  $("pageSize").addEventListener("change", async () => {
    state.limit = parseInt($("pageSize").value, 10);
    state.offset = 0;
    await refreshList();
  });

  $("prevBtn").addEventListener("click", async () => {
    state.offset = Math.max(0, state.offset - state.limit);
    await refreshList();
  });

  $("nextBtn").addEventListener("click", async () => {
    state.offset = Math.min(state.total, state.offset + state.limit);
    await refreshList();
  });

  $("applyBtn").addEventListener("click", () => applyCurrent());
  $("addFieldBtn").addEventListener("click", addFieldToCurrent);
  $("labelledTag").addEventListener("click", toggleLabelled);
  $("prevRowBtn").addEventListener("click", () => gotoRow(-1));
  $("nextRowBtn").addEventListener("click", () => gotoRow(1));
  wireInferPanel();

  // 模版设置中的模型推理配置
  $("tplInferEnabled").addEventListener("change", () => {
    state.tplDraft.infer_enabled = $("tplInferEnabled").value === "true";
    $("tplInferSection").classList.toggle("hidden", !state.tplDraft.infer_enabled);
  });
  $("tplInferMode").addEventListener("change", () => {
    const cfg = state.inferConfigs?.[$("tplInferMode").value];
    if (cfg) {
      $("tplInferModel").value = cfg.model || "";
      $("tplInferBaseUrl").value = cfg.base_url || "";
      $("tplInferTemperature").value = String(cfg.temperature ?? 0);
    }
    updateTplInferKeyHint();
  });
  wirePromptSource("tplSysPromptSource", "tplSysPromptFile", "tplSysPromptFileName", "tplSysPromptText");
  wirePromptSource("tplUserPromptSource", "tplUserPromptFile", "tplUserPromptFileName", "tplUserPromptText");

  $("saveBtn").addEventListener("click", async () => {
    $("saveBtn").disabled = true;
    try {
      const r = await apiJson("POST", "/api/save", {});
      toast("已写入：" + r.saved_path, "ok", 3500);
      await refreshMeta();
    } catch (e) {
      toast("写入失败：" + (e?.message ?? String(e)), "err", 4000);
    } finally {
      $("saveBtn").disabled = false;
    }
  });

  $("saveModeSel").addEventListener("change", async () => {
    const mode = $("saveModeSel").value;
    const tpl = JSON.parse(JSON.stringify(state.template));
    tpl.save_mode = mode;
    try {
      await apiJson("PUT", "/api/template", tpl);
      state.template = tpl;
      toast(mode === "auto" ? "已切换为自动存盘" : "已切换为手动存盘");
    } catch (e) {
      toast("切换失败：" + (e?.message ?? String(e)), "err", 3500);
      $("saveModeSel").value = state.template.save_mode;
    }
  });

  $("templateBtn").addEventListener("click", () => {
    if ($("templateView").classList.contains("hidden")) {
      showTemplateView().catch((e) => toast("打开模版设置失败：" + (e?.message ?? String(e)), "err", 4000));
    }
    else showAnnotateView();
  });

  $("tplSaveBtn").addEventListener("click", saveTemplate);
  $("tplRegenBtn").addEventListener("click", regenerateTemplate);
  $("tplUseBtn").addEventListener("click", applySelectedTemplate);
  $("tplSaveAsBtn").addEventListener("click", saveTemplateAs);
  $("tplAddFieldBtn").addEventListener("click", () => {
    state.tplDraft.fields.push({
      key: "",
      label: "",
      hint: "",
      widget: "text",
      rows: 4,
      editable: true,
      hidden: false,
      group: "",
      filterable: false,
      options: [],
    });
    renderTemplateEditor();
    const rows = $("tplFields").querySelectorAll(".tplRow");
    rows[rows.length - 1]?.querySelector("input")?.focus();
  });
}

async function main() {
  wire();
  let collapsed = false;
  try {
    collapsed = localStorage.getItem(SIDEBAR_COLLAPSED_KEY) === "1";
  } catch {}
  setSidebarCollapsed(collapsed);

  await chooseSession();
  state.template = await apiGet("/api/template");
  await refreshTemplateLibrary();
  await loadInferConfigs();
  renderDataFilters();
  updateInferVisibility();
  await refreshMeta();
  await refreshList();
  startAutoSaveLoop();
}

main().catch((e) => toast("初始化失败：" + (e?.message ?? String(e)), "err", 5000));
