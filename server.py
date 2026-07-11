from __future__ import annotations

import json
import os
import re
import shutil
import sys
import time
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Dict, List, Optional, Set

from flask import Flask, jsonify, request, send_from_directory


APP_DIR = Path(__file__).resolve().parent
OUTPUT_DIR = APP_DIR / "output"
TEMPLATE_DIR = APP_DIR / "annotation_templates"

# 字段类型推断阈值
ENUM_MAX_DISTINCT = 12       # 不同取值数 <= 该值 且为短字符串 -> select
ENUM_MAX_LEN = 40            # 枚举候选值的最大长度
LONG_TEXT_MIN_LEN = 120      # 超过该长度（或含换行）的字符串 -> textarea

WIDGETS = {"text", "textarea", "number", "checkbox", "select", "json"}
LABELLED_FIELD = "is_labelled"


# ---------------------------------------------------------------------------
# 数据集
# ---------------------------------------------------------------------------

@dataclass
class Dataset:
    path: Path            # 原始数据文件
    fmt: str              # "jsonl" | "json"
    rows: List[Dict[str, Any]]
    loaded_at_ms: int
    dirty_rows: Set[int] = field(default_factory=set)  # 本次会话中被修改过的行
    working_path: Optional[Path] = None  # 当前选中的 output 存档


def _now_ms() -> int:
    return int(time.time() * 1000)


def normalize_labelled(value: Any) -> bool:
    if isinstance(value, bool):
        return value
    if isinstance(value, (int, float)) and not isinstance(value, bool):
        return value != 0
    if isinstance(value, str):
        return value.strip().lower() in {"1", "true", "yes", "y", "labelled", "labeled", "已标注"}
    return False


def init_label_state(rows: List[Dict[str, Any]]) -> Set[int]:
    labelled: Set[int] = set()
    for i, row in enumerate(rows):
        is_labelled = normalize_labelled(row.get(LABELLED_FIELD, False))
        row[LABELLED_FIELD] = is_labelled
        if is_labelled:
            labelled.add(i)
    return labelled


def load_data(path: Path, source_path: Optional[Path] = None) -> Dataset:
    text = path.read_text(encoding="utf-8")
    rows: List[Dict[str, Any]] = []
    if path.suffix.lower() == ".jsonl":
        fmt = "jsonl"
        for i, line in enumerate(text.splitlines()):
            line = line.strip()
            if not line:
                continue
            obj = json.loads(line)
            if not isinstance(obj, dict):
                raise ValueError(f"Line {i + 1}: expected JSON object, got {type(obj).__name__}")
            rows.append(obj)
    else:
        fmt = "json"
        obj = json.loads(text)
        if isinstance(obj, dict):
            rows = [obj]
        elif isinstance(obj, list):
            for i, item in enumerate(obj):
                if not isinstance(item, dict):
                    raise ValueError(f"Item {i}: expected JSON object, got {type(item).__name__}")
                rows.append(item)
        else:
            raise ValueError(f"Unsupported top-level JSON type: {type(obj).__name__}")
    return Dataset(
        path=source_path or path,
        fmt=fmt,
        rows=rows,
        loaded_at_ms=_now_ms(),
        dirty_rows=init_label_state(rows),
        working_path=path if source_path else None,
    )


def atomic_write_data(path: Path, dataset: Dataset) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix(path.suffix + ".tmp")
    with tmp.open("w", encoding="utf-8", newline="\n") as f:
        if dataset.fmt == "jsonl":
            for obj in dataset.rows:
                f.write(json.dumps(obj, ensure_ascii=False) + "\n")
        else:
            json.dump(dataset.rows, f, ensure_ascii=False, indent=2)
    os.replace(tmp, path)


