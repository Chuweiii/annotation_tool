from __future__ import annotations

import json
import os
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


# ---------------------------------------------------------------------------
# 数据集
# ---------------------------------------------------------------------------

@dataclass
class Dataset:
    path: Path            # 启动时加载的文件
    fmt: str              # "jsonl" | "json"
    rows: List[Dict[str, Any]]
    loaded_at_ms: int
    dirty_rows: Set[int] = field(default_factory=set)  # 本次会话中被修改过的行


def _now_ms() -> int:
    return int(time.time() * 1000)


def load_data(path: Path) -> Dataset:
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
    return Dataset(path=path, fmt=fmt, rows=rows, loaded_at_ms=_now_ms())


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
    3) output/ 下最新的 *_edited* 工作文件（继续上次的标注）
    4) 项目目录下的 *.jsonl / *.json（不含 output/、annotation_templates/）
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

    if OUTPUT_DIR.exists():
        edited = [
            p for p in list(OUTPUT_DIR.glob("*_edited*.jsonl")) + list(OUTPUT_DIR.glob("*_edited*.json"))
            if p.is_file()
        ]
        if edited:
            edited.sort(key=lambda p: p.stat().st_mtime, reverse=True)
            return edited[0]

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


def working_path_for(dataset: Dataset) -> Path:
    """自动/手动存盘写入的工作文件（不覆盖原始文件）。"""
    if dataset.path.parent == OUTPUT_DIR and "_edited" in dataset.path.stem:
        return dataset.path
    return OUTPUT_DIR / f"{dataset.path.stem}_edited{dataset.path.suffix}"


def source_stem(dataset: Dataset) -> str:
    stem = dataset.path.stem
    if "_edited" in stem:
        stem = stem.split("_edited")[0]
    return stem


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


def load_or_create_template(dataset: Dataset) -> Dict[str, Any]:
    path = template_path_for(dataset)
    if path.exists():
        tpl = json.loads(path.read_text(encoding="utf-8"))
        err = validate_template(tpl)
        if err is None:
            return tpl
        print(f"[warn] 模版文件不合法（{err}），已重新生成: {path}")
    tpl = generate_template(dataset)
    save_template(dataset, tpl)
    return tpl


def save_template(dataset: Dataset, tpl: Dict[str, Any]) -> Path:
    path = template_path_for(dataset)
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
    template = load_or_create_template(dataset)

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
        out = working_path_for(dataset)
        atomic_write_data(out, dataset)
        return out

    @app.get("/")
    def index():
        return send_from_directory(APP_DIR / "static", "index.html")

    @app.get("/api/meta")
    def meta():
        return jsonify({
            "data_path": str(dataset.path),
            "data_format": dataset.fmt,
            "working_path": str(working_path_for(dataset)),
            "template_path": str(template_path_for(dataset)),
            "loaded_at_ms": dataset.loaded_at_ms,
            "total": len(dataset.rows),
            "dirty_count": len(dataset.dirty_rows),
            "save_mode": template.get("save_mode", "manual"),
        })

    # ---------------- 模版 ----------------

    @app.get("/api/template")
    def get_template():
        return jsonify(template)

    @app.put("/api/template")
    def put_template():
        nonlocal template
        body = request.get_json(silent=True)
        err = validate_template(body)
        if err:
            return jsonify({"error": err}), 400
        template = body
        path = save_template(dataset, template)
        return jsonify({"ok": True, "template_path": str(path)})

    @app.post("/api/template/generate")
    def regenerate_template():
        nonlocal template
        template = generate_template(dataset)
        path = save_template(dataset, template)
        return jsonify({"ok": True, "template_path": str(path), "template": template})

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
            dataset.dirty_rows.add(idx)
            if template.get("save_mode") == "auto":
                saved_path = str(persist())

        return jsonify({
            "ok": True,
            "changed": changed,
            "auto_saved_path": saved_path,
            "item": row_summary(idx),
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
