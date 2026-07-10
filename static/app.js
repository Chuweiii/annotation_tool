const $ = (id) => document.getElementById(id);

const WIDGETS = ["text", "textarea", "number", "checkbox", "select", "json"];

const state = {
  offset: 0,
  limit: 30,
  total: 0,
  q: "",
  filterChanged: "any",
  dataFilters: {},
  selectedIndex: null,
  currentRow: null,       // 当前记录的原始数据
  deletedKeys: new Set(), // 本条待删除的 key
  extraKeys: [],          // 本条新增的、模版之外的 key
  template: null,
  tplDraft: null,         // 模版编辑器中的草稿
  autoSaveTimer: null,
};

const SIDEBAR_COLLAPSED_KEY = "annotation_sidebar_collapsed_v1";

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
  $("metaLine").textContent =
    `${m.total} 条 | 已修改 ${m.dirty_count} 条 | 数据: ${m.data_path} | 工作文件: ${m.working_path}`;
  $("saveModeSel").value = m.save_mode;
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
      d.textContent = "已修改";
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
  return { key, label: key, widget: "json", rows: 4, editable: true, hidden: false, options: [], _extra: true };
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
  head.appendChild(label);

  const headRight = document.createElement("div");
  headRight.className = "fieldHeadRight";
  if (!spec.editable) {
    const ro = document.createElement("span");
    ro.className = "roBadge";
    ro.textContent = "只读";
    headRight.appendChild(ro);
  } else {
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

function renderDetail() {
  const row = state.currentRow;
  if (row === null) return;
  const container = $("fieldsContainer");
  container.innerHTML = "";

  const tplFields = state.template?.fields || [];
  const rendered = new Set();

  for (const spec of tplFields) {
    rendered.add(spec.key);
    if (spec.hidden) continue;
    if (!(spec.key in row) && !state.extraKeys.includes(spec.key)) {
      // 数据中缺失该 key：也展示出来方便补标
    }
    const el = makeFieldEditor(spec, row[spec.key]);
    if (spec.side_by_side) el.classList.add("sideBySide");
    if (state.deletedKeys.has(spec.key)) {
      el.classList.add("deleted");
      const btn = el.querySelector(".fieldDelBtn");
      if (btn) btn.replaceWith(makeUndoBtn(spec.key, el));
    }
    container.appendChild(el);
  }

  // 数据中存在但模版未收录的 key + 本条新增的 key
  const extras = [
    ...Object.keys(row).filter((k) => !rendered.has(k)),
    ...state.extraKeys.filter((k) => !rendered.has(k) && !(k in row)),
  ];
  if (extras.length) {
    const divider = document.createElement("div");
    divider.className = "extraDivider";
    divider.textContent = "模版之外的字段";
    container.appendChild(divider);
    for (const k of extras) {
      const el = makeFieldEditor(fieldSpecFor(k), row[k]);
      if (state.deletedKeys.has(k)) {
        el.classList.add("deleted");
        const btn = el.querySelector(".fieldDelBtn");
        if (btn) btn.replaceWith(makeUndoBtn(k, el));
      }
      container.appendChild(el);
    }
  }
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
    const old = row[key];
    const same =
      (old === undefined && (v === "" || v === null)) ||
      JSON.stringify(old) === JSON.stringify(v);
    if (!same) sets[key] = v;
  }
  const deletes = [...state.deletedKeys].filter((k) => k in row);
  return { sets, deletes, errors };
}

async function applyCurrent({ silent = false } = {}) {
  if (state.selectedIndex === null) return;
  const { sets, deletes, errors } = collectChanges();
  if (errors.length) {
    $("applyMsg").textContent = "有错误：" + errors.join("；");
    if (!silent) toast("保存失败：" + errors[0], "err", 3000);
    return;
  }
  if (!Object.keys(sets).length && !deletes.length) {
    if (!silent) toast("没有需要保存的修改");
    return;
  }
  try {
    const r = await apiJson("PATCH", `/api/row/${state.selectedIndex}`, {
      set: sets,
      delete: deletes,
    });
    // 同步本地数据
    for (const [k, v] of Object.entries(sets)) state.currentRow[k] = v;
    for (const k of deletes) delete state.currentRow[k];
    state.deletedKeys = new Set();
    state.extraKeys = state.extraKeys.filter((k) => k in state.currentRow);
    renderDetail();
    if (r.auto_saved_path) {
      $("applyMsg").textContent = `已保存并自动写入 ${r.auto_saved_path}`;
      if (!silent) toast("已保存并写盘");
    } else {
      $("applyMsg").textContent = '已保存到内存（点击右上角"保存到文件"写盘）';
      if (!silent) toast("已保存此条");
    }
    await refreshMeta();
    await refreshList();
  } catch (e) {
    $("applyMsg").textContent = "保存失败";
    toast("保存失败：" + (e?.message ?? String(e)), "err", 3500);
  }
}

