from __future__ import annotations

import json
import os
import re
import shutil
import sys
import tempfile
import threading
import time
import uuid
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Dict, List, Optional, Set

from flask import Flask, g, jsonify, request, send_file, send_from_directory, session
from werkzeug.local import LocalProxy
from werkzeug.utils import secure_filename


APP_DIR = Path(__file__).resolve().parent
OUTPUT_DIR = APP_DIR / "output"
TEMPLATE_DIR = APP_DIR / "annotation_templates"
ALLOWED_SUFFIXES = {".json", ".jsonl", ".xlsx", ".xls"}
MAX_UPLOAD_BYTES = 100 * 1024 * 1024

# 字段类型推断阈值
ENUM_MAX_DISTINCT = 12       # 不同取值数 <= 该值 且为短字符串 -> select
ENUM_MAX_LEN = 40            # 枚举候选值的最大长度
LONG_TEXT_MIN_LEN = 120      # 超过该长度（或含换行）的字符串 -> textarea

WIDGETS = {
    "text", "textarea", "number", "checkbox", "select", "json", "repeatable",
    "collection_cards",
}
REPEATABLE_ITEM_WIDGETS = {
    "text", "textarea", "number", "checkbox", "select", "multiselect",
    "self_multiselect", "cascader", "checkbox_group",
}
LABELLED_FIELD = "is_labelled"

# 嵌套字段使用 "." 连接路径，如 "meta.author.name"
PATH_SEP = "."
EXCEL_SUFFIXES = {".xlsx", ".xls"}

# 模型推理配置（参考 annotation_app.py）：
# - api:   调用 OpenAI 兼容的远程 API（需要环境变量中的 API Key）
# - local: 调用本地部署的 OpenAI 兼容服务（vLLM / Ollama / LM Studio 等，一般无需 Key）
INFER_MODES: Dict[str, Dict[str, Any]] = {
    "api": {
        "label": "调用 API",
        "model": "gpt-4o-2024-05-13",
        "base_url": "https://yeysai.com/v1",
        "api_key_env": "OPENAI_API_KEY",
        "temperature": 0.0,
    },
    "local": {
        "label": "本地模型",
        "model": "Qwen2.5-7B-Instruct",
        "base_url": os.environ.get("LOCAL_MODEL_BASE_URL", ""),
        "api_key_env": "",
        "temperature": 0.0,
    },
}


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


def _load_dotenv(dotenv_path: Path) -> None:
    if not dotenv_path.exists():
        return
    for raw in dotenv_path.read_text(encoding="utf-8").splitlines():
        line = raw.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        k, v = line.split("=", 1)
        key = k.strip()
        val = v.strip().strip("'").strip('"')
        if key and key not in os.environ:
            os.environ[key] = val


def infer_chat(
    mode: str,
    model: str,
    base_url: str,
    temperature: float,
    system_prompt: str,
    user_prompt: str,
) -> str:
    """通过 OpenAI 兼容接口执行一次推理（远程 API 或本地服务）。"""
    try:
        from openai import OpenAI
    except ImportError as exc:
        raise RuntimeError("缺少 openai 包，请先安装：pip install openai") from exc

    cfg = INFER_MODES[mode]
    api_key_env = cfg.get("api_key_env") or ""
    api_key = os.environ.get(api_key_env, "") if api_key_env else ""
    if mode == "api" and not api_key:
        raise RuntimeError(f"环境变量 {api_key_env} 尚未设置，无法调用 API。")

    client = OpenAI(api_key=api_key or "EMPTY", base_url=base_url or None)
    messages: List[Dict[str, str]] = []
    if system_prompt:
        messages.append({"role": "system", "content": system_prompt})
    messages.append({"role": "user", "content": user_prompt})
    completion = client.chat.completions.create(
        model=model,
        messages=messages,
        temperature=temperature,
    )
    return completion.choices[0].message.content or ""


# ---------------------------------------------------------------------------
# 嵌套路径读写：优先把 key 当作字面量（兼容 key 本身含 "." 的情况），
# 否则按 "." 分段在嵌套 dict 中递归寻址。
# ---------------------------------------------------------------------------

def has_path(row: Dict[str, Any], path: str) -> bool:
    if path in row:
        return True
    cur: Any = row
    for part in path.split(PATH_SEP):
        if not isinstance(cur, dict) or part not in cur:
            return False
        cur = cur[part]
    return True


def get_path(row: Dict[str, Any], path: str) -> Any:
    if path in row:
        return row[path]
    cur: Any = row
    for part in path.split(PATH_SEP):
        if not isinstance(cur, dict) or part not in cur:
            return None
        cur = cur[part]
    return cur


