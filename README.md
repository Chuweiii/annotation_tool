# 通用标注平台（本地网页）

一个模版驱动的通用标注工具：加载 `.jsonl` / `.json` / `.xlsx` / `.xls`，自动解析字段并推断控件；左侧是 case 列表，右侧是标注工作区。  
当前版本支持：模版复用、会话续标（历史存档选择）、自动/手动存盘、可选模型验证流程。

## 运行

```bash
python -m venv .venv
source .venv/bin/activate        # Windows: .\.venv\Scripts\activate
pip install -r requirements.txt

# 三种指定数据文件方式（任选其一）
python server.py path/to/data.jsonl
ANNOTATION_DATA_PATH=path/to/data.xlsx python server.py
python server.py                  # 自动选择项目目录下最近修改的数据文件
```

浏览器打开：`http://127.0.0.1:5177/`

不显式指定文件时，后端会在项目根目录自动选择最新的 `.jsonl/.json/.xlsx/.xls`。  
页面初始化时，如果 `output/` 下存在该原始文件的历史存档，会弹窗让你选择：

- `0` 重新开始（从原始文件载入）
- `1..N` 继续某次历史标注存档

## 输入格式与字段解析

- `.jsonl`：每行一个 JSON 对象
- `.json`：单个对象，或对象数组
- `.xlsx/.xls`：按表头读成对象数组（需要 `pandas + openpyxl`）

首次加载某个数据文件时，会扫描全部数据并生成默认模版。控件推断规则：

| 数据特征 | 默认控件 |
| --- | --- |
| 全为布尔值 | `checkbox` |
| 全为数字 | `number` |
| 少量重复的短字符串 | `select`（自动收集选项） |
| 长文本或含换行 | `textarea` |
| 短字符串 | `text` |
| 对象/数组/混合类型 | `json` |

嵌套对象会展开为路径 key（如 `meta.author.name`）进行展示与编辑。

## 模版系统（`annotation_templates/*.template.json`）

默认模版文件名：`<数据文件名去后缀>.template.json`。  
模版保存了字段配置、列表展示、筛选配置、存盘模式、模型验证配置等信息，可复用/归档。

在页面「模版设置」中可以：

- 选择已有模版并套用（跨数据复用）
- 另存为新模版
- 重新解析字段（覆盖当前模版）
- 拖拽调整字段顺序
- 配置字段属性：`label`、`hint`、`widget`、`rows`、`editable`、`hidden`、`group`、`filterable`、`options`
- 配置左侧列表展示字段（标题/副标题/标签）
- 切换存盘模式（`manual` / `auto`）
- 启用或关闭模型验证（`infer_enabled`）

> 说明：旧模版中的 `side_by_side` 会自动迁移为 `group` 并列组配置。

## 标注流程

- 左侧列表支持：
  - 全文搜索
  - 按“已修改/未修改”筛选
  - 按模版中 `filterable=true` 的字段组合筛选
  - 分页与侧栏收起
- 右侧工作区支持：
  - 编辑当前记录字段值
  - 删除字段
  - `+ 新增字段`（可把新 key 全局补齐为 `null`）
  - `保存此条`
  - `← 上一条 / 下一条 →` 快捷切换（切换时自动保存当前条）

系统保留字段 `is_labelled`：

- 默认会自动补齐到模版与数据中
- 修改非 `is_labelled` 字段后会自动标记为已标注
- 可在工作区标题旁标签点击切换已标注状态

## 模型验证（可选）

启用 `infer_enabled` 后，工作区会显示“模型验证”区域。  
推理配置写在模版里（`infer`）：

- `mode`：`api`（远程 OpenAI 兼容接口）或 `local`（本地兼容服务）
- `model` / `base_url` / `temperature`
- `system_prompt` / `user_prompt`

提示词支持占位符：`{字段key}`，运行时会替换为当前记录值（支持嵌套路径）。

### API 模式环境变量

默认读取 `OPENAI_API_KEY`。可在项目根目录放 `.env` 文件，例如：

```env
OPENAI_API_KEY=your_key_here
```

## 输出与续标

所有写盘都输出到 `output/`，文件名形如：

`<原始文件名去后缀>_YYYYMMDD_HHMMSS_ffffff<原后缀>`

- 不覆盖原始数据文件
- 手动模式：点击“保存到文件”时写盘
- 自动模式：字段修改后自动写盘
- 下次启动会根据同源文件列出历史存档，可按需继续标注
