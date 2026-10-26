const $ = (id) => document.getElementById(id);

const WIDGETS = [
  "text", "textarea", "number", "checkbox", "select", "json", "repeatable",
  "collection_cards",
];
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
  repeatableSteps: {},
  rowViews: {},
  saveQueue: Promise.resolve(),
  navigationQueue: Promise.resolve(),
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
  const r = await localWorkspace.request(url);
  if (!r.ok) throw new Error(await r.text());
  return r.json();
}

async function apiJson(method, url, body) {
  const r = await localWorkspace.request(url, {
    method,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body ?? {}),
  });
  if (!r.ok) throw new Error(await r.text());
  const payload = await r.json();
  if (url.startsWith('/api/template') && localWorkspace.snapshot) await localWorkspace.loadSnapshot();
  return payload;
}

// Keep raw input (including temporarily invalid JSON) apart from confirmed
// rows. Recovery must never silently commit an unfinished card revision.
function captureRecordView() {
  const fields = {};
  for (const field of document.querySelectorAll('#fieldsContainer .field, #sourceFieldsContainer .field')) {
    const input = field.querySelector('.fieldInput');
    fields[field.dataset.key] = {
      value: input?.value, checked: input?.checked,
      baselineValue: input?.dataset.renderedValue, baselineChecked: input?.dataset.renderedChecked,
      dirty: input && (input.value !== input.dataset.renderedValue ||
        (input.dataset.widget === 'checkbox' && String(input.checked) !== input.dataset.renderedChecked)),
      segmentEditing: Boolean(field.querySelector('.segmentedText') && !input.classList.contains('hidden')),
      details: [...field.querySelectorAll('details')].map(el => el.open),
      sizes: [...field.querySelectorAll('textarea')].map(el => ({ height: el.style.height, width: el.style.width })),
      editor: field.querySelector('.repeatableEditor, .collectionEditor')?.captureViewState?.(),
    };
  }
  return {
    fields, deletedKeys: [...state.deletedKeys], extraKeys: [...state.extraKeys],
    repeatableSteps: { ...state.repeatableSteps },
    scroll: ['sourceFieldsContainer', 'fieldsContainer'].map(id => $(id)?.scrollTop || 0),
  };
}

function restoreRecordView(view) {
  if (!view) return;
  for (const field of document.querySelectorAll('#fieldsContainer .field, #sourceFieldsContainer .field')) {
    const saved = view.fields[field.dataset.key];
    if (!saved) continue;
    field.querySelector('.repeatableEditor, .collectionEditor')?.restoreViewState?.(saved.editor);
    const input = field.querySelector('.fieldInput');
    if (input && saved.dirty && saved.value !== undefined) {
      input.value = saved.value;
      if (saved.checked !== undefined) input.checked = saved.checked;
    }
    field.querySelectorAll('details').forEach((el, i) => { if (saved.details[i] !== undefined) el.open = saved.details[i]; });
    field.querySelectorAll('textarea').forEach((el, i) => Object.assign(el.style, saved.sizes[i] || {}));
    const preview = field.querySelector('.segmentedText');
    if (preview && input) {
      renderSegmentedText(preview, input.value);
      input.classList.toggle('hidden', !saved.segmentEditing);
      preview.classList.toggle('hidden', saved.segmentEditing);
      const toggle = field.querySelector('.segmentDisplayToggle');
      if (toggle) toggle.textContent = saved.segmentEditing ? '分段预览' : '编辑原文';
    }
  }
  ['sourceFieldsContainer', 'fieldsContainer'].forEach((id, i) => { if ($(id)) $(id).scrollTop = view.scroll[i]; });
}

function checkpointWorkspace() {
  if (state.rendering) return;
  localWorkspace.checkpoint();
}

function captureWorkspaceView() {
  if (state.selectedIndex !== null) state.rowViews[state.selectedIndex] = captureRecordView();
  return {
    selectedIndex: state.selectedIndex, rowViews: state.rowViews,
    q: state.q, offset: state.offset, limit: state.limit,
    filterChanged: state.filterChanged, dataFilters: state.dataFilters,
  };
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
  if (widget === "json") return JSON.stringify(v, null, 2);
  if (typeof v === "string") return v;
  return JSON.stringify(v);
}

function numberedTextSegments(text) {
  // Only split consecutive markers of the same style at paragraph/sentence
  // boundaries. All slices retain the exact original characters.
  const pattern = /[一二三四五六七八九十百零〇两]+、|[（(][一二三四五六七八九十百零〇两]+[）)]|\d+[、.]|[（(]\d+[）)]|[①②③④⑤⑥⑦⑧⑨⑩]/gu;
  const chineseNumber = (value) => {
    const digits = { 零: 0, 〇: 0, 一: 1, 二: 2, 两: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9 };
    let total = 0, digit = 0;
    for (const char of value) {
      if (char === '十' || char === '百') { total += (digit || 1) * (char === '十' ? 10 : 100); digit = 0; }
      else digit = digits[char];
    }
    return total + digit;
  };
  const groups = new Map();
  let quoteDepth = 0, scanned = 0;
  for (const match of text.matchAll(pattern)) {
    for (; scanned < match.index; scanned += 1) {
      if ('“‘「『'.includes(text[scanned])) quoteDepth += 1;
      else if ('”’」』'.includes(text[scanned])) quoteDepth = Math.max(0, quoteDepth - 1);
    }
    if (quoteDepth || !/(?:^|[\n\r；;。！？!?])[ \t\u3000]*$/u.test(text.slice(0, match.index))) continue;
    const marker = match[0];
    if (marker.endsWith('.') && /\d/.test(text[match.index + marker.length] || '')) continue;
    const circled = '①②③④⑤⑥⑦⑧⑨⑩'.indexOf(marker);
    const numberText = marker.replace(/[（()）、.]/g, '');
    const number = circled >= 0 ? circled + 1 : /^\d+$/.test(numberText) ? Number(numberText) : chineseNumber(numberText);
    const style = circled >= 0 ? 'circle' : `${/^\d+$/.test(numberText) ? 'digit' : 'chinese'}-${marker.replace(numberText, '#')}`;
    if (!groups.has(style)) groups.set(style, []);
    groups.get(style).push({ number, index: match.index });
  }
  let best = [];
  for (const markers of groups.values()) {
    let run = [];
    for (const marker of markers) {
      run = run.length && marker.number === run.at(-1).number + 1 ? [...run, marker] : [marker];
      if (run.length > best.length) best = run;
    }
  }
  if (best.length < 2) return [text];
  const starts = [0, ...best.map(marker => marker.index).filter(index => index > 0)];
  return starts.map((start, i) => text.slice(start, starts[i + 1] ?? text.length));
}

function renderSegmentedText(container, text) {
  container.replaceChildren();
  for (const part of numberedTextSegments(text)) {
    const paragraph = document.createElement('div');
    paragraph.className = 'numberedTextSegment';
    paragraph.textContent = part;
    container.appendChild(paragraph);
  }
}

function repeatableFieldVisible(field, item) {
  return !field.visible_if || item[field.visible_if.field] === field.visible_if.equals;
}

function repeatableWarnings(items, spec, visibleKeys = null) {
  const idField = spec.item_id_field || "id";
  const ids = new Set(items.map((item) => item[idField]));
  const warnings = [];
  for (const item of items) {
    const itemId = item[idField];
    for (const field of spec.item_fields || []) {
      if (visibleKeys && !visibleKeys.has(field.key)) continue;
      if (!repeatableFieldVisible(field, item)) continue;
      const value = item[field.key];
      if (field.required && (value === "" || value === null || value === undefined || (Array.isArray(value) && !value.length))) {
        warnings.push(`${itemId} 缺少必填项“${field.label || field.key}”`);
      }
      const pathValue = Array.isArray(value) ? value.join(field.delimiter || "；") : String(value ?? "");
      if (field.widget === "cascader" && pathValue && !optionsForRepeatableField(field).includes(pathValue)) {
        warnings.push(`${itemId} 的“${field.label || field.key}”尚未选择到末级`);
      }
      if (field.widget !== "self_multiselect") continue;
      for (const relatedId of Array.isArray(value) ? value : []) {
        if (relatedId === itemId) warnings.push(`${itemId} 的“${field.label || field.key}”不能选择自身`);
        else if (!ids.has(relatedId)) warnings.push(`${itemId} 的“${field.label || field.key}”包含不存在的 ${relatedId}`);
      }
    }
  }

  for (const field of (spec.item_fields || []).filter((f) =>
    f.widget === "self_multiselect" && f.acyclic && (!visibleKeys || visibleKeys.has(f.key)))) {
    const byId = new Map(items.map((item) => [item[idField], item]));
    const visiting = new Set();
    const visited = new Set();
    function visit(id) {
      if (visiting.has(id)) return true;
      if (visited.has(id)) return false;
      visiting.add(id);
      const item = byId.get(id);
      for (const relatedId of Array.isArray(item?.[field.key]) ? item[field.key] : []) {
        if (byId.has(relatedId) && visit(relatedId)) return true;
      }
      visiting.delete(id);
      visited.add(id);
      return false;
    }
    if (items.some((item) => visit(item[idField]))) {
      warnings.push(`“${field.label || field.key}”存在循环关系`);
    }
  }
  return [...new Set(warnings)];
}

function optionsForRepeatableField(field, currentItem = null, items = [], idField = "id") {
  if (field.widget === "self_multiselect") {
    return items.filter((item) => item !== currentItem).map((item) => String(item[idField]));
  }
  if (field.options_from_path) {
    const source = getByPath(state.currentRow || {}, field.options_from_path);
    if (Array.isArray(source)) return source.map(String);
    if (isPlainObject(source)) {
      if (field.options_from_object === "entries") {
        const separator = field.option_entry_separator ?? "\n";
        return Object.entries(source).map(([key, value]) => {
          const detail = typeof value === "string" ? value : JSON.stringify(value, null, 2);
          return detail ? `${key}${separator}${detail}` : key;
        });
      }
      return Object.keys(source);
    }
    return [];
  }
  return Array.isArray(field.options) ? field.options.map(String) : [];
}

function nextRepeatableId(items, spec) {
  const idField = spec.item_id_field || "id";
  const prefix = spec.item_id_prefix || "I";
  const padding = Number(spec.item_id_padding) || 2;
  const used = new Set(items.map((item) => item[idField]));
  let n = 1;
  while (used.has(`${prefix}${String(n).padStart(padding, "0")}`)) n += 1;
  return `${prefix}${String(n).padStart(padding, "0")}`;
}

function normalizeRepeatableItem(value, index, spec) {
  const item = isPlainObject(value) ? { ...value } : {};
  const idField = spec.item_id_field || "id";
  const orderField = spec.order_field || "order";
  if (!item[idField]) {
    const prefix = spec.item_id_prefix || "I";
    const padding = Number(spec.item_id_padding) || 2;
    item[idField] = `${prefix}${String(index + 1).padStart(padding, "0")}`;
  }
  if (spec.track_order === false) delete item[orderField];
  else item[orderField] = index + 1;
  for (const field of spec.item_fields || []) {
    if (field.widget === "cascader" && field.value_type === "array") {
      const value = item[field.key];
      const parts = Array.isArray(value) ? value : value ? String(value).split(field.delimiter || "；") : [];
      item[field.key] = parts.map((part) => field.value_aliases?.[part] ?? part);
      continue;
    }
    if (field.widget === "select" && field.value_type === "boolean") {
      const value = item[field.key];
      item[field.key] = value === true || value === "true" ? true
        : value === false || value === "false" ? false : null;
      continue;
    }
    if (field.widget === "text_list") {
      const value = item[field.key];
      const entries = Array.isArray(value) ? value : value ? [value] : [];
      item[field.key] = entries.map((entry) => Array.isArray(field.source_options)
        ? (isPlainObject(entry) ? { ...entry, source: String(entry.source ?? ""), content: String(entry.content ?? "") }
          : { source: "", content: String(entry) })
        : String(entry));
      continue;
    }
    if (item[field.key] !== undefined && item[field.key] !== null) continue;
    if (["multiselect", "self_multiselect", "checkbox_group"].includes(field.widget)) item[field.key] = [];
    else if (field.widget === "checkbox") item[field.key] = false;
    else if (field.default !== undefined) item[field.key] = field.default;
    else item[field.key] = "";
  }
  return item;
}

function makeRepeatableControl(field, control) {
  const box = document.createElement("div");
  box.className = "repeatableControl" + (field.wide ? " wide" : "");
  const label = document.createElement("span");
  label.className = "repeatableControlLabel";
  label.textContent = field.label || field.key;
  if (field.required) label.textContent += " *";
  if (field.hint) {
    const help = document.createElement("small");
    help.textContent = field.hint;
    label.appendChild(help);
  }
  box.appendChild(label);
  control.classList.add("repeatableControlInput");
  if (field.editable === false) {
    control.disabled = true;
    control.querySelectorAll?.("input,select,textarea,button").forEach((element) => { element.disabled = true; });
  }
  box.appendChild(control);
  return box;
}