def set_path(row: Dict[str, Any], path: str, value: Any) -> bool:
    """按路径写入；中间节点缺失或为 None 时自动创建 dict。写入成功返回 True。"""
    if PATH_SEP not in path or path in row:
        row[path] = value
        return True
    parts = path.split(PATH_SEP)
    cur: Any = row
    for part in parts[:-1]:
        nxt = cur.get(part)
        if nxt is None:
            nxt = {}
            cur[part] = nxt
        if not isinstance(nxt, dict):
            return False
        cur = nxt
    cur[parts[-1]] = value
    return True


def delete_path(row: Dict[str, Any], path: str) -> bool:
    if path in row:
        del row[path]
        return True
    parts = path.split(PATH_SEP)
    cur: Any = row
    for part in parts[:-1]:
        if not isinstance(cur, dict) or part not in cur:
            return False
        cur = cur[part]
    if isinstance(cur, dict) and parts[-1] in cur:
        del cur[parts[-1]]
        return True
    return False


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


def _excel_cell_to_py(v: Any) -> Any:
    """把 pandas / numpy 读出的单元格值转成可 JSON 序列化的 Python 值。"""
    if v is None:
        return None
    if isinstance(v, float) and v != v:  # NaN
        return None
    if hasattr(v, "item"):  # numpy 标量
        try:
            return v.item()
        except Exception:
            pass
    if isinstance(v, (str, int, float, bool, list, dict)):
        return v
    return str(v)  # Timestamp 等其他类型


def load_excel_rows(path: Path) -> List[Dict[str, Any]]:
    try:
        import pandas as pd
    except ImportError as exc:
        raise RuntimeError(
            "解析 Excel 需要 pandas 和 openpyxl：pip install pandas openpyxl"
        ) from exc
    df = pd.read_excel(path)
    df = df.where(pd.notna(df), None)
    return [
        {str(k): _excel_cell_to_py(v) for k, v in rec.items()}
        for rec in df.to_dict(orient="records")
    ]


def load_data(path: Path, source_path: Optional[Path] = None) -> Dataset:
    if path.suffix.lower() in EXCEL_SUFFIXES:
        rows = load_excel_rows(path)
        return Dataset(
            path=source_path or path,
            fmt="excel",
            rows=rows,
            loaded_at_ms=_now_ms(),
            dirty_rows=init_label_state(rows),
            working_path=path if source_path else None,
        )
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
    if dataset.fmt == "excel":
        import pandas as pd
        columns: List[str] = []
        for row in dataset.rows:
            for k in row:
                if k not in columns:
                    columns.append(k)
        records = [
            {
                k: (json.dumps(v, ensure_ascii=False) if isinstance(v, (dict, list)) else v)
                for k, v in row.items()
            }
            for row in dataset.rows
        ]
        pd.DataFrame(records, columns=columns).to_excel(tmp, index=False, engine="openpyxl")
    else:
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
    3) 项目目录下的 *.jsonl / *.json / *.xlsx（不含 output/、annotation_templates/）
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
        p
        for p in (
            list(APP_DIR.glob("*.jsonl"))
            + list(APP_DIR.glob("*.json"))
            + list(APP_DIR.glob("*.xlsx"))
            + list(APP_DIR.glob("*.xls"))
        )
        if p.is_file()
    ]
    if candidates:
        candidates.sort(key=lambda p: p.stat().st_mtime, reverse=True)
        return candidates[0]

    raise FileNotFoundError(
        "未找到数据文件。请通过命令行参数或 ANNOTATION_DATA_PATH 指定一个 .json/.jsonl/.xlsx 文件。"
    )