def pick_startup_data_path() -> Path:
    """
    选择启动时加载的数据文件，优先级：
    1) 命令行参数
    2) ANNOTATION_DATA_PATH 环境变量
    3) 项目目录下的 *.jsonl / *.json（不含 output/、annotation_templates/）
    """
    def resolve(p: str) -> Path:
        q = Path(p)
        return q if q.is_absolute() else (APP_DIR / q).resolve()

    if len(sys.argv) > 1:
        p = resolve(sys.argv[1])
        if p.exists():
            return p
        raise FileNotFoundError(f"data file not found: {p}")

    env = os.environ.get("ANNOTATION_DATA_PATH")
    if env:
        p = resolve(env)
        if p.exists():
            return p
        raise FileNotFoundError(f"ANNOTATION_DATA_PATH not found: {p}")

    candidates = [
        p for p in list(APP_DIR.glob("*.jsonl")) + list(APP_DIR.glob("*.json"))
        if p.is_file()
    ]
    if candidates:
        candidates.sort(key=lambda p: p.stat().st_mtime, reverse=True)
        return candidates[0]

    raise FileNotFoundError(
        "未找到数据文件。请通过命令行参数或 ANNOTATION_DATA_PATH 指定一个 .json/.jsonl 文件。"
    )


def timestamped_working_path(dataset: Dataset) -> Path:
    """生成带微秒时间戳的工作文件名。"""
    now_ns = time.time_ns()
    base = time.strftime("%Y%m%d_%H%M%S", time.localtime(now_ns / 1_000_000_000))
    micros = (now_ns // 1000) % 1_000_000
    return OUTPUT_DIR / f"{source_stem(dataset)}_{base}_{micros:06d}{dataset.path.suffix}"


def output_versions_for(source_path: Path) -> List[Path]:
    """查找指定原始文件对应的所有时间戳存档，最新的排在前面。"""
    if not OUTPUT_DIR.exists():
        return []
    pattern = re.compile(
        rf"^{re.escape(source_path.stem)}_(\d{{8}}_\d{{6}}(?:_\d{{3}}|_\d{{6}})?)"
        rf"{re.escape(source_path.suffix)}$"
    )
    versions = [
        p for p in OUTPUT_DIR.iterdir()
        if p.is_file() and pattern.fullmatch(p.name)
    ]
    versions.sort(key=lambda p: (p.stat().st_mtime, p.name), reverse=True)
    return versions


def source_stem(dataset: Dataset) -> str:
    return dataset.path.stem


# ---------------------------------------------------------------------------
# 模版：自动推断 + 文件读写
# ---------------------------------------------------------------------------

def infer_field(key: str, values: List[Any]) -> Dict[str, Any]:
    """根据一列取值推断字段的默认控件配置。"""
    spec: Dict[str, Any] = {
        "key": key,
        "label": key,
        "widget": "text",
        "rows": 4,
        "editable": True,
        "hidden": False,
        "side_by_side": False,
        "filterable": False,
        "options": [],
    }
    non_null = [v for v in values if v is not None]
    if not non_null:
        return spec

    if all(isinstance(v, bool) for v in non_null):
        spec["widget"] = "checkbox"
        return spec
    if all(isinstance(v, (int, float)) and not isinstance(v, bool) for v in non_null):
        spec["widget"] = "number"
        return spec
    if all(isinstance(v, (dict, list)) for v in non_null):
        spec["widget"] = "json"
        spec["rows"] = 10
        return spec
    if all(isinstance(v, str) for v in non_null):
        # 枚举判断只看非空取值，避免"大多为空、偶有备注"的字段被误判为 select
        non_empty = [v for v in non_null if v.strip()]
        distinct = sorted({v for v in non_empty})
        if (
            distinct
            and len(distinct) <= ENUM_MAX_DISTINCT
            and all(len(v) <= ENUM_MAX_LEN and "\n" not in v for v in distinct)
            and len(non_empty) > len(distinct)
        ):
            spec["widget"] = "select"
            spec["options"] = distinct
            return spec
        max_len = max(len(v) for v in non_null)
        if max_len > LONG_TEXT_MIN_LEN or any("\n" in v for v in non_null):
            spec["widget"] = "textarea"
            spec["rows"] = 4 if max_len <= 300 else (10 if max_len <= 1500 else 18)
        return spec

    # 混合类型统一用 json 编辑
    spec["widget"] = "json"
    spec["rows"] = 6
    return spec


def generate_template(dataset: Dataset) -> Dict[str, Any]:
    """扫描全部数据，自动解析 key & value，生成默认模版。"""
    keys: List[str] = []
    values_by_key: Dict[str, List[Any]] = {}
    for row in dataset.rows:
        for k, v in row.items():
            if k not in values_by_key:
                keys.append(k)
                values_by_key[k] = []
            values_by_key[k].append(v)

    fields = [infer_field(k, values_by_key[k]) for k in keys]

    # 猜一个适合在左侧列表展示的字段：优先短文本字符串
    def is_short_str(f: Dict[str, Any]) -> bool:
        return f["widget"] in ("text", "select")

    title_field = next((f["key"] for f in fields if is_short_str(f)), keys[0] if keys else "")
    subtitle_candidates = [f["key"] for f in fields if is_short_str(f) and f["key"] != title_field]
    tag_field = next((f["key"] for f in fields if f["widget"] == "select"), "")

    search_fields = [f["key"] for f in fields if f["widget"] in ("text", "textarea", "select")]

    return {
        "version": 2,
        "source_file": dataset.path.name,
        "generated_at": time.strftime("%Y-%m-%d %H:%M:%S"),
        "save_mode": "manual",  # manual | auto
        "list": {
            "title_field": title_field,
            "subtitle_field": subtitle_candidates[0] if subtitle_candidates else "",
            "tag_field": tag_field,
        },
        "search_fields": search_fields,
        "fields": fields,
    }


def template_path_for(dataset: Dataset) -> Path:
    return TEMPLATE_DIR / f"{source_stem(dataset)}.template.json"


def normalize_template_name(name: Any) -> Optional[str]:
    if not isinstance(name, str):
        return None
    name = name.strip()
    if not name:
        return None
    if name.endswith(".template.json"):
        stem = name[: -len(".template.json")]
    elif name.endswith(".json"):
        stem = name[: -len(".json")]
        if stem.endswith(".template"):
            stem = stem[: -len(".template")]
    else:
        stem = name
    if not stem or "/" in stem or "\\" in stem or stem in {".", ".."}:
        return None
    if not re.fullmatch(r"[\w\u4e00-\u9fff.-]+", stem):
        return None
    return f"{stem}.template.json"


def template_path_from_name(name: Any) -> Optional[Path]:
    filename = normalize_template_name(name)
    if filename is None:
        return None
    return TEMPLATE_DIR / filename


def template_files() -> List[Path]:
    if not TEMPLATE_DIR.exists():
        return []
    templates = [
        p for p in TEMPLATE_DIR.glob("*.template.json")
        if p.is_file() and template_path_from_name(p.name) == p
    ]
    templates.sort(key=lambda p: p.stat().st_mtime, reverse=True)
    return templates


def template_info(path: Path, current_path: Path, default_path: Path) -> Dict[str, Any]:
    info: Dict[str, Any] = {
        "name": path.name,
        "path": str(path),
        "source_file": "",
        "modified_at_ms": int(path.stat().st_mtime * 1000),
        "is_current": path == current_path,
        "is_default": path == default_path,
    }
    try:
        tpl = json.loads(path.read_text(encoding="utf-8"))
        source_file = tpl.get("source_file")
        if isinstance(source_file, str):
            info["source_file"] = source_file
        err = validate_template(tpl)
        if err:
            info["error"] = err
    except Exception as e:
        info["error"] = str(e)
    return info


def validate_template(tpl: Any) -> Optional[str]:
    """返回错误信息；合法则返回 None。"""
    if not isinstance(tpl, dict):
        return "模版必须是 JSON 对象"
    if tpl.get("save_mode") not in ("auto", "manual"):
        return "save_mode 必须是 auto 或 manual"
    fields = tpl.get("fields")
    if not isinstance(fields, list):
        return "fields 必须是数组"
    seen: Set[str] = set()
    for i, f in enumerate(fields):
        if not isinstance(f, dict):
            return f"fields[{i}] 必须是对象"
        key = f.get("key")
        if not isinstance(key, str) or not key:
            return f"fields[{i}].key 必须是非空字符串"
        if key in seen:
            return f"字段 key 重复: {key}"
        seen.add(key)
        if f.get("widget") not in WIDGETS:
            return f"fields[{i}].widget 必须是 {sorted(WIDGETS)} 之一"
        if not isinstance(f.get("rows", 4), int) or f.get("rows", 4) < 1:
            return f"fields[{i}].rows 必须是正整数"
        if not isinstance(f.get("editable", True), bool):
            return f"fields[{i}].editable 必须是布尔值"
        if not isinstance(f.get("hidden", False), bool):
            return f"fields[{i}].hidden 必须是布尔值"
        if not isinstance(f.get("side_by_side", False), bool):
            return f"fields[{i}].side_by_side 必须是布尔值"
        if not isinstance(f.get("filterable", False), bool):
            return f"fields[{i}].filterable 必须是布尔值"
        if not isinstance(f.get("options", []), list):
            return f"fields[{i}].options 必须是数组"
    lst = tpl.get("list")
    if lst is not None and not isinstance(lst, dict):
        return "list 必须是对象"
    sf = tpl.get("search_fields", [])
    if not isinstance(sf, list) or not all(isinstance(s, str) for s in sf):
        return "search_fields 必须是字符串数组"
    return None


def ensure_label_field(tpl: Dict[str, Any]) -> Dict[str, Any]:
    fields = tpl.setdefault("fields", [])
    if not any(f.get("key") == LABELLED_FIELD for f in fields):
        fields.append({
            "key": LABELLED_FIELD,
            "label": "已标注",
            "widget": "checkbox",
            "rows": 1,
            "editable": True,
            "hidden": False,
            "side_by_side": False,
            "filterable": True,
            "options": [],
        })
    return tpl


def load_template_file(path: Path) -> Dict[str, Any]:
    tpl = json.loads(path.read_text(encoding="utf-8"))
    err = validate_template(tpl)
    if err:
        raise ValueError(err)
    return ensure_label_field(tpl)


def load_or_create_template(dataset: Dataset) -> tuple[Dict[str, Any], Path]:
    path = template_path_for(dataset)
    if path.exists():
        try:
            return load_template_file(path), path
        except ValueError as e:
            print(f"[warn] 模版文件不合法（{e}），已重新生成: {path}")
    tpl = generate_template(dataset)
    tpl = ensure_label_field(tpl)
    save_template(tpl, path)
    return tpl, path


def save_template(tpl: Dict[str, Any], path: Path) -> Path:
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix(path.suffix + ".tmp")
    tmp.write_text(json.dumps(tpl, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    os.replace(tmp, path)
    return path


# ---------------------------------------------------------------------------
# Flask 应用
# ---------------------------------------------------------------------------

def make_app() -> Flask:
    app = Flask(__name__, static_folder="static", static_url_path="/static")
    dataset = load_data(pick_startup_data_path())
    template, current_template_path = load_or_create_template(dataset)

    def stringify(v: Any, max_len: int = 120) -> str:
        if v is None:
            return ""
        if isinstance(v, str):
            s = v
        else:
            s = json.dumps(v, ensure_ascii=False)
        s = s.replace("\n", " ")
        return s[:max_len] + ("…" if len(s) > max_len else "")

    def row_summary(idx: int) -> Dict[str, Any]:
        row = dataset.rows[idx]
        lst = template.get("list") or {}
        tf, sf, gf = lst.get("title_field"), lst.get("subtitle_field"), lst.get("tag_field")
        return {
            "index": idx,
            "title": stringify(row.get(tf)) if tf else f"#{idx + 1}",
            "subtitle": stringify(row.get(sf)) if sf else "",
            "tag": stringify(row.get(gf), 40) if gf else "",
            "dirty": idx in dataset.dirty_rows,
        }

    def persist() -> Path:
        old_path = dataset.working_path
        new_path = timestamped_working_path(dataset)
        if old_path is None:
            atomic_write_data(new_path, dataset)
        else:
            atomic_write_data(old_path, dataset)
            if old_path != new_path:
                os.replace(old_path, new_path)
        dataset.working_path = new_path
        return new_path

    def sync_template_keys_to_rows(tpl: Dict[str, Any]) -> int:
        """将模版字段全局补齐到所有行（缺失值填 None）。"""
        keys = [
            f.get("key")
            for f in tpl.get("fields", [])
            if isinstance(f, dict) and isinstance(f.get("key"), str) and f.get("key")
        ]
        if not keys:
            return 0
        filled = 0
        for row in dataset.rows:
            for k in keys:
                if k not in row:
                    row[k] = None
                    filled += 1
        return filled

    startup_filled = sync_template_keys_to_rows(template)
    if startup_filled > 0:
        print(f"[info] 启动时按模版补齐缺失 key: {startup_filled}")

    @app.get("/")
    def index():
        return send_from_directory(APP_DIR / "static", "index.html")

    @app.get("/api/meta")
    def meta():
        return jsonify({
            "data_path": str(dataset.path),
            "data_format": dataset.fmt,
            "working_path": str(dataset.working_path) if dataset.working_path else None,
            "template_path": str(current_template_path),
            "default_template_path": str(template_path_for(dataset)),
            "loaded_at_ms": dataset.loaded_at_ms,
            "total": len(dataset.rows),
            "dirty_count": len(dataset.dirty_rows),
            "save_mode": template.get("save_mode", "manual"),
        })

    @app.get("/api/resume-options")
    def resume_options():
        versions = output_versions_for(dataset.path)
        return jsonify({
            "source_path": str(dataset.path),
            "versions": [
                {
                    "name": p.name,
                    "path": str(p),
                    "modified_at_ms": int(p.stat().st_mtime * 1000),
                }
                for p in versions
            ],
        })

    @app.post("/api/session/select")
    def select_session():
        nonlocal dataset, template, current_template_path
        body = request.get_json(silent=True) or {}
        action = body.get("action")
        source_path = dataset.path
        if action == "restart":
            dataset = load_data(source_path)
        elif action == "resume":
            name = body.get("name")
            selected = next(
                (p for p in output_versions_for(source_path) if p.name == name),
                None,
            )
            if selected is None:
                return jsonify({"error": "所选存档不存在或不属于当前原始文件"}), 404
            dataset = load_data(selected, source_path=source_path)
        else:
            return jsonify({"error": "action 必须是 restart 或 resume"}), 400
        template, current_template_path = load_or_create_template(dataset)
        return jsonify({
            "ok": True,
            "data_path": str(dataset.path),
            "working_path": str(dataset.working_path) if dataset.working_path else None,
        })

    # ---------------- 模版 ----------------

    @app.get("/api/template")
    def get_template():
        return jsonify(template)

    @app.get("/api/templates")
    def list_templates():
        default_path = template_path_for(dataset)
        return jsonify({
            "current": current_template_path.name,
            "default": default_path.name,
            "templates": [
                template_info(p, current_template_path, default_path)
                for p in template_files()
            ],
        })

    @app.put("/api/template")
    def put_template():
        nonlocal template
        body = request.get_json(silent=True)
        err = validate_template(body)
        if err:
            return jsonify({"error": err}), 400
        template = ensure_label_field(body)
        filled = sync_template_keys_to_rows(template)
        path = save_template(template, current_template_path)
        saved_path = str(persist()) if filled > 0 and template.get("save_mode") == "auto" else None
        return jsonify({
            "ok": True,
            "template_path": str(path),
            "filled_count": filled,
            "auto_saved_path": saved_path,
        })

    @app.post("/api/template/select")
    def select_template():
        nonlocal template, current_template_path
        body = request.get_json(silent=True) or {}
        path = template_path_from_name(body.get("name"))
        if path is None:
            return jsonify({"error": "模版名不合法"}), 400
        if not path.exists():
            return jsonify({"error": "模版不存在"}), 404
        try:
            selected = load_template_file(path)
        except (json.JSONDecodeError, ValueError) as e:
            return jsonify({"error": f"模版文件不合法: {e}"}), 400
        template = selected
        current_template_path = path
        filled = sync_template_keys_to_rows(template)
        saved_path = str(persist()) if filled > 0 and template.get("save_mode") == "auto" else None
        return jsonify({
            "ok": True,
            "template_path": str(path),
            "template": template,
            "filled_count": filled,
            "auto_saved_path": saved_path,
        })

    @app.post("/api/template/save-as")
    def save_template_as():
        nonlocal template, current_template_path
        body = request.get_json(silent=True) or {}
        path = template_path_from_name(body.get("name"))
        if path is None:
            return jsonify({"error": "模版名只能包含中英文、数字、下划线、点和短横线"}), 400
        tpl = body.get("template", template)
        err = validate_template(tpl)
        if err:
            return jsonify({"error": err}), 400
        template = ensure_label_field(tpl)
        filled = sync_template_keys_to_rows(template)
        current_template_path = save_template(template, path)
        saved_path = str(persist()) if filled > 0 and template.get("save_mode") == "auto" else None
        return jsonify({
            "ok": True,
            "template_path": str(current_template_path),
            "template": template,
            "filled_count": filled,
            "auto_saved_path": saved_path,
        })

    @app.post("/api/template/generate")
    def regenerate_template():
        nonlocal template
        template = generate_template(dataset)
        template = ensure_label_field(template)
        filled = sync_template_keys_to_rows(template)
        path = save_template(template, current_template_path)
        saved_path = str(persist()) if filled > 0 and template.get("save_mode") == "auto" else None
        return jsonify({
            "ok": True,
            "template_path": str(path),
            "template": template,
            "filled_count": filled,
            "auto_saved_path": saved_path,
        })

    # ---------------- 数据行 ----------------

    @app.get("/api/rows")
    def list_rows():
        try:
            offset = max(0, int(request.args.get("offset", "0")))
            limit = max(1, min(200, int(request.args.get("limit", "30"))))
        except ValueError:
            return jsonify({"error": "offset/limit must be integers"}), 400

        q = (request.args.get("q") or "").strip().lower()
        changed = (request.args.get("changed") or "any").strip().lower()
        if changed not in {"any", "yes", "no"}:
            return jsonify({"error": "changed must be any|yes|no"}), 400

        search_fields = template.get("search_fields") or []
        filter_specs = {
            f["key"]: f
            for f in template.get("fields", [])
            if f.get("filterable", False)
        }
        try:
            filters = json.loads(request.args.get("filters") or "{}")
        except json.JSONDecodeError:
            return jsonify({"error": "filters must be a JSON object"}), 400
        if not isinstance(filters, dict):
            return jsonify({"error": "filters must be a JSON object"}), 400
        unknown_filters = set(filters) - set(filter_specs)
        if unknown_filters:
            return jsonify({
                "error": f"fields are not configured as filterable: {sorted(unknown_filters)}"
            }), 400

        def matches_filter(actual: Any, expected: Any, spec: Dict[str, Any]) -> bool:
            widget = spec.get("widget")
            if widget in {"select", "checkbox", "number"}:
                return actual == expected
            if actual is None:
                return False
            if isinstance(actual, str):
                text = actual
            else:
                text = json.dumps(actual, ensure_ascii=False)
            return str(expected).lower() in text.lower()

        def match(idx: int) -> bool:
            if changed == "yes" and idx not in dataset.dirty_rows:
                return False
            if changed == "no" and idx in dataset.dirty_rows:
                return False
            row = dataset.rows[idx]
            for key, expected in filters.items():
                if not matches_filter(row.get(key), expected, filter_specs[key]):
                    return False
            if q:
                keys = search_fields if search_fields else list(row.keys())
                blob = "\n".join(
                    v if isinstance(v, str) else json.dumps(v, ensure_ascii=False)
                    for k in keys
                    for v in [row.get(k)]
                    if v is not None
                ).lower()
                if q not in blob:
                    return False
            return True

        indices = [i for i in range(len(dataset.rows)) if match(i)]
        page = indices[offset: offset + limit]
        return jsonify({
            "total": len(indices),
            "offset": offset,
            "limit": limit,
            "items": [row_summary(i) for i in page],
        })

    @app.get("/api/row/<int:idx>")
    def get_row(idx: int):
        if not (0 <= idx < len(dataset.rows)):
            return jsonify({"error": "not found"}), 404
        return jsonify({"index": idx, "row": dataset.rows[idx], "dirty": idx in dataset.dirty_rows})

    @app.patch("/api/row/<int:idx>")
    def patch_row(idx: int):
        if not (0 <= idx < len(dataset.rows)):
            return jsonify({"error": "not found"}), 404
        body = request.get_json(silent=True) or {}
        sets = body.get("set") or {}
        deletes = body.get("delete") or []
        if not isinstance(sets, dict) or not isinstance(deletes, list):
            return jsonify({"error": "body must be {set: object, delete: array}"}), 400
        if LABELLED_FIELD in [d for d in deletes if isinstance(d, str)]:
            return jsonify({"error": f"字段不可删除: {LABELLED_FIELD}"}), 400
        if not sets and not deletes:
            return jsonify({"error": "nothing to change"}), 400

        editable = {f["key"] for f in template.get("fields", []) if f.get("editable", True)}
        template_keys = {f["key"] for f in template.get("fields", [])}
        row = dataset.rows[idx]
        for k in list(sets.keys()) + [d for d in deletes if isinstance(d, str)]:
            # 模版中标记为不可改的字段拒绝写入；模版外的新 key 允许（即"增 key"）
            if k in template_keys and k not in editable:
                return jsonify({"error": f"字段不可修改（模版中 editable=false）: {k}"}), 400

        changed = False
        for k, v in sets.items():
            if row.get(k, object()) != v:
                row[k] = v
                changed = True
        for k in deletes:
            if isinstance(k, str) and k in row:
                del row[k]
                changed = True

        saved_path = None
        if changed:
            touched_non_label = any(k != LABELLED_FIELD for k in sets) or any(
                isinstance(k, str) and k != LABELLED_FIELD for k in deletes
            )
            if touched_non_label and LABELLED_FIELD not in sets:
                row[LABELLED_FIELD] = True
            row[LABELLED_FIELD] = normalize_labelled(row.get(LABELLED_FIELD, False))
            if row[LABELLED_FIELD]:
                dataset.dirty_rows.add(idx)
            else:
                dataset.dirty_rows.discard(idx)
            if template.get("save_mode") == "auto":
                saved_path = str(persist())

        return jsonify({
            "ok": True,
            "changed": changed,
            "auto_saved_path": saved_path,
            "item": row_summary(idx),
        })

    @app.post("/api/key/add")
    def add_key_global():
        body = request.get_json(silent=True) or {}
        key = body.get("key")
        if not isinstance(key, str) or not key.strip():
            return jsonify({"error": "key must be a non-empty string"}), 400
        key = key.strip()
        if key == LABELLED_FIELD:
            return jsonify({"error": f"字段已保留: {LABELLED_FIELD}"}), 400

        filled = 0
        for row in dataset.rows:
            if key not in row:
                row[key] = None
                filled += 1

        saved_path = None
        if filled > 0 and template.get("save_mode") == "auto":
            saved_path = str(persist())

        return jsonify({
            "ok": True,
            "key": key,
            "filled_count": filled,
            "auto_saved_path": saved_path,
        })

    # ---------------- 存盘 ----------------

    @app.post("/api/save")
    def save():
        body = request.get_json(silent=True) or {}
        out_path = persist()
        result = {"ok": True, "saved_path": str(out_path)}
        if body.get("snapshot"):
            ts = time.strftime("%Y%m%d_%H%M%S")
            snap = OUTPUT_DIR / f"{source_stem(dataset)}_snapshot_{ts}{dataset.path.suffix}"
            shutil.copy2(out_path, snap)
            result["snapshot_path"] = str(snap)
        return jsonify(result)

    return app


if __name__ == "__main__":
    app = make_app()
    app.run(host="127.0.0.1", port=5177, debug=True)