function makeRepeatableEditor(spec, value) {
  let initial = value;
  if (typeof initial === "string") {
    try { initial = JSON.parse(initial); } catch { initial = []; }
  }
  let items = Array.isArray(initial) ? initial.map((item, index) => normalizeRepeatableItem(item, index, spec)) : [];
  const itemName = spec.item_name || "子项";
  const idField = spec.item_id_field || "id";
  const orderField = spec.order_field || "order";
  const configuredSteps = Array.isArray(spec.steps) && spec.steps.length ? spec.steps : null;
  const steps = configuredSteps || [{
    id: "all",
    label: "全部字段",
    fields: (spec.item_fields || []).map((field) => field.key),
    allow_add: true,
    allow_delete: true,
    sortable: spec.sortable !== false,
  }];
  let activeStepIndex = Math.min(state.repeatableSteps[spec.key] || 0, steps.length - 1);
  let dependencyRefreshers = [];
  let visibilityRefreshers = [];
  const editor = document.createElement("div");
  editor.className = "repeatableEditor";

  const store = document.createElement("textarea");
  store.className = "fieldInput repeatableStore";
  store.dataset.key = spec.key;
  store.dataset.widget = "repeatable";
  store.setAttribute("aria-hidden", "true");
  editor.appendChild(store);

  const stepBar = document.createElement("div");
  stepBar.className = "repeatableSteps";
  steps.forEach((step, index) => {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "repeatableStep";
    button.textContent = step.label || `步骤 ${index + 1}`;
    button.addEventListener("click", () => {
      activeStepIndex = index;
      state.repeatableSteps[spec.key] = index;
      render();
    });
    stepBar.appendChild(button);
  });
  // A single configured step carries permissions/layout settings, but is not
  // something the annotator can switch between. Hiding its tab avoids a
  // full-width button that merely repeats the field heading.
  if (configuredSteps && steps.length > 1) editor.appendChild(stepBar);

  const toolbar = document.createElement("div");
  toolbar.className = "repeatableToolbar";
  const count = document.createElement("div");
  count.className = "repeatableCount";
  const add = document.createElement("button");
  add.type = "button";
  add.className = "primary";
  add.textContent = spec.add_label || `+ 新增${itemName}`;
  toolbar.append(count, add);
  editor.appendChild(toolbar);

  const warning = document.createElement("div");
  warning.className = "repeatableWarnings hidden";
  editor.appendChild(warning);
  const reviewNotice = document.createElement("div");
  reviewNotice.className = "collectionReviewNotice hidden";
  reviewNotice.setAttribute("role", "status");
  editor.appendChild(reviewNotice);
  const cards = document.createElement("div");
  cards.className = "repeatableCards";
  editor.appendChild(cards);
  const collapsedItemIds = new Set();

  function optionsFor(field, currentItem) {
    return optionsForRepeatableField(field, currentItem, items, idField);
  }

  function updateWarning() {
    const visibleKeys = new Set(steps[activeStepIndex].fields || []);
    const messages = repeatableWarnings(items, spec, visibleKeys);
    const blocking = repeatableWarnings(items, spec).filter((message) =>
      message.includes("不能选择自身") || message.includes("包含不存在的") || message.includes("存在循环关系"));
    const displayed = [...new Set([...messages, ...blocking])];
    warning.classList.toggle("hidden", displayed.length === 0);
    warning.textContent = displayed.join("；");
    store.dataset.validationError = blocking.join("；");
  }

  function sync() {
    items.forEach((item, index) => {
      if (spec.track_order === false) delete item[orderField];
      else item[orderField] = index + 1;
    });
    store.value = JSON.stringify(items);
    dependencyRefreshers.forEach((refresh) => refresh());
    visibilityRefreshers.forEach((refresh) => refresh());
    count.textContent = `已添加 ${items.length} 个${itemName}`;
    updateWarning();
    scheduleAutoSave();
  }

  function makeItemInput(item, field) {
    const widget = field.widget || "text";
    let control;
    if (widget === "text_list") {
      control = document.createElement("div");
      control.className = "repeatableTextList";
      const entries = item[field.key];
      const list = document.createElement("div");
      list.className = "repeatableTextListItems";
      function renderEntries() {
        list.replaceChildren();
        if (!entries.length) {
          const empty = document.createElement("div");
          empty.className = "repeatableTextListEmpty";
          empty.textContent = "暂无信息，点击下方按钮添加";
          list.appendChild(empty);
        }
        entries.forEach((value, index) => {
          const row = document.createElement("div");
          row.className = "repeatableTextListRow";
          const head = document.createElement("div");
          head.className = "repeatableTextListHead";
          const number = document.createElement("span");
          number.textContent = `第 ${index + 1} 条`;
          const input = document.createElement("textarea");
          input.rows = field.rows || 3;
          const hasSource = Array.isArray(field.source_options);
          input.value = hasSource ? value.content : value;
          input.placeholder = field.placeholder || "";
          input.setAttribute("aria-label", `${field.label || field.key} ${index + 1}`);
          input.disabled = field.editable === false;
          input.addEventListener("input", () => {
            if (hasSource) entries[index].content = input.value;
            else entries[index] = input.value;
            sync();
          });
          const remove = document.createElement("button");
          remove.type = "button";
          remove.className = "repeatableTextListRemove";
          remove.textContent = "删除";
          remove.setAttribute("aria-label", `删除${field.label || field.key}第 ${index + 1} 条`);
          remove.disabled = field.editable === false;
          remove.addEventListener("click", () => { entries.splice(index, 1); renderEntries(); sync(); });
          head.append(number, remove);
          row.appendChild(head);
          if (hasSource) {
            const body = document.createElement("div");
            body.className = "repeatableTextListSourceBody";
            const source = document.createElement("select");
            source.setAttribute("aria-label", `${field.label || field.key} ${index + 1} 来源`);
            source.disabled = field.editable === false;
            const choices = ["", ...field.source_options];
            if (value.source && !choices.includes(value.source)) choices.push(value.source);
            for (const choice of choices) {
              const option = document.createElement("option");
              option.value = choice;
              option.textContent = choice || "请选择来源";
              source.appendChild(option);
            }
            source.value = value.source;
            source.addEventListener("change", () => { entries[index].source = source.value; sync(); });
            body.append(source, input);
            row.appendChild(body);
          } else row.appendChild(input);
          list.appendChild(row);
        });
      }
      const addEntry = document.createElement("button");
      addEntry.type = "button";
      addEntry.className = "repeatableTextListAdd";
      addEntry.textContent = field.add_label || "+ 新增信息";
      addEntry.addEventListener("click", () => {
        entries.push(Array.isArray(field.source_options) ? { source: "", content: "" } : "");
        renderEntries(); sync();
        list.lastElementChild?.querySelector("textarea")?.focus();
      });
      control.append(list, addEntry);
      renderEntries();
    } else if (widget === "self_multiselect" && Array.isArray(field.show_results)) {
      control = document.createElement("div");
      control.className = "repeatableDependencyCards";
      const dependencies = Array.isArray(item[field.key]) ? item[field.key] : [];
      if (!dependencies.length) {
        const empty = document.createElement("div");
        empty.className = "repeatableDependencyEmpty";
        empty.textContent = `无依赖${itemName}`;
        control.appendChild(empty);
      }
      for (const dependencyId of dependencies) {
        const dependency = items.find((candidate) => String(candidate[idField]) === String(dependencyId));
        const summary = document.createElement("article");
        summary.className = "repeatableDependencySummary";
        const head = document.createElement("div");
        head.className = "repeatableDependencyCardHead";
        const badge = document.createElement("span");
        badge.className = "repeatableDependencyCardId";
        badge.textContent = String(dependencyId);
        const title = document.createElement("strong");
        title.className = "repeatableDependencyCardTitle";
        title.textContent = dependency ? String(dependency[spec.item_title_field] || itemName) : `${itemName}不存在`;
        head.append(badge, title);
        const body = document.createElement("div");
        body.className = "repeatableDependencyCardBody";
        summary.append(head, body);
        for (const resultKey of field.show_results) {
          const resultField = (spec.item_fields || []).find((candidate) => candidate.key === resultKey);
          const line = document.createElement("div");
          line.className = "repeatableDependencyResult";
          const label = document.createElement("span");
          label.className = "repeatableDependencyResultLabel";
          label.textContent = resultField?.label || resultKey;
          const content = document.createElement("div");
          content.className = "repeatableDependencyResultContent";
          line.append(label, content);
          const refresh = () => {
            const value = dependency?.[resultKey];
            const text = Array.isArray(value) ? value.join("；") : isPlainObject(value) ? JSON.stringify(value, null, 2) : value;
            const missing = text === undefined || text === null || text === "";
            content.textContent = missing ? "尚未填写" : String(text);
            content.classList.toggle("empty", missing);
          };
          refresh();
          dependencyRefreshers.push(refresh);
          body.appendChild(line);
        }
        control.appendChild(summary);
      }
    } else if (widget === "textarea") {
      control = document.createElement("textarea");
      control.rows = field.rows || 4;
      control.value = item[field.key] || "";
      control.placeholder = field.placeholder || "";
      control.addEventListener("input", () => {
        item[field.key] = field.nullable && control.value === "" ? null : control.value;
        sync();
      });
    } else if (widget === "checkbox") {
      control = document.createElement("input");
      control.type = "checkbox";
      control.checked = Boolean(item[field.key]);
      control.addEventListener("change", () => { item[field.key] = control.checked; sync(); });
    } else if (widget === "number") {
      control = document.createElement("input");
      control.type = "number";
      control.step = "any";
      control.value = item[field.key] ?? "";
      control.addEventListener("input", () => {
        item[field.key] = control.value === "" ? null : Number(control.value);
        sync();
      });
    } else if (widget === "cascader") {
      control = document.createElement("div");
      control.className = "cascaderControl";
      const delimiter = field.delimiter || "；";
      const paths = optionsFor(field, item).map((option) => option.split(delimiter));
      let selectedParts = Array.isArray(item[field.key]) ? [...item[field.key]]
        : item[field.key] ? String(item[field.key]).split(delimiter) : [];
      function renderLevels() {
        control.innerHTML = "";
        const prefix = [];
        let depth = 0;
        while (true) {
          const choices = [...new Set(paths
            .filter((path) => prefix.every((part, idx) => path[idx] === part) && path.length > depth)
            .map((path) => path[depth]))];
          if (!choices.length) break;
          const select = document.createElement("select");
          const empty = document.createElement("option");
          empty.value = "";
          empty.textContent = field.level_labels?.[depth] || `请选择第 ${depth + 1} 级`;
          select.appendChild(empty);
          for (const choice of choices) {
            const option = document.createElement("option");
            option.value = choice;
            option.textContent = choice;
            select.appendChild(option);
          }
          select.value = selectedParts[depth] || "";
          const currentDepth = depth;
          select.addEventListener("change", () => {
            selectedParts = selectedParts.slice(0, currentDepth);
            if (select.value) selectedParts.push(select.value);
            item[field.key] = field.value_type === "array" ? [...selectedParts] : selectedParts.join(delimiter);
            renderLevels();
            sync();
          });
          control.appendChild(select);
          if (!select.value) break;
          prefix.push(select.value);
          depth += 1;
        }
      }
      renderLevels();
    } else if (widget === "checkbox_group") {
      control = document.createElement("div");
      control.className = "checkboxGroup";
      const options = optionsFor(field, item);
      const rawSelected = Array.isArray(item[field.key]) ? item[field.key].map(String) : [];
      const separator = field.option_entry_separator ?? "\n";
      const selected = new Set(rawSelected.map((value) => {
        if (options.includes(value)) return value;
        if (field.options_from_object === "entries") {
          return options.find((option) => option.split(separator, 1)[0] === value) || value;
        }
        return value;
      }));
      // Preserve saved references even when the current source lacks a candidate.
      for (const value of selected) {
        if (!options.includes(value)) options.push(value);
      }
      if (field.options_from_object === "entries") {
        item[field.key] = options.filter((option) => selected.has(option));
      }
      const list = document.createElement("div");
      list.className = "checkboxGroupList";
      const rows = [];
      for (const value of options) {
        const row = document.createElement("label");
        row.className = "checkboxOption";
        const checkbox = document.createElement("input");
        checkbox.type = "checkbox";
        checkbox.checked = selected.has(value);
        const text = document.createElement("span");
        text.className = "checkboxOptionText";
        if (field.options_from_object === "entries" && value.includes(separator)) {
          const splitAt = value.indexOf(separator);
          const title = document.createElement("strong");
          title.textContent = value.slice(0, splitAt);
          const detail = document.createElement("span");
          detail.textContent = value.slice(splitAt + separator.length);
          text.append(title, detail);
        } else {
          text.textContent = value;
        }
        checkbox.addEventListener("change", () => {
          if (checkbox.checked) selected.add(value); else selected.delete(value);
          item[field.key] = options.filter((option) => selected.has(option));
          sync();
        });
        row.append(checkbox, text);
        rows.push([row, value.toLowerCase()]);
        list.appendChild(row);
      }
      if (options.length > 8) {
        const search = document.createElement("input");
        search.type = "search";
        search.placeholder = field.search_placeholder || "筛选选项";
        search.className = "checkboxGroupSearch";
        search.addEventListener("input", () => {
          const query = search.value.trim().toLowerCase();
          for (const [row, text] of rows) row.classList.toggle("hidden", Boolean(query) && !text.includes(query));
        });
        control.appendChild(search);
      }
      control.appendChild(list);
    } else if (["select", "multiselect", "self_multiselect"].includes(widget)) {
      control = document.createElement("select");
      const options = optionsFor(field, item);
      if (widget === "select") {
        const empty = document.createElement("option");
        empty.value = "";
        empty.textContent = field.empty_label || "请选择";
        control.appendChild(empty);
        const current = item[field.key] ?? "";
        if (current && !options.includes(String(current))) options.unshift(String(current));
        for (const value of options) {
          const option = document.createElement("option");
          option.value = value;
          option.textContent = field.option_labels?.[value] ?? value;
          control.appendChild(option);
        }
        control.value = current;
        control.addEventListener("change", () => {
          item[field.key] = field.value_type === "boolean"
            ? (control.value === "" ? null : control.value === "true")
            : control.value;
          sync();
        });
      } else {
        control.multiple = true;
        control.size = Math.max(2, Math.min(field.size || 5, Math.max(2, options.length)));
        const selected = new Set(Array.isArray(item[field.key]) ? item[field.key].map(String) : []);
        for (const value of options) {
          const option = document.createElement("option");
          option.value = value;
          option.textContent = value;
          option.selected = selected.has(value);
          control.appendChild(option);
        }
        control.addEventListener("change", () => {
          item[field.key] = [...control.selectedOptions].map((option) => option.value);
          sync();
        });
      }
    } else {
      control = document.createElement("input");
      control.type = "text";
      control.value = item[field.key] || "";
      control.placeholder = field.placeholder || "";
      control.addEventListener("input", () => { item[field.key] = control.value; sync(); });
    }
    return control;
  }

  const graphPositions = new Map();
  let graphSelectedId = null;
  let graphResizeObserver = null;

  function connectedGroups(relationField) {
    const byId = new Map(items.map((item) => [String(item[idField]), item]));
    const neighbors = new Map([...byId.keys()].map((id) => [id, new Set()]));
    for (const item of items) {
      const itemId = String(item[idField]);
      for (const relatedId of Array.isArray(item[relationField]) ? item[relationField].map(String) : []) {
        if (!byId.has(relatedId) || relatedId === itemId) continue;
        neighbors.get(itemId).add(relatedId);
        neighbors.get(relatedId).add(itemId);
      }
    }
    const seen = new Set();
    const groups = [];
    for (const item of items) {
      const start = String(item[idField]);
      if (seen.has(start)) continue;
      const ids = [];
      const queue = [start];
      seen.add(start);
      while (queue.length) {
        const id = queue.shift();
        ids.push(id);
        for (const next of neighbors.get(id) || []) {
          if (!seen.has(next)) {
            seen.add(next);
            queue.push(next);
          }
        }
      }
      groups.push(ids.map((id) => byId.get(id)));
    }
    return groups;
  }

  function dependencyLevels(groupItems, relationField) {
    const ids = new Set(groupItems.map((item) => String(item[idField])));
    const remaining = new Set(ids);
    const resolved = new Set();
    const levels = [];
    while (remaining.size) {
      const ready = groupItems.filter((item) => {
        const itemId = String(item[idField]);
        if (!remaining.has(itemId)) return false;
        const dependencies = (Array.isArray(item[relationField]) ? item[relationField] : [])
          .map(String).filter((dependencyId) => ids.has(dependencyId));
        return dependencies.every((dependencyId) => resolved.has(dependencyId));
      });
      if (!ready.length) {
        levels.push({ items: groupItems.filter((item) => remaining.has(String(item[idField]))), cyclic: true });
        break;
      }
      levels.push({ items: ready, cyclic: false });
      for (const item of ready) {
        const itemId = String(item[idField]);
        remaining.delete(itemId);
        resolved.add(itemId);
      }
    }
    return levels;
  }

  function makeItemCard(item, step) {
    const index = items.indexOf(item);
    const itemId = String(item[idField]);
    const card = document.createElement("section");
    card.className = "repeatableCard";
    const head = document.createElement("div");
    head.className = "repeatableCardHead";
    const title = document.createElement("div");
    title.className = "repeatableCardTitle";
    const titleValue = spec.item_title_field ? item[spec.item_title_field] : "";
    title.textContent = titleValue
      ? `${item[idField]} · ${String(titleValue).slice(0, 80)}`
      : `${item[idField]} · ${itemName} ${index + 1}`;
    const actions = document.createElement("div");
    actions.className = "repeatableCardActions";
    const collapse = document.createElement("button");
    collapse.type = "button";
    collapse.className = "repeatableCollapseBtn";
    collapse.addEventListener("click", () => {
      if (collapsedItemIds.has(itemId)) collapsedItemIds.delete(itemId);
      else collapsedItemIds.add(itemId);
      updateCollapsedState();
    });
    actions.appendChild(collapse);
    const stepSortable = spec.track_order !== false &&
      (step.sortable !== undefined ? step.sortable : spec.sortable !== false);
    if (stepSortable) {
      const up = document.createElement("button");
      up.type = "button";
      up.textContent = "上移";
      up.disabled = index === 0;
      up.addEventListener("click", () => {
        [items[index - 1], items[index]] = [items[index], items[index - 1]];
        render(); sync();
      });
      const down = document.createElement("button");
      down.type = "button";
      down.textContent = "下移";
      down.disabled = index === items.length - 1;
      down.addEventListener("click", () => {
        [items[index], items[index + 1]] = [items[index + 1], items[index]];
        render(); sync();
      });
      actions.append(up, down);
    }
    if (step.allow_delete !== false) {
      const remove = document.createElement("button");
      remove.type = "button";
      remove.className = "dangerText";
      remove.textContent = "删除";
      remove.addEventListener("click", () => {
        if (!window.confirm(`确定删除 ${item[idField]}？`)) return;
        const removedId = item[idField];
        items.splice(index, 1);
        collapsedItemIds.delete(String(removedId));
        graphPositions.delete(String(removedId));
        for (const other of items) {
          for (const field of (spec.item_fields || []).filter((f) => f.widget === "self_multiselect")) {
            other[field.key] = (other[field.key] || []).filter((id) => id !== removedId);
          }
        }
        render(); sync();
      });
      actions.appendChild(remove);
    }
    head.append(title, actions);
    card.appendChild(head);

    const grid = document.createElement("div");
    grid.className = "repeatableCardGrid";
    const fieldsByKey = new Map((spec.item_fields || []).map((field) => [field.key, field]));
    const configuredSections = step.sections || [];
    const sectionKeys = new Set(configuredSections.flatMap((section) => section.fields || []));
    const sections = [...configuredSections, { fields: (step.fields || []).filter((key) => !sectionKeys.has(key)) }];
    for (const section of sections) {
      const container = section.label ? document.createElement("section") : grid;
      if (section.label) {
        container.className = "repeatableCardSection";
        const heading = document.createElement("h4");
        heading.textContent = section.label;
        container.appendChild(heading);
        grid.appendChild(container);
      }
      for (const key of (step.fields || []).filter((key) => (section.fields || []).includes(key))) {
        if (!(step.fields || []).includes(key)) continue;
        const original = fieldsByKey.get(key);
        if (!original) continue;
        const field = { ...original, ...step.field_overrides?.[key] };
        const box = makeRepeatableControl(field, makeItemInput(item, field));
        if (field.visible_if) {
          const refresh = () => { box.hidden = !repeatableFieldVisible(field, item); };
          refresh();
          visibilityRefreshers.push(refresh);
        }
        container.appendChild(box);
      }
    }
    card.appendChild(grid);
    function updateCollapsedState() {
      const isCollapsed = collapsedItemIds.has(itemId);
      card.classList.toggle("collapsed", isCollapsed);
      grid.hidden = isCollapsed;
      collapse.textContent = isCollapsed ? "展开" : "收起";
      collapse.setAttribute("aria-expanded", String(!isCollapsed));
    }
    updateCollapsedState();
    return card;
  }

  function renderGraphStep(step) {
    const relationField = step.relation_field || step.fields?.[0];
    const shell = document.createElement("section");
    shell.className = "dependencyGraph";
    const guide = document.createElement("div");
    guide.className = "dependencyGraphGuide";
    const instructions = document.createElement("span");
    instructions.textContent = spec.track_order === false
      ? "拖动节点仅调整图上位置；依次点击“前置项 → 依赖项”建立或取消连线；点击连线可删除。"
      : "拖动节点调整顺序；依次点击“前置项 → 依赖项”建立或取消连线；点击连线可删除。";
    const status = document.createElement("strong");
    status.textContent = "尚未选择前置项";
    guide.append(instructions, status);
    const canvas = document.createElement("div");
    canvas.className = "dependencyGraphCanvas";
    const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    svg.classList.add("dependencyGraphEdges");
    const markerId = `dependency-arrow-${Math.random().toString(36).slice(2)}`;
    const defs = document.createElementNS("http://www.w3.org/2000/svg", "defs");
    const marker = document.createElementNS("http://www.w3.org/2000/svg", "marker");
    marker.setAttribute("id", markerId);
    marker.setAttribute("viewBox", "0 0 10 10");
    marker.setAttribute("refX", "9");
    marker.setAttribute("refY", "5");
    marker.setAttribute("markerWidth", "7");
    marker.setAttribute("markerHeight", "7");
    marker.setAttribute("orient", "auto-start-reverse");
    const arrow = document.createElementNS("http://www.w3.org/2000/svg", "path");
    arrow.setAttribute("d", "M 0 0 L 10 5 L 0 10 z");
    marker.appendChild(arrow);
    defs.appendChild(marker);
    svg.appendChild(defs);
    canvas.appendChild(svg);
    shell.append(guide, canvas);
    cards.appendChild(shell);

    const nodes = new Map();
    for (const item of items) {
      const itemId = String(item[idField]);
      const node = document.createElement("button");
      node.type = "button";
      node.className = "dependencyGraphNode";
      node.dataset.id = itemId;
      const idLine = document.createElement("span");
      idLine.className = "dependencyGraphNodeId";
      const titleLine = document.createElement("span");
      titleLine.className = "dependencyGraphNodeTitle";
      titleLine.textContent = String(spec.item_title_field ? item[spec.item_title_field] || itemName : itemName).slice(0, 52);
      node.append(idLine, titleLine);
      canvas.appendChild(node);
      nodes.set(itemId, node);
    }

    function updateNodeState() {
      items.forEach((item, index) => {
        const id = String(item[idField]);
        const node = nodes.get(id);
        if (!node) return;
        node.classList.toggle("selected", id === graphSelectedId);
        node.querySelector(".dependencyGraphNodeId").textContent = spec.track_order === false ? id : `${index + 1}. ${id}`;
      });
      status.textContent = graphSelectedId
        ? `已选前置项 ${graphSelectedId}，请选择依赖它的节点`
        : "尚未选择前置项";
    }

    function ensurePositions() {
      const width = Math.max(360, canvas.clientWidth || 720);
      const nodeWidth = 184;
      const columns = Math.max(1, Math.floor((width - 32) / 214));
      items.forEach((item, index) => {
        const id = String(item[idField]);
        if (!graphPositions.has(id)) {
          graphPositions.set(id, {
            x: 18 + (index % columns) * 214,
            y: 24 + Math.floor(index / columns) * 116,
          });
        }
      });
      const maxY = Math.max(0, ...[...graphPositions.values()].map((position) => position.y));
      canvas.style.height = `${Math.max(400, maxY + 112)}px`;
      for (const [id, node] of nodes) {
        const position = graphPositions.get(id);
        node.style.left = `${Math.max(8, Math.min(position.x, width - nodeWidth - 8))}px`;
        node.style.top = `${Math.max(8, position.y)}px`;
      }
    }

    function removeEdge(dependent, dependencyId) {
      dependent[relationField] = (Array.isArray(dependent[relationField]) ? dependent[relationField] : [])
        .filter((id) => String(id) !== dependencyId);
      sync();
      drawEdges();
    }

    function drawEdges() {
      svg.replaceChildren(defs);
      const width = Math.max(360, canvas.clientWidth || 720);
      const height = canvas.clientHeight || 400;
      svg.setAttribute("viewBox", `0 0 ${width} ${height}`);
      for (const dependent of items) {
        const dependentId = String(dependent[idField]);
        const toNode = nodes.get(dependentId);
        if (!toNode) continue;
        for (const rawDependencyId of Array.isArray(dependent[relationField]) ? dependent[relationField] : []) {
          const dependencyId = String(rawDependencyId);
          const fromNode = nodes.get(dependencyId);
          if (!fromNode) continue;
          const fromCenter = [
            fromNode.offsetLeft + fromNode.offsetWidth / 2,
            fromNode.offsetTop + fromNode.offsetHeight / 2,
          ];
          const toCenter = [
            toNode.offsetLeft + toNode.offsetWidth / 2,
            toNode.offsetTop + toNode.offsetHeight / 2,
          ];
          const dx = toCenter[0] - fromCenter[0];
          const dy = toCenter[1] - fromCenter[1];
          function boundaryPoint(center, vx, vy, node, padding = 5) {
            const tx = vx === 0 ? Infinity : (node.offsetWidth / 2 + padding) / Math.abs(vx);
            const ty = vy === 0 ? Infinity : (node.offsetHeight / 2 + padding) / Math.abs(vy);
            const scale = Math.min(tx, ty, .48);
            return [center[0] + vx * scale, center[1] + vy * scale];
          }
          const [x1, y1] = boundaryPoint(fromCenter, dx, dy, fromNode);
          const [x2, y2] = boundaryPoint(toCenter, -dx, -dy, toNode, 9);
          const curve = (x2 - x1) * .35;
          const d = `M ${x1} ${y1} C ${x1 + curve} ${y1}, ${x2 - curve} ${y2}, ${x2} ${y2}`;
          const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
          path.setAttribute("d", d);
          path.setAttribute("class", "dependencyGraphEdge");
          path.setAttribute("marker-end", `url(#${markerId})`);
          const hit = document.createElementNS("http://www.w3.org/2000/svg", "path");
          hit.setAttribute("d", d);
          hit.setAttribute("class", "dependencyGraphEdgeHit");
          hit.addEventListener("click", (event) => {
            event.stopPropagation();
            removeEdge(dependent, dependencyId);
          });
          svg.append(path, hit);
        }
      }
    }

    function transitivelyDependsOn(startId, targetId, seen = new Set()) {
      if (startId === targetId) return true;
      if (seen.has(startId)) return false;
      seen.add(startId);
      const item = items.find((candidate) => String(candidate[idField]) === startId);
      return (Array.isArray(item?.[relationField]) ? item[relationField] : [])
        .some((dependencyId) => transitivelyDependsOn(String(dependencyId), targetId, seen));
    }

    function selectNode(id) {
      if (!graphSelectedId) {
        graphSelectedId = id;
      } else if (graphSelectedId === id) {
        graphSelectedId = null;
      } else {
        const dependent = items.find((item) => String(item[idField]) === id);
        const dependencies = new Set(Array.isArray(dependent[relationField]) ? dependent[relationField].map(String) : []);
        if (dependencies.has(graphSelectedId)) {
          dependencies.delete(graphSelectedId);
        } else {
          if (transitivelyDependsOn(graphSelectedId, id)) {
            toast("该连线会形成循环依赖，已阻止添加", "err", 3500);
            graphSelectedId = null;
            updateNodeState();
            return;
          }
          dependencies.add(graphSelectedId);
        }
        dependent[relationField] = [...dependencies];
        graphSelectedId = null;
        sync();
        drawEdges();
      }
      updateNodeState();
    }

    for (const [id, node] of nodes) {
      let drag = null;
      node.addEventListener("pointerdown", (event) => {
        if (event.button !== 0) return;
        const position = graphPositions.get(id) || { x: node.offsetLeft, y: node.offsetTop };
        drag = { startX: event.clientX, startY: event.clientY, x: position.x, y: position.y, moved: false };
        node.setPointerCapture(event.pointerId);
        event.preventDefault();
      });
      node.addEventListener("pointermove", (event) => {
        if (!drag) return;
        const dx = event.clientX - drag.startX;
        const dy = event.clientY - drag.startY;
        if (Math.abs(dx) + Math.abs(dy) > 5) drag.moved = true;
        if (!drag.moved) return;
        const width = canvas.clientWidth || 720;
        const position = {
          x: Math.max(8, Math.min(drag.x + dx, width - node.offsetWidth - 8)),
          y: Math.max(8, drag.y + dy),
        };
        graphPositions.set(id, position);
        node.style.left = `${position.x}px`;
        node.style.top = `${position.y}px`;
        canvas.style.height = `${Math.max(400, position.y + 112)}px`;
        drawEdges();
      });
      node.addEventListener("pointerup", (event) => {
        if (!drag) return;
        node.releasePointerCapture(event.pointerId);
        if (drag.moved && spec.track_order !== false) {
          items.sort((a, b) => {
            const pa = graphPositions.get(String(a[idField]));
            const pb = graphPositions.get(String(b[idField]));
            return (pa.y - pb.y) || (pa.x - pb.x);
          });
          sync();
          updateNodeState();
        } else if (!drag.moved) {
          selectNode(id);
        }
        drag = null;
      });
    }

    function layoutAndDraw() {
      ensurePositions();
      updateNodeState();
      drawEdges();
    }
    requestAnimationFrame(layoutAndDraw);
    if (typeof ResizeObserver !== "undefined") {
      graphResizeObserver = new ResizeObserver(layoutAndDraw);
      graphResizeObserver.observe(canvas);
    }
  }

  function render() {
    dependencyRefreshers = [];
    visibilityRefreshers = [];
    const step = steps[activeStepIndex];
    reviewNotice.dataset.sourceFields = JSON.stringify(step.review_source_fields || []);
    updateCollectionReviewNotice(reviewNotice);
    [...stepBar.children].forEach((button, index) => button.classList.toggle("active", index === activeStepIndex));
    add.classList.toggle("hidden", step.allow_add === false);
    graphResizeObserver?.disconnect();
    graphResizeObserver = null;
    cards.innerHTML = "";
    if (!items.length) {
      const empty = document.createElement("div");
      empty.className = "repeatableEmpty";
      empty.textContent = spec.empty_text || `尚未添加${itemName}`;
      cards.appendChild(empty);
    } else if (step.view === "graph") {
      renderGraphStep(step);
    } else if (step.group_by_relation) {
      connectedGroups(step.group_by_relation).forEach((groupItems, groupIndex) => {
        const group = document.createElement("section");
        group.className = "repeatableDependencyGroup";
        const groupHead = document.createElement("div");
        groupHead.className = "repeatableDependencyGroupHead";
        const groupTitle = groupItems.length > 1
          ? `${step.group_label || "关联组"} ${groupIndex + 1}`
          : (step.single_label || "独立项");
        groupHead.textContent = `${groupTitle} · ${groupItems.map((item) => item[idField]).join("、")}`;
        const layers = document.createElement("div");
        layers.className = "repeatableDependencyLevels";
        dependencyLevels(groupItems, step.group_by_relation).forEach((level, levelIndex) => {
          const layer = document.createElement("section");
          layer.className = "repeatableDependencyLevel" + (level.cyclic ? " cyclic" : "");
          const layerTitle = document.createElement("div");
          layerTitle.className = "repeatableDependencyLevelTitle";
          layerTitle.textContent = level.cyclic
            ? "循环依赖（请返回关系图修正）"
            : (levelIndex === 0 ? "无前置依赖" : `依赖层级 ${levelIndex + 1}`);
          const groupCards = document.createElement("div");
          groupCards.className = "repeatableDependencyGroupCards";
          for (const item of level.items) groupCards.appendChild(makeItemCard(item, step));
          layer.append(layerTitle, groupCards);
          layers.appendChild(layer);
        });
        group.append(groupHead, layers);
        cards.appendChild(group);
      });
    } else {
      for (const item of items) cards.appendChild(makeItemCard(item, step));
    }
    sync();
  }

  add.addEventListener("click", () => {
    const item = normalizeRepeatableItem({}, items.length, spec);
    item[idField] = nextRepeatableId(items, spec);
    items.push(item);
    render();
    cards.lastElementChild?.scrollIntoView({ behavior: "smooth", block: "start" });
  });
  editor.captureViewState = () => ({
    collapsed: [...collapsedItemIds], positions: [...graphPositions], selected: graphSelectedId,
  });
  editor.restoreViewState = (view) => {
    if (!view) return;
    collapsedItemIds.clear();
    view.collapsed.forEach(id => collapsedItemIds.add(id));
    graphPositions.clear();
    view.positions.forEach(([id, position]) => graphPositions.set(id, position));
    graphSelectedId = view.selected;
    render();
  };
  render();
  return editor;
}