def timestamped_working_path(dataset: Dataset) -> Path:
    """生成带微秒时间戳的工作文件名。"""
    now_ns = time.time_ns()
    base = time.strftime("%Y%m%d_%H%M%S", time.localtime(now_ns / 1_000_000_000))
    micros = (now_ns // 1000) % 1_000_000
    return dataset.path.parent / "output" / f"{source_stem(dataset)}_{base}_{micros:06d}{dataset.path.suffix}"


def output_versions_for(source_path: Path) -> List[Path]:
    """查找指定原始文件对应的所有时间戳存档，最新的排在前面。"""
    output_dir = source_path.parent / "output"
    if not output_dir.exists():
        return []
    pattern = re.compile(
        rf"^{re.escape(source_path.stem)}_(\d{{8}}_\d{{6}}(?:_\d{{3}}|_\d{{6}})?)"
        rf"{re.escape(source_path.suffix)}$"
    )
    versions = [
        p for p in output_dir.iterdir()
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
        "hint": "",
        "widget": "text",
        "rows": 4,
        "editable": True,
        "hidden": False,
        "group": "",
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


def default_infer_config() -> Dict[str, Any]:
    api = INFER_MODES["api"]
    return {
        "mode": "api",
        "model": api["model"],
        "base_url": api["base_url"],
        "temperature": api["temperature"],
        "system_prompt": "",
        "user_prompt": "",
    }


def collect_leaf_paths(rows: List[Dict[str, Any]]) -> tuple[List[str], Dict[str, List[Any]]]:
    """
    递归扫描所有行，返回叶子路径（"." 连接）及各路径的取值列表。
    - 纯对象节点（所有非空取值都是 dict）继续下钻，不作为叶子；
    - 混合节点（部分行是 dict、部分行是别的类型）整体当作一个 json 叶子。
    """
    order: List[str] = []
    values_by_path: Dict[str, List[Any]] = {}
    has_children: Set[str] = set()

    def visit(obj: Dict[str, Any], prefix: str) -> None:
        for k, v in obj.items():
            path = f"{prefix}{PATH_SEP}{k}" if prefix else str(k)
            if path not in values_by_path:
                order.append(path)
                values_by_path[path] = []
            values_by_path[path].append(v)
            if isinstance(v, dict) and v:
                has_children.add(path)
                visit(v, path)

    for row in rows:
        visit(row, "")

    mixed = {
        p for p in has_children
        if any(v is not None and not isinstance(v, dict) for v in values_by_path[p])
    }

    def under_mixed(p: str) -> bool:
        return any(p.startswith(m + PATH_SEP) for m in mixed)

    leaves = [
        p for p in order
        if not under_mixed(p) and not (p in has_children and p not in mixed)
    ]
    return leaves, values_by_path


def generate_template(dataset: Dataset) -> Dict[str, Any]:
    """扫描全部数据，递归解析嵌套对象的 key & value，生成默认模版。"""
    keys, values_by_key = collect_leaf_paths(dataset.rows)
    fields = [infer_field(k, values_by_key[k]) for k in keys]

    # 猜一个适合在左侧列表展示的字段：优先短文本字符串
    def is_short_str(f: Dict[str, Any]) -> bool:
        return f["widget"] in ("text", "select")

    title_field = next((f["key"] for f in fields if is_short_str(f)), keys[0] if keys else "")
    subtitle_candidates = [f["key"] for f in fields if is_short_str(f) and f["key"] != title_field]
    tag_field = next((f["key"] for f in fields if f["widget"] == "select"), "")

    search_fields = [f["key"] for f in fields if f["widget"] in ("text", "textarea", "select")]

    return {
        "version": 3,
        "source_file": dataset.path.name,
        "generated_at": time.strftime("%Y-%m-%d %H:%M:%S"),
        "save_mode": "manual",  # manual | auto
        "infer_enabled": False,  # 是否启用模型推理（标注 + 模型验证）
        "infer": default_infer_config(),
        "list": {
            "title_field": title_field,
            "subtitle_field": subtitle_candidates[0] if subtitle_candidates else "",
            "tag_field": tag_field,
        },
        "search_fields": search_fields,
        "fields": fields,
    }


def template_path_for(dataset: Dataset) -> Path:
    return dataset.path.parent / f"{source_stem(dataset)}.template.json"


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


def numbered_tree_leaf_paths(path: Path) -> List[str]:
    """把“缩进 + 数字序号”的文本目录展开成叶子完整路径。"""
    if not path.exists():
        return []
    nodes: List[tuple[int, str]] = []
    pattern = re.compile(r"^(\s*)\d+\.\s*(.+?)\s*$")
    for raw in path.read_text(encoding="utf-8").splitlines():
        match = pattern.match(raw)
        if not match:
            continue
        indent = len(match.group(1).expandtabs(2))
        depth = max(0, indent // 2 - 1)
        name = match.group(2).strip().rstrip("：:、，,")
        nodes.append((depth, name))

    result: List[str] = []
    stack: List[str] = []
    for index, (depth, name) in enumerate(nodes):
        stack = stack[:depth]
        stack.append(name)
        next_depth = nodes[index + 1][0] if index + 1 < len(nodes) else -1
        if next_depth <= depth:
            result.append("；".join(stack))
    return result


def load_external_options(source: Dict[str, Any]) -> List[str]:
    """从工作区内文件加载选项；支持逐行文本、JSON 数组和编号缩进树。"""
    rel_path = source.get("path")
    fmt = source.get("format", "lines")
    if not isinstance(rel_path, str):
        return []
    candidate = (APP_DIR / rel_path).resolve()
    try:
        candidate.relative_to(APP_DIR.resolve())
    except ValueError:
        return []
    if not candidate.exists() or not candidate.is_file():
        return []
    if fmt == "numbered_tree_leaves":
        return numbered_tree_leaf_paths(candidate)
    if fmt == "json_array":
        try:
            value = json.loads(candidate.read_text(encoding="utf-8"))
        except Exception:
            return []
        return [str(item) for item in value] if isinstance(value, list) else []
    if fmt == "lines":
        return [line.strip() for line in candidate.read_text(encoding="utf-8").splitlines() if line.strip()]
    return []


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


def matching_template_path(dataset: Dataset) -> Optional[Path]:
    """按模版声明的 match.required_fields 自动匹配数据，不硬编码业务类型。"""
    matches: List[tuple[float, int, Path]] = []
    for path in template_files():
        try:
            tpl = json.loads(path.read_text(encoding="utf-8"))
        except Exception:
            continue
        if validate_template(tpl):
            continue
        match = tpl.get("match")
        if not isinstance(match, dict):
            continue
        required = match.get("required_fields", [])
        if not isinstance(required, list) or not required or not all(isinstance(k, str) for k in required):
            continue
        if not dataset.rows or not all(all(has_path(row, key) for key in required) for row in dataset.rows):
            continue
        priority = match.get("priority", 0)
        if not isinstance(priority, (int, float)):
            priority = 0
        matches.append((float(priority), len(required), path))
    if not matches:
        return None
    matches.sort(key=lambda item: (item[0], item[1], item[2].stat().st_mtime), reverse=True)
    return matches[0][2]


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
    if not isinstance(tpl.get("infer_enabled", False), bool):
        return "infer_enabled 必须是布尔值"
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
        if not isinstance(f.get("group", ""), str):
            return f"fields[{i}].group 必须是字符串"
        if not isinstance(f.get("hint", ""), str):
            return f"fields[{i}].hint 必须是字符串"
        if not isinstance(f.get("filterable", False), bool):
            return f"fields[{i}].filterable 必须是布尔值"
        if not isinstance(f.get("options", []), list):
            return f"fields[{i}].options 必须是数组"
        if f.get("widget") == "repeatable":
            if not isinstance(f.get("track_order", True), bool):
                return f"fields[{i}].track_order 必须是布尔值"
            item_fields = f.get("item_fields")
            if not isinstance(item_fields, list) or not item_fields:
                return f"fields[{i}].item_fields 必须是非空数组"
            item_keys: Set[str] = set()
            for j, item in enumerate(item_fields):
                if not isinstance(item, dict):
                    return f"fields[{i}].item_fields[{j}] 必须是对象"
                item_key = item.get("key")
                if not isinstance(item_key, str) or not item_key:
                    return f"fields[{i}].item_fields[{j}].key 必须是非空字符串"
                if item_key in item_keys:
                    return f"fields[{i}].item_fields key 重复: {item_key}"
                item_keys.add(item_key)
                if item.get("widget", "text") not in REPEATABLE_ITEM_WIDGETS:
                    return f"fields[{i}].item_fields[{j}].widget 不受支持"
                if not isinstance(item.get("options", []), list):
                    return f"fields[{i}].item_fields[{j}].options 必须是数组"
                if not isinstance(item.get("required", False), bool):
                    return f"fields[{i}].item_fields[{j}].required 必须是布尔值"
                if "options_from_path" in item and not isinstance(item["options_from_path"], str):
                    return f"fields[{i}].item_fields[{j}].options_from_path 必须是字符串"
                if item.get("options_from_object", "keys") not in {"keys", "entries"}:
                    return f"fields[{i}].item_fields[{j}].options_from_object 必须是 keys 或 entries"
                if "option_entry_separator" in item and (
                    not isinstance(item["option_entry_separator"], str) or not item["option_entry_separator"]
                ):
                    return f"fields[{i}].item_fields[{j}].option_entry_separator 必须是非空字符串"
                if "options_source" in item and not isinstance(item["options_source"], dict):
                    return f"fields[{i}].item_fields[{j}].options_source 必须是对象"
            steps = f.get("steps", [])
            if not isinstance(steps, list):
                return f"fields[{i}].steps 必须是数组"
            for j, step in enumerate(steps):
                if not isinstance(step, dict):
                    return f"fields[{i}].steps[{j}] 必须是对象"
                step_fields = step.get("fields")
                if not isinstance(step_fields, list) or not all(isinstance(k, str) for k in step_fields):
                    return f"fields[{i}].steps[{j}].fields 必须是字符串数组"
                unknown = set(step_fields) - item_keys
                if unknown:
                    return f"fields[{i}].steps[{j}] 包含未知子字段: {sorted(unknown)}"
                if step.get("view", "cards") not in {"cards", "graph"}:
                    return f"fields[{i}].steps[{j}].view 必须是 cards 或 graph"
                for relation_key in ("relation_field", "group_by_relation"):
                    relation_field = step.get(relation_key)
                    if relation_field is not None:
                        if not isinstance(relation_field, str) or relation_field not in item_keys:
                            return f"fields[{i}].steps[{j}].{relation_key} 必须引用已有子字段"
                        relation_spec = next(item for item in item_fields if item.get("key") == relation_field)
                        if relation_spec.get("widget", "text") != "self_multiselect":
                            return f"fields[{i}].steps[{j}].{relation_key} 必须引用 self_multiselect 子字段"
                if step.get("view") == "graph":
                    graph_relation = step.get("relation_field") or (step_fields[0] if step_fields else None)
                    if graph_relation not in item_keys:
                        return f"fields[{i}].steps[{j}] 的 graph 视图缺少有效关系字段"
                    graph_spec = next(item for item in item_fields if item.get("key") == graph_relation)
                    if graph_spec.get("widget", "text") != "self_multiselect":
                        return f"fields[{i}].steps[{j}] 的 graph 关系字段必须是 self_multiselect"
                for label_key in ("group_label", "single_label"):
                    if label_key in step and not isinstance(step[label_key], str):
                        return f"fields[{i}].steps[{j}].{label_key} 必须是字符串"
        if f.get("widget") == "collection_cards":
            card_fields = f.get("card_fields", [])
            if not isinstance(card_fields, list):
                return f"fields[{i}].card_fields 必须是数组"
            for j, card_field in enumerate(card_fields):
                if not isinstance(card_field, dict) or not isinstance(card_field.get("key"), str):
                    return f"fields[{i}].card_fields[{j}] 必须包含字符串 key"
    lst = tpl.get("list")
    if lst is not None and not isinstance(lst, dict):
        return "list 必须是对象"
    sf = tpl.get("search_fields", [])
    if not isinstance(sf, list) or not all(isinstance(s, str) for s in sf):
        return "search_fields 必须是字符串数组"
    match = tpl.get("match")
    if match is not None:
        if not isinstance(match, dict):
            return "match 必须是对象"
        required = match.get("required_fields", [])
        if not isinstance(required, list) or not all(isinstance(k, str) for k in required):
            return "match.required_fields 必须是字符串数组"
        if not isinstance(match.get("priority", 0), (int, float)):
            return "match.priority 必须是数字"
    infer = tpl.get("infer")
    if infer is not None:
        if not isinstance(infer, dict):
            return "infer 必须是对象"
        if infer.get("mode", "api") not in INFER_MODES:
            return f"infer.mode 必须是 {sorted(INFER_MODES)} 之一"
        for k in ("model", "base_url", "system_prompt", "user_prompt"):
            if not isinstance(infer.get(k, ""), str):
                return f"infer.{k} 必须是字符串"
        if not isinstance(infer.get("temperature", 0), (int, float)):
            return "infer.temperature 必须是数字"
    return None


def normalize_template(tpl: Dict[str, Any]) -> Dict[str, Any]:
    """补齐模版默认值：保证含 is_labelled 字段、hint/group 字段属性、infer 配置。
    旧版模版的 side_by_side 布尔标记会迁移为并列组（相邻勾选的字段归入同一组）。"""
    fields = tpl.setdefault("fields", [])
    if not any(f.get("key") == LABELLED_FIELD for f in fields):
        fields.append({
            "key": LABELLED_FIELD,
            "label": "已标注",
            "hint": "",
            "widget": "checkbox",
            "rows": 1,
            "editable": True,
            "hidden": False,
            "group": "",
            "filterable": True,
            "options": [],
        })

    group_seq = 0
    prev_was_side = False
    for f in fields:
        f.setdefault("hint", "")
        if f.get("widget") == "repeatable":
            for item in f.get("item_fields", []):
                source = item.get("options_source")
                if not isinstance(source, dict):
                    continue
                item["options"] = load_external_options(source)
        if "group" in f:
            f.pop("side_by_side", None)
            prev_was_side = False
            continue
        if f.pop("side_by_side", False):
            if not prev_was_side:
                group_seq += 1
            f["group"] = f"组{group_seq}"
            prev_was_side = True
        else:
            f["group"] = ""
            prev_was_side = False

    tpl.setdefault("infer_enabled", False)
    infer = tpl.get("infer")
    if not isinstance(infer, dict):
        infer = {}
        tpl["infer"] = infer
    for k, v in default_infer_config().items():
        infer.setdefault(k, v)
    return tpl


def load_template_file(path: Path) -> Dict[str, Any]:
    tpl = json.loads(path.read_text(encoding="utf-8"))
    err = validate_template(tpl)
    if err:
        raise ValueError(err)
    return normalize_template(tpl)


def load_or_create_template(dataset: Dataset) -> tuple[Dict[str, Any], Path]:
    path = template_path_for(dataset)
    if path.exists():
        try:
            return load_template_file(path), path
        except ValueError as e:
            print(f"[warn] 模版文件不合法（{e}），已重新生成: {path}")
    matched = matching_template_path(dataset)
    if matched is not None:
        tpl = load_template_file(matched)
        save_template(tpl, path)
        return tpl, path
    tpl = generate_template(dataset)
    tpl = normalize_template(tpl)
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
    app.secret_key = os.environ.get("SECRET_KEY", "dev-only-secret-change-in-production")
    app.config["MAX_CONTENT_LENGTH"] = MAX_UPLOAD_BYTES
    workspaces: Dict[str, Dict[str, Any]] = {}
    workspace_lock = threading.RLock()

    @app.before_request
    def lock_workspace_state():
        state = workspaces.get(session.get("workspace_id"))
        if state is not None:
            g.workspace_lock = state["lock"]
            g.workspace_lock.acquire()

    @app.teardown_request
    def unlock_workspace_state(_exc: Optional[BaseException]):
        lock = getattr(g, "workspace_lock", None)
        if lock is not None:
            lock.release()

    def workspace(required: bool = True) -> Optional[Dict[str, Any]]:
        workspace_id = session.get("workspace_id")
        state = workspaces.get(workspace_id) if workspace_id else None
        if state is None and required:
            raise RuntimeError("请先上传待标注文件")
        return state

    @app.errorhandler(RuntimeError)
    def handle_runtime_error(exc: RuntimeError):
        if str(exc) == "请先上传待标注文件":
            return jsonify({"error": str(exc), "needs_upload": True}), 409
        return jsonify({"error": str(exc)}), 500

    dataset: Dataset = LocalProxy(lambda: workspace()["dataset"])  # type: ignore[assignment,index]
    template: Dict[str, Any] = LocalProxy(lambda: workspace()["template"])  # type: ignore[assignment,index]
    current_template_path: Path = LocalProxy(lambda: workspace()["template_path"])  # type: ignore[assignment,index]

    def set_workspace_value(key: str, value: Any) -> None:
        workspace()[key] = value  # type: ignore[index]

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
            "title": stringify(get_path(row, tf)) if tf else f"#{idx + 1}",
            "subtitle": stringify(get_path(row, sf)) if sf else "",
            "tag": stringify(get_path(row, gf), 40) if gf else "",
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
                if not has_path(row, k) and set_path(row, k, None):
                    filled += 1
        return filled

    def available_template_files() -> List[Path]:
        """当前会话可用模版：内置模版 + 本会话上传或保存的模版，同名时会话版本优先。"""
        by_name = {path.name: path for path in template_files()}
        state = workspace(required=False)
        if state is not None:
            for path in state["root"].glob("*.template.json"):
                if path.is_file() and normalize_template_name(path.name) == path.name:
                    by_name[path.name] = path
        return sorted(by_name.values(), key=lambda path: path.stat().st_mtime, reverse=True)

    def available_template_path(name: Any) -> Optional[Path]:
        filename = normalize_template_name(name)
        if filename is None:
            return None
        state = workspace(required=False)
        if state is not None:
            local = state["root"] / filename
            if local.exists():
                return local
        builtin = TEMPLATE_DIR / filename
        return builtin if builtin.exists() else None

    @app.get("/")
    def index():
        return send_from_directory(APP_DIR / "static", "index.html")

    @app.get("/health")
    def health():
        return {"status": "ok"}

    @app.get("/api/status")
    def status():
        return jsonify({"ready": workspace(required=False) is not None})

    @app.post("/api/upload")
    def upload():
        uploaded = request.files.get("file")
        if uploaded is None or not uploaded.filename:
            return jsonify({"error": "请选择待标注文件"}), 400
        original = Path(uploaded.filename)
        suffix = original.suffix.lower()
        if suffix not in ALLOWED_SUFFIXES:
            return jsonify({"error": "仅支持 .json、.jsonl、.xlsx、.xls 文件"}), 400
        filename = f"{secure_filename(original.stem) or 'upload'}{suffix}"

        workspace_id = uuid.uuid4().hex
        root = Path(tempfile.gettempdir()) / "annotation-tool" / workspace_id
        root.mkdir(parents=True, exist_ok=False)
        source_path = root / filename
        uploaded.save(source_path)
        try:
            new_dataset = load_data(source_path)
            new_template, new_template_path = load_or_create_template(new_dataset)
            sync_state = {
                "dataset": new_dataset,
                "template": new_template,
                "template_path": new_template_path,
                "root": root,
                "lock": threading.RLock(),
            }
        except Exception as exc:
            shutil.rmtree(root, ignore_errors=True)
            return jsonify({"error": f"文件解析失败：{exc}"}), 400

        old_id = session.get("workspace_id")
        with workspace_lock:
            old_state = workspaces.pop(old_id, None) if old_id else None
            workspaces[workspace_id] = sync_state
        if old_state:
            shutil.rmtree(old_state["root"], ignore_errors=True)
        session["workspace_id"] = workspace_id
        return jsonify({"ok": True, "filename": filename, "rows": len(new_dataset.rows)})

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
        body = request.get_json(silent=True) or {}
        action = body.get("action")
        source_path = dataset.path
        if action == "restart":
            new_dataset = load_data(source_path)
        elif action == "resume":
            name = body.get("name")
            selected = next(
                (p for p in output_versions_for(source_path) if p.name == name),
                None,
            )
            if selected is None:
                return jsonify({"error": "所选存档不存在或不属于当前原始文件"}), 404
            new_dataset = load_data(selected, source_path=source_path)
        else:
            return jsonify({"error": "action 必须是 restart 或 resume"}), 400
        new_template, new_template_path = load_or_create_template(new_dataset)
        set_workspace_value("dataset", new_dataset)
        set_workspace_value("template", new_template)
        set_workspace_value("template_path", new_template_path)
        return jsonify({
            "ok": True,
            "data_path": str(dataset.path),
            "working_path": str(dataset.working_path) if dataset.working_path else None,
        })

    # ---------------- 模版 ----------------

    @app.get("/api/template")
    def get_template():
        return jsonify(dict(template))

    @app.get("/api/templates")
    def list_templates():
        default_path = template_path_for(dataset)
        return jsonify({
            "current": current_template_path.name,
            "default": default_path.name,
            "templates": [
                template_info(p, current_template_path, default_path)
                for p in available_template_files()
            ],
        })

    @app.post("/api/template/upload")
    def upload_template():
        uploaded = request.files.get("file")
        if uploaded is None or not uploaded.filename:
            return jsonify({"error": "请选择模版 JSON 文件"}), 400
        filename = normalize_template_name(Path(uploaded.filename).name)
        if filename is None:
            return jsonify({"error": "模版文件名不合法；请使用 .json 或 .template.json"}), 400
        try:
            body = json.loads(uploaded.read().decode("utf-8-sig"))
        except (UnicodeDecodeError, json.JSONDecodeError) as e:
            return jsonify({"error": f"模版不是合法的 UTF-8 JSON：{e}"}), 400
        err = validate_template(body)
        if err:
            return jsonify({"error": f"模版校验失败：{err}"}), 400

        selected = normalize_template(body)
        local_path = workspace()["root"] / filename
        save_template(selected, local_path)
        set_workspace_value("template", selected)
        set_workspace_value("template_path", local_path)
        filled = sync_template_keys_to_rows(selected)
        saved_path = str(persist()) if filled > 0 and template.get("save_mode") == "auto" else None
        return jsonify({
            "ok": True,
            "name": filename,
            "template_path": str(local_path),
            "template": dict(template),
            "filled_count": filled,
            "auto_saved_path": saved_path,
        })

    @app.put("/api/template")
    def put_template():
        body = request.get_json(silent=True)
        err = validate_template(body)
        if err:
            return jsonify({"error": err}), 400
        new_template = normalize_template(body)
        set_workspace_value("template", new_template)
        filled = sync_template_keys_to_rows(new_template)
        path = save_template(new_template, workspace()["template_path"])
        saved_path = str(persist()) if filled > 0 and template.get("save_mode") == "auto" else None
        return jsonify({
            "ok": True,
            "template_path": str(path),
            "filled_count": filled,
            "auto_saved_path": saved_path,
        })

    @app.post("/api/template/select")
    def select_template():
        body = request.get_json(silent=True) or {}
        path = available_template_path(body.get("name"))
        if path is None:
            return jsonify({"error": "模版不存在"}), 404
        try:
            selected = load_template_file(path)
        except (json.JSONDecodeError, ValueError) as e:
            return jsonify({"error": f"模版文件不合法: {e}"}), 400
        local_path = workspace()["root"] / path.name
        set_workspace_value("template", selected)
        set_workspace_value("template_path", local_path)
        save_template(selected, local_path)
        filled = sync_template_keys_to_rows(selected)
        saved_path = str(persist()) if filled > 0 and template.get("save_mode") == "auto" else None
        return jsonify({
            "ok": True,
            "template_path": str(path),
            "template": dict(template),
            "filled_count": filled,
            "auto_saved_path": saved_path,
        })

    @app.post("/api/template/generate")
    def regenerate_template():
        new_template = normalize_template(generate_template(dataset))
        set_workspace_value("template", new_template)
        filled = sync_template_keys_to_rows(new_template)
        path = save_template(new_template, workspace()["template_path"])
        saved_path = str(persist()) if filled > 0 and template.get("save_mode") == "auto" else None
        return jsonify({
            "ok": True,
            "template_path": str(path),
            "template": dict(template),
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
                if not matches_filter(get_path(row, key), expected, filter_specs[key]):
                    return False
            if q:
                keys = search_fields if search_fields else list(row.keys())
                blob = "\n".join(
                    v if isinstance(v, str) else json.dumps(v, ensure_ascii=False)
                    for k in keys
                    for v in [get_path(row, k)]
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
            if not has_path(row, k) or get_path(row, k) != v:
                if set_path(row, k, v):
                    changed = True
        for k in deletes:
            if isinstance(k, str) and delete_path(row, k):
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

    # ---------------- 存盘 ----------------

    @app.post("/api/save")
    def save():
        out_path = persist()
        return send_file(
            out_path,
            as_attachment=True,
            download_name=out_path.name,
        )

    # ---------------- 模型推理 ----------------

    @app.get("/api/infer/config")
    def infer_config():
        return jsonify({
            "modes": {
                name: {
                    "label": cfg["label"],
                    "model": cfg["model"],
                    "base_url": cfg["base_url"],
                    "temperature": cfg["temperature"],
                    "api_key_env": cfg["api_key_env"],
                    "api_key_set": bool(
                        cfg["api_key_env"] and os.environ.get(cfg["api_key_env"])
                    ),
                }
                for name, cfg in INFER_MODES.items()
            },
        })

    @app.post("/api/infer")
    def run_infer():
        body = request.get_json(silent=True) or {}
        mode = body.get("mode")
        if mode not in INFER_MODES:
            return jsonify({"error": f"mode 必须是 {sorted(INFER_MODES)} 之一"}), 400
        defaults = INFER_MODES[mode]

        model = body.get("model") or defaults["model"]
        base_url = body.get("base_url") or defaults["base_url"]
        if not isinstance(model, str) or not isinstance(base_url, str):
            return jsonify({"error": "model / base_url 必须是字符串"}), 400
        try:
            temperature = float(body.get("temperature", defaults["temperature"]))
        except (TypeError, ValueError):
            return jsonify({"error": "temperature 必须是数字"}), 400

        system_prompt = body.get("system_prompt") or ""
        user_prompt = body.get("user_prompt") or ""
        if not isinstance(system_prompt, str) or not isinstance(user_prompt, str):
            return jsonify({"error": "system_prompt / user_prompt 必须是字符串"}), 400
        if not user_prompt.strip():
            return jsonify({"error": "用户提示词不能为空"}), 400

        started = _now_ms()
        try:
            response = infer_chat(
                mode, model.strip(), base_url.strip(), temperature,
                system_prompt, user_prompt,
            )
        except Exception as e:
            return jsonify({"error": f"推理失败：{e}"}), 502
        return jsonify({
            "ok": True,
            "mode": mode,
            "model": model.strip(),
            "base_url": base_url.strip(),
            "response": response,
            "elapsed_ms": _now_ms() - started,
        })

    return app


_load_dotenv(APP_DIR / ".env")
app = make_app()

if __name__ == "__main__":
    app.run(host="127.0.0.1", port=5177, debug=True)