function scheduleAutoSave() {
  if (state.template?.save_mode !== "auto") return;
  window.clearTimeout(state.autoSaveTimer);
  state.autoSaveTimer = window.setTimeout(() => applyCurrent({ silent: true }), 800);
}

function addFieldToCurrent() {
  if (state.selectedIndex === null) {
    toast("请先选择一条记录", "err");
    return;
  }
  const key = window.prompt("新字段的 key：");
  if (!key) return;
  if (key in state.currentRow || state.extraKeys.includes(key)) {
    toast("该 key 已存在", "err");
    return;
  }
  state.extraKeys.push(key);
  renderDetail();
  const el = $("fieldsContainer").querySelector(`.field[data-key="${CSS.escape(key)}"]`);
  if (el) {
    el.scrollIntoView({ behavior: "smooth", block: "center" });
    el.querySelector(".fieldInput")?.focus();
  }
}

// ---------------------------------------------------------------------------
// 模版编辑器
// ---------------------------------------------------------------------------

function showAnnotateView() {
  $("annotateView").classList.remove("hidden");
  $("templateView").classList.add("hidden");
  $("templateBtn").textContent = "模版设置";
}

function showTemplateView() {
  state.tplDraft = JSON.parse(JSON.stringify(state.template));
  renderTemplateEditor();
  $("annotateView").classList.add("hidden");
  $("templateView").classList.remove("hidden");
  $("templateBtn").textContent = "返回标注";
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

  const box = $("tplFields");
  box.innerHTML = "";
  tpl.fields.forEach((f, i) => box.appendChild(makeTplFieldRow(f, i)));
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

  const sideBySide = document.createElement("input");
  sideBySide.type = "checkbox";
  sideBySide.checked = Boolean(f.side_by_side);
  sideBySide.title = "相邻的勾选字段在工作区中左右两列排列";
  sideBySide.addEventListener("change", () => { f.side_by_side = sideBySide.checked; });

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
  row.appendChild(widget);
  row.appendChild(rows);
  row.appendChild(options);
  row.appendChild(wrapCenter(editable));
  row.appendChild(wrapCenter(hidden));
  row.appendChild(wrapCenter(sideBySide));
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
  for (const el of [key, label, widget, rows, options]) {
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

async function saveTemplate() {
  const tpl = state.tplDraft;
  tpl.list = tpl.list || {};
  tpl.list.title_field = $("tplTitleField").value;
  tpl.list.subtitle_field = $("tplSubtitleField").value;
  tpl.list.tag_field = $("tplTagField").value;
  tpl.save_mode = $("tplSaveMode").value;
  tpl.search_fields = tpl.fields
    .filter((f) => ["text", "textarea", "select"].includes(f.widget))
    .map((f) => f.key);

  const keys = tpl.fields.map((f) => f.key);
  if (keys.some((k) => !k)) {
    toast("存在空的 key", "err");
    return;
  }
  if (new Set(keys).size !== keys.length) {
    toast("存在重复的 key", "err");
    return;
  }

  try {
    const r = await apiJson("PUT", "/api/template", tpl);
    state.template = tpl;
    renderDataFilters();
    toast("模版已保存：" + r.template_path, "ok", 3000);
    await refreshMeta();
    await refreshList();
    if (state.selectedIndex !== null) renderDetail();
  } catch (e) {
    toast("模版保存失败：" + (e?.message ?? String(e)), "err", 4000);
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
    toast("已重新解析并保存模版");
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
    if ($("templateView").classList.contains("hidden")) showTemplateView();
    else showAnnotateView();
  });

  $("tplSaveBtn").addEventListener("click", saveTemplate);
  $("tplRegenBtn").addEventListener("click", regenerateTemplate);
  $("tplAddFieldBtn").addEventListener("click", () => {
    state.tplDraft.fields.push({
      key: "",
      label: "",
      widget: "text",
      rows: 4,
      editable: true,
      hidden: false,
      side_by_side: false,
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

  state.template = await apiGet("/api/template");
  renderDataFilters();
  const meta = await apiGet("/api/meta");
  $("tplPathHint").textContent = `模版文件：${meta.template_path}（可随代码/数据一起归档，实现复现）`;
  await refreshMeta();
  await refreshList();
}

main().catch((e) => toast("初始化失败：" + (e?.message ?? String(e)), "err", 5000));