function collectionHasRevisions(key) {
  const spec = state.template?.fields.find((field) => field.key === key);
  if (!spec?.backup_field) return false;
  const store = [...document.querySelectorAll(".collectionValueInput")].find((input) => input.dataset.key === key);
  const current = store ? JSON.parse(store.value) : getByPath(state.currentRow, key);
  const original = getByPath(state.currentRow, spec.backup_field) ?? getByPath(state.currentRow, key);
  return JSON.stringify(current) !== JSON.stringify(original);
}

function updateCollectionReviewNotice(notice) {
  const keys = JSON.parse(notice.dataset.sourceFields || "[]").filter(collectionHasRevisions);
  const labels = keys.map((key) => fieldSpecFor(key).label || key);
  notice.textContent = labels.length ? `${labels.join("、")}已发生修订，请检查相关标注是否需要更新。` : "";
  notice.classList.toggle("hidden", !keys.length);
}

function makeCollectionEditor(spec, value) {
  const editor = document.createElement("div");
  editor.className = "collectionEditor";
  if (!isPlainObject(value)) {
    const error = document.createElement("div");
    error.className = "collectionCardsEmpty";
    error.textContent = "当前数据不是对象，无法修订";
    editor.appendChild(error);
    return editor;
  }
  const clone = (v) => JSON.parse(JSON.stringify(v));
  let items = clone(value);
  const original = clone(getByPath(state.currentRow, spec.backup_field) ?? value);
  const editableFields = (spec.card_fields || []).filter((field) => field.editable);
  let editingKey = null;
  const openKeys = new Set(spec.collapsed ? [] : Object.keys(items));
  const store = document.createElement("input");
  store.type = "hidden";
  store.className = "fieldInput collectionValueInput";
  store.dataset.key = spec.key;
  store.dataset.widget = "json";
  store.value = JSON.stringify(items);
  const content = document.createElement("div");
  editor.append(store, content);

  function sync() {
    store.value = JSON.stringify(items);
    document.querySelectorAll(".collectionReviewNotice").forEach(updateCollectionReviewNotice);
    scheduleAutoSave();
  }
  function button(label, key, action) {
    const control = document.createElement("button");
    control.type = "button";
    control.textContent = label;
    control.setAttribute("aria-label", `${label}：${key}`);
    control.disabled = editingKey !== null;
    control.addEventListener("click", action);
    return control;
  }
  function render() {
    const list = makeCollectionCards({ ...spec, editable: false }, items);
    Object.entries(items).forEach(([key, item], index) => {
      const card = list.children[index];
      const summary = card.querySelector("summary");
      const body = card.querySelector(".collectionCardBody");
      const changed = editableFields.length > 0 && original[key] && JSON.stringify(item) !== JSON.stringify(original[key]);
      card.open = openKeys.has(key);
      card.addEventListener("toggle", () => {
        if (!card.isConnected) return;
        if (card.open) openKeys.add(key); else openKeys.delete(key);
      });
      if (changed) {
        const badge = document.createElement("span");
        badge.className = "collectionModifiedBadge";
        badge.textContent = "已修正";
        summary.appendChild(badge);
      }
      const actions = document.createElement("div");
      actions.className = "collectionCardActions";
      if (editableFields.length) actions.appendChild(button("修正", key, () => {
        editingKey = key;
        openKeys.add(key);
        store.dataset.validationError = "请先应用或取消正在进行的条目修正";
        render();
        content.querySelector(".collectionEditInput")?.focus();
      }));
      if (spec.allow_delete) {
        const remove = button("删除", key, () => {
          delete items[key];
          openKeys.delete(key);
          render(); sync();
        });
        remove.className = "dangerText";
        actions.appendChild(remove);
      }
      body.prepend(actions);
      if (editingKey === key) {
        const form = document.createElement("div");
        form.className = "collectionEditForm";
        const inputs = editableFields.map((field) => {
          const label = document.createElement("label");
          label.textContent = field.label || field.key;
          const input = document.createElement("textarea");
          input.className = "collectionEditInput";
          input.rows = field.rows || 10;
          input.value = getByPath(item, field.key) ?? "";
          label.appendChild(input);
          form.appendChild(label);
          return { field, input };
        });
        const error = document.createElement("div");
        error.className = "collectionEditError";
        error.setAttribute("role", "alert");
        const apply = button("应用修改", key, () => {
          if (inputs.some(({ input }) => !input.value.trim())) {
            error.textContent = "内容不能为空；如不需要此条目，请取消后删除。";
            return;
          }
          inputs.forEach(({ field, input }) => setByPath(item, field.key, input.value));
          editingKey = null;
          delete store.dataset.validationError;
          render(); sync();
        });
        const cancel = button("取消", key, () => {
          editingKey = null;
          delete store.dataset.validationError;
          render();
        });
        apply.disabled = cancel.disabled = false;
        const formActions = document.createElement("div");
        formActions.className = "collectionCardActions";
        formActions.append(apply, cancel);
        form.append(error, formActions);
        body.prepend(form);
        // 编辑时只显示一份正文；其他只读信息仍保留供对照。
        body.querySelectorAll(".collectionCardField").forEach((block) => {
          if (editableFields.some((field) => field.key === block.dataset.key)) block.classList.add("hidden");
        });
      }
      if (changed) {
        const source = document.createElement("details");
        source.className = "collectionOriginal";
        const title = document.createElement("summary");
        title.textContent = "查看原文";
        source.appendChild(title);
        for (const field of editableFields) {
          const text = document.createElement("div");
          text.className = "collectionCardFieldValue";
          text.textContent = getByPath(original[key], field.key) ?? "";
          source.appendChild(text);
        }
        body.append(source, button("恢复原文", key, () => {
          items[key] = clone(original[key]);
          render(); sync();
        }));
      }
    });
    content.replaceChildren(list);
    const deleted = Object.keys(original).filter((key) => !Object.hasOwn(items, key));
    if (deleted.length) {
      const archive = document.createElement("details");
      archive.className = "collectionDeleted";
      const summary = document.createElement("summary");
      summary.textContent = `已删除条目（${deleted.length}）`;
      archive.appendChild(summary);
      for (const key of deleted) {
        const row = document.createElement("div");
        row.className = "collectionDeletedRow";
        const title = document.createElement("span");
        title.textContent = key;
        row.append(title, button("恢复", key, () => {
          items[key] = clone(original[key]);
          // 恢复原始顺序，避免删除后恢复留下虚假的修订标记。
          items = Object.fromEntries(Object.keys(original).filter((name) => Object.hasOwn(items, name))
            .map((name) => [name, items[name]]));
          openKeys.add(key);
          render(); sync();
        }));
        archive.appendChild(row);
      }
      content.appendChild(archive);
    }
  }
  editor.captureViewState = () => ({
    openKeys: [...openKeys], editingKey,
    draft: [...content.querySelectorAll('.collectionEditInput')].map(input => input.value),
  });
  editor.restoreViewState = (view) => {
    if (!view) return;
    openKeys.clear();
    view.openKeys.forEach(key => openKeys.add(key));
    editingKey = view.editingKey;
    if (editingKey !== null) store.dataset.validationError = '请先应用或取消正在进行的条目修正';
    render();
    content.querySelectorAll('.collectionEditInput').forEach((input, i) => { input.value = view.draft[i] ?? input.value; });
  };
  render();
  return editor;
}

