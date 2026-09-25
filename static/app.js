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

function repeatableWarnings(items, spec, visibleKeys = null) {
  const idField = spec.item_id_field || "id";
  const ids = new Set(items.map((item) => item[idField]));
  const warnings = [];
  for (const item of items) {
    const itemId = item[idField];
    for (const field of spec.item_fields || []) {
      if (visibleKeys && !visibleKeys.has(field.key)) continue;
      const value = item[field.key];
      if (field.required && (value === "" || value === null || value === undefined || (Array.isArray(value) && !value.length))) {
        warnings.push(`${itemId} 缺少必填项“${field.label || field.key}”`);
      }
      if (field.widget === "cascader" && value && !optionsForRepeatableField(field).includes(String(value))) {
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
  let activeStepIndex = 0;
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
    count.textContent = `已添加 ${items.length} 个${itemName}`;
    updateWarning();
    scheduleAutoSave();
  }

  function makeItemInput(item, field) {
    const widget = field.widget || "text";
    let control;
    if (widget === "textarea") {
      control = document.createElement("textarea");
      control.rows = field.rows || 4;
      control.value = item[field.key] || "";
      control.placeholder = field.placeholder || "";
      control.addEventListener("input", () => { item[field.key] = control.value; sync(); });
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
      let selectedParts = item[field.key] ? String(item[field.key]).split(delimiter) : [];
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
            item[field.key] = selectedParts.join(delimiter);
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
        const current = item[field.key] || "";
        if (current && !options.includes(String(current))) options.unshift(String(current));
        for (const value of options) {
          const option = document.createElement("option");
          option.value = value;
          option.textContent = value;
          control.appendChild(option);
        }
        control.value = current;
        control.addEventListener("change", () => { item[field.key] = control.value; sync(); });
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
    for (const key of step.fields || []) {
      const field = fieldsByKey.get(key);
      if (field) grid.appendChild(makeRepeatableControl(field, makeItemInput(item, field)));
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
    const step = steps[activeStepIndex];
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
  render();
  return editor;
}

function makeCollectionCards(spec, value) {
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
      const label = document.createElement("div");
      label.className = "collectionCardFieldLabel";
      label.textContent = field.label || field.key;
      const content = document.createElement("div");
      content.className = "collectionCardFieldValue";
      content.textContent = typeof fieldValue === "string"
        ? fieldValue
        : JSON.stringify(fieldValue, null, 2);
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
  } else if (spec.key !== LABELLED_FIELD && spec.widget !== "repeatable") {
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
  if (spec.collapsible) {
    const details = document.createElement("details");
    details.className = "sourceDetails";
    details.open = !spec.collapsed;
    const summary = document.createElement("summary");
    summary.textContent = details.open ? "收起内容" : "展开内容";
    details.addEventListener("toggle", () => {
      summary.textContent = details.open ? "收起内容" : "展开内容";
    });
    details.append(summary, input);
    wrap.appendChild(details);
  } else {
    wrap.appendChild(input);
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
  const el = makeFieldEditor(spec, getByPath(state.currentRow, spec.key));
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

function renderDetail() {
  const row = state.currentRow;
  if (row === null) return;
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
    (spec.editable === false ? sourceSpecs : annotationSpecs).push(spec);
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
    if (widget === "repeatable" && input.dataset.validationError) {
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
    const typing = document.activeElement?.classList?.contains("fieldInput") ||
      Boolean(document.activeElement?.closest?.(".repeatableEditor"));
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
  "self_multiselect", "cascader", "checkbox_group",
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
  for (const step of config.steps || []) {
    step.fields = (step.fields || []).map((key) => key === oldKey ? newKey : key);
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

    const optionWidgets = new Set(["select", "multiselect", "cascader", "checkbox_group"]);
    if (optionWidgets.has(field.widget)) {
      grid.append(
        repeatableTextControl("静态选项（每行一个）", (field.options || []).join("\n"), (value) => {
          field.options = value.split("\n").map((option) => option.trim()).filter(Boolean);
        }, { wide: true, rows: 5 }),
        repeatableTextControl("动态选项数据路径", field.options_from_path, (value) => {
          if (value.trim()) field.options_from_path = value.trim(); else delete field.options_from_path;
        }, { placeholder: "例如 laws" }),
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
    const response = await fetch("/api/template/upload", { method: "POST", body: form });
    const payload = await response.json().catch(async () => ({ error: await response.text() }));
    if (!response.ok) throw new Error(payload.error || "上传失败");
    state.template = payload.template;
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
    const form = new FormData();
    form.append("file", file);
    $("uploadBtn").disabled = true;
    try {
      const response = await fetch("/api/upload", { method: "POST", body: form });
      if (!response.ok) throw new Error(await response.text());
      window.location.reload();
    } catch (e) {
      toast("上传失败：" + (e?.message ?? String(e)), "err", 5000);
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
    try {
      const response = await fetch("/api/save", { method: "POST" });
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
  wire();
  let collapsed = false;
  try {
    collapsed = localStorage.getItem(SIDEBAR_COLLAPSED_KEY) === "1";
  } catch {}
  setSidebarCollapsed(collapsed);

  const status = await apiGet("/api/status");
  if (!status.ready) {
    $("metaLine").textContent = "请选择本地 JSON / JSONL / Excel 文件并点击“上传数据”";
    toast("请先上传待标注文件", "ok", 4000);
    return;
  }
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