function makeCollectionCards(spec, value) {
  if (spec.editable && spec.backup_field) return makeCollectionEditor(spec, value);
  const container = document.createElement("div");
  container.className = "collectionCards";
  const entries = Array.isArray(value)
    ? value.map((item, index) => [String(index + 1), item])
    : isPlainObject(value) ? Object.entries(value) : [];
  if (!entries.length) {
    const empty = document.createElement("div");
    empty.className = "collectionCardsEmpty";
    empty.textContent = spec.empty_text || "暂无内容";
    container.appendChild(empty);
    return container;
  }
  for (const [entryKey, rawItem] of entries) {
    const item = isPlainObject(rawItem) ? rawItem : { value: rawItem };
    const card = document.createElement("details");
    card.className = "collectionCard";
    card.open = !spec.collapsed;
    const summary = document.createElement("summary");
    const titleValue = spec.card_title_field ? getByPath(item, spec.card_title_field) : null;
    summary.textContent = titleValue || entryKey;
    card.appendChild(summary);
    const body = document.createElement("div");
    body.className = "collectionCardBody";
    const fields = Array.isArray(spec.card_fields) && spec.card_fields.length
      ? spec.card_fields
      : Object.keys(item).map((key) => ({ key, label: key }));
    let visibleCount = 0;
    for (const field of fields) {
      const fieldValue = getByPath(item, field.key);
      if (fieldValue === null || fieldValue === undefined || fieldValue === "" ||
          (Array.isArray(fieldValue) && !fieldValue.length)) continue;
      visibleCount += 1;
      const block = document.createElement("div");
      block.className = "collectionCardField";
      block.dataset.key = field.key;
      const label = document.createElement("div");
      label.className = "collectionCardFieldLabel";
      label.textContent = field.label || field.key;
      const content = document.createElement("div");
      content.className = "collectionCardFieldValue";
      const text = typeof fieldValue === 'string' ? fieldValue : JSON.stringify(fieldValue, null, 2);
      if ((field.segment_display ?? spec.segment_display) && typeof fieldValue === 'string') renderSegmentedText(content, text);
      else content.textContent = text;
      block.append(label, content);
      body.appendChild(block);
    }
    if (!visibleCount) {
      const empty = document.createElement("div");
      empty.className = "collectionCardsEmpty";
      empty.textContent = "无可展示字段";
      body.appendChild(empty);
    }
    card.appendChild(body);
    container.appendChild(card);
  }
  return container;
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
  } else if (spec.key !== LABELLED_FIELD && !["repeatable", "collection_cards"].includes(spec.widget)) {
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

  const w = spec.widget;
  if (w === "repeatable") {
    wrap.appendChild(makeRepeatableEditor(spec, value));
    return wrap;
  }
  if (w === "collection_cards") {
    wrap.appendChild(makeCollectionCards(spec, value));
    return wrap;
  }

  let input;
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
  let display = input;
  if (spec.segment_display && ['text', 'textarea'].includes(w)) {
    const preview = document.createElement('div');
    preview.className = 'segmentedText';
    renderSegmentedText(preview, input.value);
    if (spec.editable) {
      const toggle = document.createElement('button');
      toggle.type = 'button';
      toggle.className = 'segmentDisplayToggle';
      toggle.textContent = '编辑原文';
      toggle.addEventListener('click', () => {
        const editing = input.classList.contains('hidden');
        input.classList.toggle('hidden', !editing);
        preview.classList.toggle('hidden', editing);
        toggle.textContent = editing ? '分段预览' : '编辑原文';
        if (editing) input.focus();
      });
      headRight.appendChild(toggle);
      input.addEventListener('input', () => renderSegmentedText(preview, input.value));
    }
    input.classList.add('hidden');
    display = document.createElement('div');
    display.append(input, preview);
  }
  if (spec.collapsible) {
    const details = document.createElement("details");
    details.className = "sourceDetails";
    details.open = !spec.collapsed;
    const summary = document.createElement("summary");
    summary.textContent = details.open ? "收起内容" : "展开内容";
    details.addEventListener("toggle", () => {
      summary.textContent = details.open ? "收起内容" : "展开内容";
    });
    details.append(summary, display);
    wrap.appendChild(details);
  } else {
    wrap.appendChild(display);
  }
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
  let value = getByPath(state.currentRow, spec.key);
  const saved = state.renderingView?.fields[spec.key];
  if (saved?.dirty && saved.value !== undefined && ['repeatable', 'collection_cards'].includes(spec.widget)) {
    try { value = JSON.parse(saved.value); } catch {}
  }
  const el = makeFieldEditor(spec, value);
  const input = el.querySelector('.fieldInput');
  if (input) {
    input.dataset.renderedValue = saved?.dirty ? saved.baselineValue : input.value;
    input.dataset.renderedChecked = saved?.dirty ? saved.baselineChecked : String(input.checked);
  }
  if (state.deletedKeys.has(spec.key)) {
    el.classList.add("deleted");
    const btn = el.querySelector(".fieldDelBtn");
    if (btn) btn.replaceWith(makeUndoBtn(spec.key, el));
  }
  return el;
}

function renderFieldSpecs(container, specs) {
  let i = 0;
  while (i < specs.length) {
    const spec = specs[i];
    const group = (spec.group || "").trim();
    if (!group) {
      container.appendChild(makeRenderedFieldEditor(spec));
      i += 1;
      continue;
    }
    const members = [spec];
    let j = i + 1;
    while (j < specs.length && (specs[j].group || "").trim() === group) {
      members.push(specs[j]);
      j += 1;
    }
    const groupBox = document.createElement("div");
    groupBox.className = "fieldGroup";
    groupBox.style.gridTemplateColumns = `repeat(${members.length}, minmax(0, 1fr))`;
    for (const member of members) groupBox.appendChild(makeRenderedFieldEditor(member));
    container.appendChild(groupBox);
    i = j;
  }
}

function renderDetail(view = captureRecordView()) {
  const row = state.currentRow;
  if (row === null) return;
  state.renderingView = view;
  state.rendering = true;
  const sourceContainer = $("sourceFieldsContainer");
  const annotationContainer = $("fieldsContainer");
  sourceContainer.innerHTML = "";
  annotationContainer.innerHTML = "";

  const tplFields = state.template?.fields || [];
  const rendered = new Set();
  const sourceSpecs = [];
  const annotationSpecs = [];
  for (const spec of tplFields) {
    rendered.add(spec.key);
    if (spec.key === LABELLED_FIELD || spec.hidden) continue;
    const inSource = spec.panel ? spec.panel === "source" : spec.editable === false;
    (inSource ? sourceSpecs : annotationSpecs).push(spec);
  }

  // 数据中存在但模版未收录的 key。
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
  renderFieldSpecs(sourceContainer, sourceSpecs);
  renderFieldSpecs(annotationContainer, annotationSpecs);
  if (extras.length) {
    const divider = document.createElement("div");
    divider.className = "extraDivider";
    divider.textContent = "模版之外的字段";
    annotationContainer.appendChild(divider);
    for (const k of extras) annotationContainer.appendChild(makeRenderedFieldEditor(fieldSpecFor(k)));
  }

  $("sourcePanel").classList.toggle("hidden", sourceSpecs.length === 0);
  $("annotationPanel").classList.toggle("hidden", annotationSpecs.length === 0 && extras.length === 0);
  $("workspaceSplit").classList.toggle(
    "singleColumn",
    sourceSpecs.length === 0 || (annotationSpecs.length === 0 && extras.length === 0),
  );

  renderLabelledTag();
  restoreRecordView(view);
  state.renderingView = null;
  state.rendering = false;
  checkpointWorkspace();
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

function toggleLabelled() {
  const task = state.saveQueue.catch(() => {}).then(performToggleLabelled);
  state.saveQueue = task;
  return task;
}

async function performToggleLabelled() {
  if (state.selectedIndex === null) return;
  const next = !state.currentRow[LABELLED_FIELD];
  try {
    await apiJson("PATCH", `/api/row/${state.selectedIndex}`, {
      set: { [LABELLED_FIELD]: next },
    });
    state.currentRow[LABELLED_FIELD] = next;
    if (localWorkspace.snapshot) localWorkspace.snapshot.rows[state.selectedIndex][LABELLED_FIELD] = next;
    checkpointWorkspace();
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

function selectRow(index) {
  if (state.uploading) return Promise.resolve();
  const task = state.navigationQueue.catch(() => {}).then(() => performSelectRow(index));
  state.navigationQueue = task;
  return task;
}

async function performSelectRow(index) {
  if (index === state.selectedIndex) return;
  const detail = $('detail');
  const wasInert = detail?.inert;
  if (detail) detail.inert = true;
  state.navigating = true;
  try {
    if (state.selectedIndex !== null) {
      if (!await applyCurrent({ silent: true, navigating: true })) return;
      state.rowViews[state.selectedIndex] = captureRecordView();
    }
    // Fetch before changing the selected index. A slow/failing request must not
    // leave the previous record's form associated with a different row index.
    const d = await apiGet(`/api/row/${index}`);
    const view = state.rowViews[index];
    state.selectedIndex = index;
    state.repeatableSteps = view?.repeatableSteps || {};
    state.deletedKeys = new Set(view?.deletedKeys || []);
    state.extraKeys = view?.extraKeys || [];
    state.currentRow = d.row;
    $("detailEmpty").classList.add("hidden");
    $("detail").classList.remove("hidden");
    $("detailTitle").textContent = `标注工作区 — #${index + 1}`;
    $("applyMsg").textContent = "";
    showAnnotateView();
    renderDetail(view || null);
    updateRowNav();
    await refreshList();
  } finally {
    state.navigating = false;
    if (detail) detail.inert = wasInert;
  }
}

async function gotoRow(delta) {
  if (state.selectedIndex === null) return;
  const target = state.selectedIndex + delta;
  if (target < 0 || target >= state.datasetTotal) return;
  await selectRow(target);
}

// ---------------------------------------------------------------------------
// 收集编辑结果并保存
// ---------------------------------------------------------------------------

function collectChanges() {
  const row = state.currentRow;
  const sets = {};
  const errors = [];
  const inputs = document.querySelectorAll("#fieldsContainer .fieldInput, #sourceFieldsContainer .fieldInput");
  for (const input of inputs) {
    const key = input.dataset.key;
    if (input.disabled || state.deletedKeys.has(key)) continue;
    const widget = input.dataset.widget;
    if (input.dataset.validationError) {
      errors.push(`${key}: ${input.dataset.validationError}`);
      continue;
    }
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
    } else if (widget === "json" || widget === "repeatable") {
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
      (widget === "repeatable" && (old === undefined || old === null) && Array.isArray(v) && v.length === 0) ||
      (old === undefined && (v === "" || v === null)) ||
      JSON.stringify(old) === JSON.stringify(v);
    if (!same) sets[key] = v;
  }
  const deletes = [...state.deletedKeys].filter((k) => hasByPath(row, k));
  return { sets, deletes, errors };
}

function applyCurrent(options = {}) {
  const task = state.saveQueue.catch(() => {}).then(() => performApplyCurrent(options));
  state.saveQueue = task;
  return task;
}

async function performApplyCurrent({ silent = false, navigating = false } = {}) {
  if (state.uploading) return false;
  if (state.navigating && !navigating) return false;
  if (state.selectedIndex === null) return true;
  const { sets, deletes, errors } = collectChanges();
  const submitted = new Map([...document.querySelectorAll('.fieldInput')].map(input =>
    [input.dataset.key, { value: input.value, checked: String(input.checked) }]));
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
    for (const input of document.querySelectorAll('.fieldInput')) {
      if (!Object.hasOwn(sets, input.dataset.key)) continue;
      input.dataset.renderedValue = submitted.get(input.dataset.key).value;
      input.dataset.renderedChecked = submitted.get(input.dataset.key).checked;
    }
    for (const [k, v] of Object.entries(r.collection_backups || {})) setByPath(state.currentRow, k, v);
    for (const k of deletes) deleteByPath(state.currentRow, k);
    for (const key of deletes) {
      if (!state.deletedKeys.has(key)) continue;
      state.deletedKeys.delete(key);
      for (const field of document.querySelectorAll('#fieldsContainer .field, #sourceFieldsContainer .field')) {
        if (field.dataset.key === key) field.remove();
      }
    }
    state.extraKeys = state.extraKeys.filter((k) => hasByPath(state.currentRow, k));
    if (r.item) state.currentRow[LABELLED_FIELD] = Boolean(r.item.dirty);
    // Saving never rebuilds editors: preserve focus, drafts and presentation.
    renderLabelledTag();
    if (localWorkspace.snapshot) {
      localWorkspace.snapshot.rows[state.selectedIndex] = structuredClone(state.currentRow);
      checkpointWorkspace();
      await localWorkspace.flush();
    }
    if (r.auto_saved_path) {
      $("applyMsg").textContent = `已保存并自动写入 ${r.auto_saved_path}`;
      if (!silent) toast("已保存并写盘");
    } else {
      $("applyMsg").textContent = '已更新临时工作区；浏览器草稿独立保留，完成后请下载结果';
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
  checkpointWorkspace();
  if (state.template?.save_mode !== "auto") return;
  state.lastInputAt = Date.now();
  window.clearTimeout(state.autoSaveTimer);
  state.autoSaveTimer = window.setTimeout(autoSaveIfIdle, AUTOSAVE_IDLE_MS);
}

function autoSaveIfIdle() {
  if (state.navigating || state.uploading) return;
  if (state.template?.save_mode !== "auto") return;
  if (state.selectedIndex === null) return;
  if (document.querySelector(".collectionEditInput")) return;
  if (Date.now() - state.lastInputAt < AUTOSAVE_IDLE_MS - 100) return; // 仍在输入
  applyCurrent({ silent: true });
}

function startAutoSaveLoop() {
  window.setInterval(() => {
    if (state.navigating || state.uploading) return;
    if (state.template?.save_mode !== "auto") return;
    if (state.selectedIndex === null) return;
    if (document.querySelector(".collectionEditInput")) return;
    // 用户正在输入时跳过本次周期保存，停止输入后由空闲判定接手
    if (Date.now() - state.lastInputAt < AUTOSAVE_IDLE_MS) return;
    applyCurrent({ silent: true });
  }, AUTOSAVE_INTERVAL_MS);
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
    $("tplLibraryHint").textContent = "上传模版或保存当前模版后，会出现在这里。";
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

const REPEATABLE_CONFIG_KEYS = [
  "item_name", "add_label", "empty_text", "item_id_field", "item_id_prefix",
  "item_id_padding", "order_field", "item_title_field", "track_order", "sortable", "steps", "item_fields",
];
const REPEATABLE_ITEM_WIDGETS = [
  "text", "textarea", "number", "checkbox", "select", "multiselect",
  "self_multiselect", "cascader", "checkbox_group", "text_list",
];

function repeatableConfigFromField(field) {
  const config = {};
  for (const key of REPEATABLE_CONFIG_KEYS) {
    if (field[key] !== undefined) config[key] = field[key];
  }
  if (Array.isArray(config.item_fields)) {
    config.item_fields = config.item_fields.map((item) => {
      const copy = { ...item };
      if (copy.options_source) delete copy.options;
      return copy;
    });
  }
  return config;
}

function applyRepeatableConfig(field, config) {
  for (const key of REPEATABLE_CONFIG_KEYS) delete field[key];
  Object.assign(field, config);
}

let repeatableConfigContext = null;

function repeatableConfigControl(labelText, control, wide = false) {
  const label = document.createElement("label");
  label.className = "repeatableConfigControl" + (wide ? " wide" : "");
  const title = document.createElement("span");
  title.textContent = labelText;
  label.append(title, control);
  return label;
}

function repeatableTextControl(label, value, onChange, { wide = false, rows = 0, type = "text", placeholder = "" } = {}) {
  const input = rows ? document.createElement("textarea") : document.createElement("input");
  if (!rows) input.type = type;
  if (rows) input.rows = rows;
  input.value = value ?? "";
  input.placeholder = placeholder;
  input.addEventListener("input", () => onChange(input.value));
  return repeatableConfigControl(label, input, wide);
}

function repeatableSelectControl(label, value, options, onChange, wide = false) {
  const select = document.createElement("select");
  for (const [optionValue, optionLabel] of options) {
    const option = document.createElement("option");
    option.value = optionValue;
    option.textContent = optionLabel;
    select.appendChild(option);
  }
  select.value = value ?? "";
  select.addEventListener("change", () => onChange(select.value));
  return repeatableConfigControl(label, select, wide);
}

function repeatableCheck(label, checked, onChange) {
  const wrap = document.createElement("label");
  wrap.className = "repeatableConfigCheck";
  const input = document.createElement("input");
  input.type = "checkbox";
  input.checked = Boolean(checked);
  input.addEventListener("change", () => onChange(input.checked));
  const text = document.createElement("span");
  text.textContent = label;
  wrap.append(input, text);
  return wrap;
}

function moveConfigItem(list, index, delta) {
  const target = index + delta;
  if (target < 0 || target >= list.length) return;
  [list[index], list[target]] = [list[target], list[index]];
}

function configSection(titleText, addLabel = "", onAdd = null) {
  const section = document.createElement("section");
  section.className = "repeatableConfigSection";
  const head = document.createElement("div");
  head.className = "repeatableConfigSectionHead";
  const title = document.createElement("div");
  title.className = "repeatableConfigSectionTitle";
  title.textContent = titleText;
  head.appendChild(title);
  if (onAdd) {
    const add = document.createElement("button");
    add.type = "button";
    add.textContent = addLabel;
    add.addEventListener("click", onAdd);
    head.appendChild(add);
  }
  section.appendChild(head);
  return section;
}

function updateRepeatableKeyReferences(config, oldKey, newKey) {
  if (oldKey === newKey) return;
  for (const step of config.steps || []) {
    step.fields = (step.fields || []).map((key) => key === oldKey ? newKey : key);
    for (const section of step.sections || []) {
      section.fields = (section.fields || []).map((key) => key === oldKey ? newKey : key);
    }
    if (step.field_overrides?.[oldKey]) {
      step.field_overrides[newKey] = step.field_overrides[oldKey];
      delete step.field_overrides[oldKey];
    }
    for (const override of Object.values(step.field_overrides || {})) {
      if (override.show_results) override.show_results = override.show_results.map((key) => key === oldKey ? newKey : key);
    }
    if (step.relation_field === oldKey) step.relation_field = newKey;
    if (step.group_by_relation === oldKey) step.group_by_relation = newKey;
  }
  if (config.item_title_field === oldKey) config.item_title_field = newKey;
}

function renderRepeatableStepFields(container, step, itemFields) {
  const title = document.createElement("div");
  title.className = "repeatableStepFieldsTitle";
  title.textContent = "本步骤显示的子字段（可调整顺序）";
  container.appendChild(title);
  const keys = itemFields.map((field) => field.key).filter(Boolean);
  step.fields = (step.fields || []).filter((key) => keys.includes(key));
  for (const [index, key] of step.fields.entries()) {
    const row = document.createElement("div");
    row.className = "repeatableStepFieldRow";
    const checkbox = document.createElement("input");
    checkbox.type = "checkbox";
    checkbox.checked = true;
    checkbox.addEventListener("change", () => {
      step.fields.splice(index, 1);
      renderRepeatableConfigDialog();
    });
    const name = document.createElement("span");
    name.className = "fieldName";
    name.textContent = itemFields.find((field) => field.key === key)?.label || key;
    const up = document.createElement("button");
    up.type = "button";
    up.textContent = "上移";
    up.disabled = index === 0;
    up.addEventListener("click", () => { moveConfigItem(step.fields, index, -1); renderRepeatableConfigDialog(); });
    const down = document.createElement("button");
    down.type = "button";
    down.textContent = "下移";
    down.disabled = index === step.fields.length - 1;
    down.addEventListener("click", () => { moveConfigItem(step.fields, index, 1); renderRepeatableConfigDialog(); });
    row.append(checkbox, name, up, down);
    container.appendChild(row);
  }
  for (const key of keys.filter((key) => !step.fields.includes(key))) {
    const row = document.createElement("div");
    row.className = "repeatableStepFieldRow";
    const checkbox = document.createElement("input");
    checkbox.type = "checkbox";
    checkbox.addEventListener("change", () => {
      step.fields.push(key);
      renderRepeatableConfigDialog();
    });
    const name = document.createElement("span");
    name.className = "fieldName";
    name.textContent = itemFields.find((field) => field.key === key)?.label || key;
    row.append(checkbox, name);
    container.appendChild(row);
  }
}

function renderRepeatableStepLayout(container, step, itemFields) {
  const layout = document.createElement("div");
  layout.className = "repeatableLayoutConfig";
  const title = document.createElement("strong");
  title.className = "repeatableStepFieldsTitle";
  title.textContent = "卡片分区";
  layout.appendChild(title);
  const sections = step.sections || [];
  sections.forEach((section, index) => {
    const row = document.createElement("div");
    row.className = "repeatableSectionConfigRow";
    const name = document.createElement("input");
    name.value = section.label;
    name.placeholder = "分区名称";
    name.setAttribute("aria-label", `分区 ${index + 1} 名称`);
    name.addEventListener("input", () => { section.label = name.value; });
    row.appendChild(name);
    for (const [label, delta] of [["上移", -1], ["下移", 1]]) {
      const button = document.createElement("button");
      button.type = "button";
      button.textContent = label;
      button.disabled = index + delta < 0 || index + delta >= sections.length;
      button.addEventListener("click", () => { moveConfigItem(sections, index, delta); renderRepeatableConfigDialog(); });
      row.appendChild(button);
    }
    const remove = document.createElement("button");
    remove.type = "button";
    remove.className = "dangerText";
    remove.textContent = "删除分区";
    remove.addEventListener("click", () => {
      sections.splice(index, 1);
      if (!sections.length) delete step.sections;
      renderRepeatableConfigDialog();
    });
    row.appendChild(remove);
    layout.appendChild(row);
  });
  const add = document.createElement("button");
  add.type = "button";
  add.textContent = "+ 添加分区";
  add.className = "repeatableTextListAdd";
  add.addEventListener("click", () => {
    step.sections ||= [];
    step.sections.push({ label: `分区 ${step.sections.length + 1}`, fields: [] });
    renderRepeatableConfigDialog();
  });
  layout.appendChild(add);
  if (sections.length) {
    for (const key of step.fields || []) {
      const field = itemFields.find((candidate) => candidate.key === key);
      if (!field) continue;
      const current = sections.findIndex((section) => (section.fields || []).includes(key));
      layout.appendChild(repeatableSelectControl(
        `${field.label || key} · 所在分区`, String(current),
        [["-1", "未分区（显示在末尾）"], ...sections.map((section, index) => [String(index), section.label || `分区 ${index + 1}`])],
        (value) => {
          sections.forEach((section) => { section.fields = (section.fields || []).filter((candidate) => candidate !== key); });
          if (Number(value) >= 0) sections[Number(value)].fields.push(key);
        },
      ));
    }
  }
  const help = document.createElement("div");
  help.className = "tplHint";
  help.textContent = "分区内字段顺序遵循上方的子字段顺序；删除分区会保留字段。";
  layout.appendChild(help);
  container.appendChild(layout);

  const overrides = document.createElement("div");
  overrides.className = "repeatableLayoutConfig";
  const overrideTitle = document.createElement("strong");
  overrideTitle.className = "repeatableStepFieldsTitle";
  overrideTitle.textContent = "本步骤字段展示与关联结果";
  overrides.appendChild(overrideTitle);
  for (const key of step.fields || []) {
    const field = itemFields.find((candidate) => candidate.key === key);
    if (!field) continue;
    const getOverride = () => {
      step.field_overrides ||= {};
      return step.field_overrides[key] ||= {};
    };
    const current = step.field_overrides?.[key] || {};
    const details = document.createElement("details");
    details.className = "repeatableFieldOverride";
    const summary = document.createElement("summary");
    summary.textContent = field.label || key;
    const grid = document.createElement("div");
    grid.className = "repeatableConfigGrid";
    for (const [property, label] of [["label", "本步骤显示名"], ["hint", "本步骤提示"]]) {
      grid.appendChild(repeatableTextControl(label, current[property] ?? "", (value) => {
        if (value) getOverride()[property] = value;
        else if (step.field_overrides?.[key]) delete step.field_overrides[key][property];
      }, { placeholder: field[property] || "沿用子字段设置" }));
    }
    for (const [property, label] of [["editable", "编辑方式"], ["wide", "字段宽度"]]) {
      grid.appendChild(repeatableSelectControl(label,
        current[property] === undefined ? "inherit" : String(current[property]),
        [["inherit", "沿用子字段设置"], ["true", property === "editable" ? "可编辑" : "占满整行"], ["false", property === "editable" ? "只读" : "半行"]],
        (value) => {
          if (value === "inherit") { if (step.field_overrides?.[key]) delete step.field_overrides[key][property]; }
          else getOverride()[property] = value === "true";
        },
      ));
    }
    details.append(summary, grid);
    if (field.widget === "self_multiselect") {
      const checks = document.createElement("div");
      checks.className = "repeatableConfigChecks";
      const enabled = Array.isArray(current.show_results);
      checks.appendChild(repeatableCheck("展示关联子项的结果", enabled, (value) => {
        if (value) getOverride().show_results = [];
        else if (step.field_overrides?.[key]) delete step.field_overrides[key].show_results;
        renderRepeatableConfigDialog();
      }));
      details.appendChild(checks);
      if (enabled) {
        details.open = true;
        const resultChecks = document.createElement("div");
        resultChecks.className = "repeatableConfigChecks";
        for (const resultField of itemFields.filter((candidate) => candidate.key !== key)) {
          resultChecks.appendChild(repeatableCheck(resultField.label || resultField.key,
            current.show_results.includes(resultField.key), (value) => {
              const selected = new Set(getOverride().show_results || []);
              if (value) selected.add(resultField.key); else selected.delete(resultField.key);
              getOverride().show_results = itemFields.filter((candidate) => selected.has(candidate.key)).map((candidate) => candidate.key);
            }));
        }
        details.appendChild(resultChecks);
      }
    }
    overrides.appendChild(details);
  }
  container.appendChild(overrides);
}

function renderRepeatableConfigDialog() {
  const context = repeatableConfigContext;
  if (!context) return;
  const config = context.config;
  const body = $("repeatableConfigBody");
  body.innerHTML = "";
  $("repeatableConfigSubtitle").textContent = `字段：${context.field.label || context.field.key}`;

  const basic = configSection("基础设置");
  const basicGrid = document.createElement("div");
  basicGrid.className = "repeatableConfigGrid";
  basicGrid.append(
    repeatableTextControl("子项名称", config.item_name, (value) => { config.item_name = value; }),
    repeatableTextControl("新增按钮文字", config.add_label, (value) => { config.add_label = value; }),
    repeatableTextControl("空列表提示", config.empty_text, (value) => { config.empty_text = value; }, { wide: true }),
    repeatableSelectControl(
      "子项显示标题（卡片及关系图）",
      config.item_title_field || "",
      [["", "（自动标题）"], ...(config.item_fields || []).map((field) => [field.key, field.label || field.key])],
      (value) => { config.item_title_field = value; },
    ),
  );
  const basicChecks = document.createElement("div");
  basicChecks.className = "repeatableConfigChecks";
  basicChecks.append(repeatableCheck("记录人工顺序", config.track_order !== false, (value) => {
    config.track_order = value;
    if (!value) config.sortable = false;
    renderRepeatableConfigDialog();
  }));
  if (config.track_order !== false) {
    basicChecks.append(repeatableCheck("允许人工调整顺序", config.sortable !== false, (value) => { config.sortable = value; }));
  }
  const advanced = document.createElement("details");
  advanced.className = "repeatableConfigAdvanced";
  const advancedSummary = document.createElement("summary");
  advancedSummary.textContent = "高级标识设置（通常无需修改）";
  const advancedGrid = document.createElement("div");
  advancedGrid.className = "repeatableConfigGrid";
  advancedGrid.append(
    repeatableTextControl("ID 保存字段", config.item_id_field, (value) => { config.item_id_field = value; }),
    repeatableTextControl("自动编号前缀", config.item_id_prefix, (value) => { config.item_id_prefix = value; }),
    repeatableTextControl("编号数字位数", config.item_id_padding, (value) => { config.item_id_padding = Math.max(1, Number(value) || 1); }, { type: "number" }),
  );
  if (config.track_order !== false) {
    advancedGrid.append(repeatableTextControl("顺序保存字段", config.order_field, (value) => { config.order_field = value; }));
  }
  advanced.append(advancedSummary, advancedGrid);
  basic.append(basicGrid, basicChecks, advanced);
  body.appendChild(basic);

  const fieldsSection = configSection("子字段", "+ 添加子字段", () => {
    const used = new Set((config.item_fields || []).map((field) => field.key));
    let index = config.item_fields.length + 1;
    while (used.has(`field_${index}`)) index += 1;
    config.item_fields.push({ key: `field_${index}`, label: `子字段 ${index}`, widget: "text", rows: 1, wide: false, required: false });
    renderRepeatableConfigDialog();
  });
  const fieldList = document.createElement("div");
  fieldList.className = "repeatableConfigList";
  if (!config.item_fields.length) {
    const empty = document.createElement("div");
    empty.className = "repeatableConfigEmpty";
    empty.textContent = "至少需要一个子字段";
    fieldList.appendChild(empty);
  }
  config.item_fields.forEach((field, index) => {
    const card = document.createElement("div");
    card.className = "repeatableConfigCard";
    const head = document.createElement("div");
    head.className = "repeatableConfigCardHead";
    const title = document.createElement("div");
    title.className = "repeatableConfigCardTitle";
    title.textContent = `${index + 1}. ${field.label || field.key || "未命名子字段"}`;
    const actions = document.createElement("div");
    actions.className = "repeatableConfigCardActions";
    for (const [label, delta] of [["上移", -1], ["下移", 1]]) {
      const button = document.createElement("button");
      button.type = "button";
      button.textContent = label;
      button.disabled = index + delta < 0 || index + delta >= config.item_fields.length;
      button.addEventListener("click", () => { moveConfigItem(config.item_fields, index, delta); renderRepeatableConfigDialog(); });
      actions.appendChild(button);
    }
    const remove = document.createElement("button");
    remove.type = "button";
    remove.className = "dangerText";
    remove.textContent = "删除";
    remove.addEventListener("click", () => {
      const removedKey = field.key;
      config.item_fields.splice(index, 1);
      for (const step of config.steps || []) {
        step.fields = (step.fields || []).filter((key) => key !== removedKey);
        for (const section of step.sections || []) {
          section.fields = (section.fields || []).filter((key) => key !== removedKey);
        }
        if (step.field_overrides) delete step.field_overrides[removedKey];
        for (const override of Object.values(step.field_overrides || {})) {
          if (override.show_results) override.show_results = override.show_results.filter((key) => key !== removedKey);
        }
        if (step.relation_field === removedKey) delete step.relation_field;
        if (step.group_by_relation === removedKey) delete step.group_by_relation;
      }
      renderRepeatableConfigDialog();
    });
    actions.appendChild(remove);
    head.append(title, actions);

    const grid = document.createElement("div");
    grid.className = "repeatableConfigGrid";
    const oldKey = field.key;
    const keyControl = repeatableTextControl("key", field.key, (value) => { field.key = value.trim(); });
    keyControl.querySelector("input").addEventListener("change", () => {
      updateRepeatableKeyReferences(config, oldKey, field.key);
      renderRepeatableConfigDialog();
    });
    grid.append(
      keyControl,
      repeatableTextControl("显示名", field.label, (value) => { field.label = value; }),
      repeatableSelectControl("控件", field.widget || "text", REPEATABLE_ITEM_WIDGETS.map((widget) => [widget, widget]), (value) => {
        field.widget = value;
        renderRepeatableConfigDialog();
      }),
      repeatableTextControl("输入提示", field.hint, (value) => { field.hint = value; }),
      repeatableTextControl("占位文字", field.placeholder, (value) => { field.placeholder = value; }),
      repeatableTextControl("高度（行）", field.rows || 1, (value) => { field.rows = Math.max(1, Number(value) || 1); }, { type: "number" }),
    );
    if (field.widget === "text_list") {
      grid.appendChild(repeatableTextControl("新增条目按钮文字", field.add_label || "+ 新增信息", (value) => { field.add_label = value; }));
    }

    const optionWidgets = new Set(["select", "multiselect", "cascader", "checkbox_group"]);
    if (optionWidgets.has(field.widget)) {
      grid.append(
        repeatableTextControl("静态选项（每行一个）", (field.options || []).join("\n"), (value) => {
          field.options = value.split("\n").map((option) => option.trim()).filter(Boolean);
        }, { wide: true, rows: 5 }),
        repeatableTextControl("动态选项数据路径", field.options_from_path, (value) => {
          if (value.trim()) field.options_from_path = value.trim(); else delete field.options_from_path;
        }, { placeholder: "例如 candidates" }),
        repeatableSelectControl("对象选项模式", field.options_from_object || "keys", [["keys", "仅使用 key"], ["entries", "key + value 完整内容"]], (value) => {
          field.options_from_object = value;
          renderRepeatableConfigDialog();
        }),
        repeatableTextControl("选项搜索提示", field.search_placeholder, (value) => { field.search_placeholder = value; }),
      );
      if (field.options_from_object === "entries") {
        const separatorDisplay = (field.option_entry_separator ?? "\n") === "\n" ? "\\n" : field.option_entry_separator;
        grid.append(repeatableTextControl("key/value 分隔符", separatorDisplay, (value) => {
          field.option_entry_separator = value === "\\n" || !value ? "\n" : value;
        }, { placeholder: "默认换行" }));
      }
      const optionSource = isPlainObject(field.options_source) ? field.options_source : {};
      grid.append(
        repeatableTextControl("外部选项文件（项目内相对路径）", optionSource.path || "", (value) => {
          if (value.trim()) field.options_source = { ...optionSource, path: value.trim(), format: optionSource.format || "lines" };
          else delete field.options_source;
        }),
        repeatableSelectControl(
          "外部选项文件格式",
          optionSource.format || "lines",
          [["lines", "每行一个选项"], ["json_array", "JSON 数组"], ["numbered_tree_leaves", "编号缩进树的叶路径"]],
          (value) => {
            if (field.options_source?.path) field.options_source = { ...field.options_source, format: value };
          },
        ),
      );
    }
    if (field.widget === "cascader") {
      grid.append(
        repeatableTextControl("层级分隔符", field.delimiter || "；", (value) => { field.delimiter = value || "；"; }),
        repeatableTextControl("各级提示（每行一个）", (field.level_labels || []).join("\n"), (value) => {
          field.level_labels = value.split("\n").map((label) => label.trim()).filter(Boolean);
        }, { wide: true, rows: 3 }),
      );
    }
    if (["multiselect", "self_multiselect"].includes(field.widget)) {
      grid.append(repeatableTextControl("选择框显示行数", field.size || 5, (value) => { field.size = Math.max(2, Number(value) || 5); }, { type: "number" }));
    }
    card.append(head, grid);
    const checks = document.createElement("div");
    checks.className = "repeatableConfigChecks";
    checks.append(
      repeatableCheck("占满整行", field.wide, (value) => { field.wide = value; }),
      repeatableCheck("必填", field.required, (value) => { field.required = value; }),
      repeatableCheck("允许编辑", field.editable !== false, (value) => { field.editable = value; }),
    );
    if (field.widget === "self_multiselect") {
      checks.append(repeatableCheck("禁止循环关系", field.acyclic, (value) => { field.acyclic = value; }));
    }
    card.appendChild(checks);
    fieldList.appendChild(card);
  });
  fieldsSection.appendChild(fieldList);
  body.appendChild(fieldsSection);

  const stepsSection = configSection("流程步骤", "+ 添加步骤", () => {
    const index = config.steps.length + 1;
    config.steps.push({ id: `step_${index}`, label: `步骤 ${index}`, fields: [], view: "cards", allow_add: false, allow_delete: false, sortable: false });
    renderRepeatableConfigDialog();
  });
  const stepList = document.createElement("div");
  stepList.className = "repeatableConfigList";
  const relationOptions = [["", "（无）"], ...config.item_fields
    .filter((field) => field.widget === "self_multiselect")
    .map((field) => [field.key, field.label || field.key])];
  config.steps.forEach((step, index) => {
    const card = document.createElement("div");
    card.className = "repeatableConfigCard";
    const head = document.createElement("div");
    head.className = "repeatableConfigCardHead";
    const title = document.createElement("div");
    title.className = "repeatableConfigCardTitle";
    title.textContent = `${index + 1}. ${step.label || step.id || "未命名步骤"}`;
    const actions = document.createElement("div");
    actions.className = "repeatableConfigCardActions";
    for (const [label, delta] of [["上移", -1], ["下移", 1]]) {
      const button = document.createElement("button");
      button.type = "button";
      button.textContent = label;
      button.disabled = index + delta < 0 || index + delta >= config.steps.length;
      button.addEventListener("click", () => { moveConfigItem(config.steps, index, delta); renderRepeatableConfigDialog(); });
      actions.appendChild(button);
    }
    const remove = document.createElement("button");
    remove.type = "button";
    remove.className = "dangerText";
    remove.textContent = "删除";
    remove.addEventListener("click", () => { config.steps.splice(index, 1); renderRepeatableConfigDialog(); });
    actions.appendChild(remove);
    head.append(title, actions);
    const grid = document.createElement("div");
    grid.className = "repeatableConfigGrid";
    grid.append(
      repeatableTextControl("步骤 ID", step.id, (value) => { step.id = value.trim(); }),
      repeatableTextControl("步骤名称", step.label, (value) => { step.label = value; }),
      repeatableSelectControl("展示方式", step.view || "cards", [["cards", "卡片列表"], ["graph", "可拖拽点边图"]], (value) => {
        step.view = value;
        renderRepeatableConfigDialog();
      }),
      repeatableSelectControl("关系字段", step.relation_field || "", relationOptions, (value) => {
        if (value) step.relation_field = value; else delete step.relation_field;
      }),
      repeatableSelectControl("按关系分组", step.group_by_relation || "", relationOptions, (value) => {
        if (value) step.group_by_relation = value; else delete step.group_by_relation;
        renderRepeatableConfigDialog();
      }),
    );
    if (step.group_by_relation) {
      grid.append(
        repeatableTextControl("关联组名称", step.group_label || "关联组", (value) => { step.group_label = value; }),
        repeatableTextControl("独立项名称", step.single_label || "独立项", (value) => { step.single_label = value; }),
      );
    }
    const stepFields = document.createElement("div");
    stepFields.className = "repeatableStepFields";
    renderRepeatableStepFields(stepFields, step, config.item_fields);
    grid.appendChild(stepFields);
    if (step.view !== "graph") renderRepeatableStepLayout(grid, step, config.item_fields);
    card.append(head, grid);
    const checks = document.createElement("div");
    checks.className = "repeatableConfigChecks";
    checks.append(
      repeatableCheck("允许新增子项", step.allow_add !== false, (value) => { step.allow_add = value; }),
      repeatableCheck("允许删除子项", step.allow_delete !== false, (value) => { step.allow_delete = value; }),
    );
    if (config.track_order !== false) {
      checks.append(repeatableCheck("允许调整顺序", step.sortable !== false, (value) => { step.sortable = value; }));
    }
    card.appendChild(checks);
    stepList.appendChild(card);
  });
  if (!config.steps.length) {
    const empty = document.createElement("div");
    empty.className = "repeatableConfigEmpty";
    empty.textContent = "未设置步骤时，标注区会一次显示全部子字段。";
    stepList.appendChild(empty);
  }
  stepsSection.appendChild(stepList);
  body.appendChild(stepsSection);
}

function validateRepeatableConfig(config) {
  if (!Array.isArray(config.item_fields) || !config.item_fields.length) return "至少添加一个子字段";
  const keys = config.item_fields.map((field) => (field.key || "").trim());
  if (keys.some((key) => !key)) return "子字段 key 不能为空";
  if (new Set(keys).size !== keys.length) return "子字段 key 不能重复";
  const stepIds = (config.steps || []).map((step) => (step.id || "").trim());
  if (stepIds.some((id) => !id)) return "步骤 ID 不能为空";
  if (new Set(stepIds).size !== stepIds.length) return "步骤 ID 不能重复";
  const relations = new Set(config.item_fields.filter((field) => field.widget === "self_multiselect").map((field) => field.key));
  for (const step of config.steps || []) {
    if ((step.fields || []).some((key) => !keys.includes(key))) return `步骤“${step.label || step.id}”包含未知字段`;
    const placed = new Set();
    for (const section of step.sections || []) {
      if (!section.label?.trim()) return `步骤“${step.label || step.id}”的分区名称不能为空`;
      for (const key of section.fields || []) {
        if (!keys.includes(key) || placed.has(key)) return `步骤“${step.label || step.id}”的分区包含未知或重复字段`;
        placed.add(key);
      }
    }
    for (const [key, override] of Object.entries(step.field_overrides || {})) {
      if (!keys.includes(key)) return `步骤“${step.label || step.id}”的展示设置包含未知字段`;
      if (override.show_results && (!relations.has(key) || override.show_results.some((resultKey) => !keys.includes(resultKey)))) {
        return `步骤“${step.label || step.id}”的关联结果设置无效`;
      }
    }
    if (step.view === "graph" && !relations.has(step.relation_field)) return `步骤“${step.label || step.id}”需要选择关系字段`;
    if (step.group_by_relation && !relations.has(step.group_by_relation)) return `步骤“${step.label || step.id}”的分组字段无效`;
  }
  return "";
}

function openRepeatableConfigEditor(field) {
  const config = JSON.parse(JSON.stringify(repeatableConfigFromField(field)));
  config.item_name ||= "子项";
  config.item_id_field ||= "id";
  config.item_id_prefix ||= "I";
  config.item_id_padding ||= 2;
  config.order_field ||= "order";
  config.track_order = config.track_order !== false;
  config.sortable = config.sortable !== false;
  config.item_fields = Array.isArray(config.item_fields) ? config.item_fields : [];
  config.steps = Array.isArray(config.steps) ? config.steps : [];
  repeatableConfigContext = { field, config };
  renderRepeatableConfigDialog();
  const dialog = $("repeatableConfigDialog");
  const close = () => { repeatableConfigContext = null; dialog.close(); };
  $("repeatableConfigClose").onclick = close;
  $("repeatableConfigCancel").onclick = close;
  dialog.oncancel = (event) => { event.preventDefault(); close(); };
  $("repeatableConfigApply").onclick = () => {
    const error = validateRepeatableConfig(config);
    if (error) {
      toast(error, "err", 3500);
      return;
    }
    applyRepeatableConfig(field, config);
    repeatableConfigContext = null;
    dialog.close();
    renderTemplateEditor();
    toast("可重复子项配置已应用；保存模版后生效", "ok", 3000);
  };
  dialog.showModal();
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
    if (f.widget === "repeatable" && !Array.isArray(f.item_fields)) {
      Object.assign(f, {
        item_name: "子项",
        item_id_field: "id",
        item_id_prefix: "I",
        item_id_padding: 2,
        order_field: "order",
        track_order: true,
        sortable: true,
        item_fields: [{ key: "value", label: "内容", widget: "textarea", rows: 4, wide: true }],
      });
    }
    renderTemplateEditor();
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

  let options;
  if (f.widget === "repeatable") {
    options = document.createElement("button");
    options.type = "button";
    options.className = "repeatableConfigBtn";
    options.textContent = `配置子项与流程（${(f.item_fields || []).length} 个子字段）`;
    options.title = "打开可视化配置器";
    options.addEventListener("click", () => openRepeatableConfigEditor(f));
  } else {
    options = document.createElement("textarea");
    options.rows = 2;
    options.value = (f.options || []).join("\n");
    options.disabled = f.widget !== "select";
    options.title = "select 控件的选项，每行一个";
    options.addEventListener("change", () => {
      f.options = options.value.split("\n").map((s) => s.trim()).filter(Boolean);
    });
  }

  const editable = document.createElement("input");
  editable.type = "checkbox";
  editable.checked = f.editable !== false;
  editable.addEventListener("change", () => { f.editable = editable.checked; });

  const panel = document.createElement("select");
  panel.className = "tplPanelSelect";
  panel.setAttribute("aria-label", `${f.label || f.key}的显示区域`);
  panel.title = "自动分区：只读字段放资料区，可编辑字段放标注区；也可单独指定位置，不改变编辑权限";
  for (const [value, text] of [["", "自动分区"], ["source", "资料区"], ["annotation", "标注区"]]) {
    const option = document.createElement("option");
    option.value = value;
    option.textContent = text;
    panel.appendChild(option);
  }
  panel.value = f.panel || "";
  panel.addEventListener("change", () => {
    if (panel.value) f.panel = panel.value;
    else delete f.panel;
  });

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

  const segmentation = document.createElement('label');
  segmentation.className = 'segmentDisplaySetting';
  const segmentCheck = document.createElement('input');
  segmentCheck.type = 'checkbox';
  segmentCheck.checked = Boolean(f.segment_display);
  segmentCheck.disabled = !['text', 'textarea', 'collection_cards'].includes(f.widget);
  segmentCheck.addEventListener('change', () => { f.segment_display = segmentCheck.checked; });
  const segmentLabel = document.createElement('span');
  segmentLabel.textContent = '编号分段';
  segmentation.title = '仅分段展示连续编号的文本，不改变原文、保存值或导出格式；卡片集合应用于其文本子字段';
  segmentation.append(segmentCheck, segmentLabel);
  // Keep the existing template grid columns: group the display option with hint.
  const hintSettings = document.createElement('div');
  hintSettings.append(hint, segmentation);

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
  row.appendChild(hintSettings);
  row.appendChild(widget);
  row.appendChild(rows);
  row.appendChild(options);
  row.appendChild(wrapCenter(editable));
  row.appendChild(panel);
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
  for (const el of [key, label, hint, widget, rows, options, panel, group]) {
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
    .filter((f) => ["text", "textarea", "select", "repeatable"].includes(f.widget))
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

async function uploadTemplateFile(file) {
  if (!file) return;
  const form = new FormData();
  form.append("file", file);
  $("tplUploadBtn").disabled = true;
  try {
    const response = await localWorkspace.request("/api/template/upload", { method: "POST", body: form });
    const payload = await response.json().catch(async () => ({ error: await response.text() }));
    if (!response.ok) throw new Error(payload.error || "上传失败");
    state.template = payload.template;
    if (localWorkspace.snapshot) await localWorkspace.loadSnapshot();
    state.tplDraft = JSON.parse(JSON.stringify(payload.template));
    state.dataFilters = {};
    renderTemplateEditor();
    renderDataFilters();
    updateInferVisibility();
    await refreshMeta();
    await refreshTemplateLibrary();
    await refreshList();
    if (state.selectedIndex !== null) renderDetail();
    toast(`模版已上传并套用：${payload.name}`, "ok", 3500);
  } catch (e) {
    toast("上传模版失败：" + (e?.message ?? String(e)), "err", 5000);
  } finally {
    $("tplUploadBtn").disabled = false;
    $("tplUploadFile").value = "";
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
  $("uploadBtn").addEventListener("click", async () => {
    const file = $("datasetFile").files?.[0];
    if (!file) return toast("请先选择数据文件", "err");
    $("uploadBtn").disabled = true;
    state.uploading = true;
    const wasInert = $('shell').inert;
    $('shell').inert = true;
    try {
      await state.navigationQueue.catch(() => {});
      await state.saveQueue.catch(() => {});
      await localWorkspace.upload(file);
      state.selectedIndex = null;
      state.currentRow = null;
      state.rowViews = {};
      state.offset = 0;
      state.q = '';
      state.filterChanged = 'any';
      state.dataFilters = {};
      localWorkspace.capture = null;
      $('detail').classList.add('hidden');
      $('detailEmpty').classList.remove('hidden');
      await loadWorkspaceUI();
      toast('数据已上传；当前标签页独立标注');
    } catch (e) {
      toast("上传失败：" + (e?.message ?? String(e)), "err", 5000);
    } finally {
      state.uploading = false;
      $('shell').inert = wasInert;
      $("uploadBtn").disabled = false;
    }
  });
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
    // Freeze interaction only for the final export so it includes the latest
    // navigation/save, with no new edits arriving between PATCH and download.
    const controls = ['uploadBtn', 'templateBtn', 'saveModeSel'].map($);
    const disabled = controls.map(control => control.disabled);
    const wasInert = $('shell').inert;
    $('shell').inert = true;
    controls.forEach(control => { control.disabled = true; });
    try {
      await state.navigationQueue.catch(() => {});
      if (!await applyCurrent({ silent: true })) return;
      const response = await localWorkspace.request("/api/save", { method: "POST" });
      if (!response.ok) throw new Error(await response.text());
      const blob = await response.blob();
      const disposition = response.headers.get("Content-Disposition") || "";
      const match = disposition.match(/filename\*?=(?:UTF-8'')?[\"']?([^\"';]+)/i);
      const filename = match ? decodeURIComponent(match[1]) : "annotations.json";
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement("a");
      anchor.href = url;
      anchor.download = filename;
      anchor.click();
      URL.revokeObjectURL(url);
      toast("结果文件已下载", "ok", 3500);
      await refreshMeta();
    } catch (e) {
      toast("写入失败：" + (e?.message ?? String(e)), "err", 4000);
    } finally {
      $('shell').inert = wasInert;
      controls.forEach((control, i) => { control.disabled = disabled[i]; });
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
  $("tplUploadBtn").addEventListener("click", () => $("tplUploadFile").click());
  $("tplUploadFile").addEventListener("change", () => uploadTemplateFile($("tplUploadFile").files?.[0]));
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
  localWorkspace.onStatus = (message, error = false) => {
    $("backupStatus").textContent = message;
    $("backupStatus").classList.toggle('backupError', error);
  };
  await localWorkspace.initialize();
  wire();
  for (const event of ['input', 'change', 'toggle', 'pointerup', 'click']) {
    document.addEventListener(event, () => queueMicrotask(checkpointWorkspace), true);
  }
  document.addEventListener('scroll', checkpointWorkspace, true);
  window.addEventListener('pagehide', () => { checkpointWorkspace(); localWorkspace.flush(); });
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') { checkpointWorkspace(); localWorkspace.flush(); }
  });
  let collapsed = false;
  try {
    collapsed = localStorage.getItem(SIDEBAR_COLLAPSED_KEY) === "1";
  } catch {}
  setSidebarCollapsed(collapsed);

  await loadWorkspaceUI();
  startAutoSaveLoop();
}

async function loadWorkspaceUI() {
  const status = await apiGet("/api/status");
  if (!status.ready) {
    if (localWorkspace.snapshot) await localWorkspace.restore();
    else {
      $("metaLine").textContent = "请选择本地 JSON / JSONL / Excel 文件并点击“上传数据”";
      toast("请先上传待标注文件", "ok", 4000);
      return;
    }
  }
  if (!localWorkspace.snapshot) {
    await localWorkspace.loadSnapshot();
  }
  const ui = localWorkspace.snapshot.ui;
  if (ui) {
    for (const key of ['rowViews', 'q', 'offset', 'limit', 'filterChanged', 'dataFilters']) state[key] = ui[key] ?? state[key];
  }
  $('q').value = state.q;
  $('filterChanged').value = state.filterChanged;
  $('pageSize').value = String(state.limit);
  state.template = await apiGet("/api/template");
  await refreshTemplateLibrary();
  await loadInferConfigs();
  renderDataFilters();
  updateInferVisibility();
  await refreshMeta();
  await refreshList();
  localWorkspace.capture = captureWorkspaceView;
  if (ui?.selectedIndex !== null && Number.isInteger(ui?.selectedIndex) && ui.selectedIndex < state.datasetTotal) {
    await selectRow(ui.selectedIndex);
  }
}

main().catch((e) => toast("初始化失败：" + (e?.message ?? String(e)), "err", 5000));
