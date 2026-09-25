# 通用标注平台

一个模版驱动的通用标注工具：加载 `.jsonl` / `.json` / `.xlsx` / `.xls`，自动解析字段并推断控件；左侧是 case 列表，右侧是标注工作区。  
当前版本支持：浏览器上传、模版复用、临时会话续标、自动/手动保存、结果下载和可选模型验证流程。各浏览器会话使用独立的临时工作区；服务重启后临时数据可能消失，因此请及时下载结果。

## 本地运行

```bash
python -m venv .venv
source .venv/bin/activate        # Windows: .\.venv\Scripts\activate
pip install -r requirements.txt

python server.py
```

浏览器打开：`http://127.0.0.1:5177/`

在页面选择本机的 `.jsonl`、`.json`、`.xlsx` 或 `.xls` 文件并上传。页面初始化时，如果当前临时会话有历史存档，会让你选择重新开始或继续标注。

- `0` 重新开始（从原始文件载入）
- `1..N` 继续某次历史标注存档

## Render 部署

1. 将仓库 push 到 GitHub。
2. 在 Render 选择 **New > Blueprint** 并连接仓库；根目录的 `render.yaml` 会创建 Web Service。也可手动创建 Web Service。
3. Build Command：`pip install -r requirements.txt`
4. Start Command：`gunicorn server:app --workers 1 --threads 4 --timeout 120`
5. 设置 `SECRET_KEY` 为随机长字符串（Blueprint 会自动生成）。仅在启用远程模型验证时另设 `OPENAI_API_KEY`。
6. 部署成功后访问 Render 提供的公网 URL。标注者只需要浏览器，无需安装本项目。

Flask app 的 import path 是 `server:app`。单 worker 是有意设置：会话索引保存在进程内，而实际上传和结果文件位于 Render 的临时目录；线程可处理并发请求。应用不依赖持久化磁盘，实例重启会清空状态。

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

平台支持通用的 `repeatable` 可重复子项控件：子项字段、编号、排序、动态选项和同组关系均由模版声明。模版还可通过 `match.required_fields` 声明适用的数据结构，实现按字段自动匹配，而无需在平台代码中硬编码任务类型。

嵌套对象会展开为路径 key（如 `meta.author.name`）进行展示与编辑。

## 模版系统（`annotation_templates/*.template.json`）

默认模版文件名：`<数据文件名去后缀>.template.json`。  
模版保存了字段配置、列表展示、筛选配置、存盘模式、模型验证配置等信息，可复用/归档。

在页面「模版设置」中可以：

- 选择已有模版并套用（跨数据复用）
- 从本机上传 `.json` / `.template.json` 模版；校验成功后立即套用并加入当前会话模版库
- 在模版字段列表中新增、删除或配置字段，并保存当前模版
- 重新解析字段（覆盖当前模版）
- 拖拽调整字段顺序
- 配置字段属性：`label`、`hint`、`widget`、`rows`、`editable`、`hidden`、`group`、`filterable`、`options`
- 配置左侧列表展示字段（标题/副标题/标签）
- 切换存盘模式（`manual` / `auto`）
- 启用或关闭模型验证（`infer_enabled`）

> 说明：旧模版中的 `side_by_side` 会自动迁移为 `group` 并列组配置。

### 可重复子项（`repeatable`）

`repeatable` 用于一条记录中数量不固定、结构相同的子项，例如事件、实体、审核意见或其他子记录。模版通过 `item_fields` 定义子项表单，支持：

- 模版设置中提供可视化配置器，可分别维护基础设置、子字段和流程步骤，无需直接编辑 JSON

- `text`、`textarea`、`number`、`checkbox`、`select`、`multiselect`
- `cascader`：把内嵌的完整路径逐级展示为多个下拉选择
- `checkbox_group`：以复选框组展示静态或动态选项，选项较多时支持搜索过滤
- `self_multiselect`：引用同一组的其他子项，可配置 `acyclic=true` 检查循环关系
- `options`：模版内静态选项
- `options_from_path`：从当前数据行的数组或对象动态生成选项；对象默认取 key，配置 `options_from_object: "entries"` 后会展示并保存“key + value”完整内容
- `options_source`：从项目内逐行文本、JSON 数组或编号缩进树加载选项
- 自动编号、必填提示、删除及引用清理；仅在 `track_order=true` 时记录和调整人工顺序
- `steps`：按流程把同一批子项的字段分到多个步骤中集中标注
- 步骤可配置 `view: "graph"` 和 `relation_field`，用可拖拽点边图维护依赖边；关闭顺序记录后，拖动仅调整图上位置
- 步骤可配置 `group_by_relation`，按依赖关系的连通组及拓扑层级展示相关子项

`collection_cards` 控件可把对象或数组的每个元素显示为独立、可折叠的小卡片，适合展示结构化来源材料；卡片标题和内部字段由模版配置。

模版可配置 `match.required_fields` 和 `match.priority`。上传数据后，平台按字段结构选择最具体、优先级最高的匹配模版；匹配逻辑与具体业务无关。

## 标注流程

- 左侧列表支持：
  - 全文搜索
  - 按“已修改/未修改”筛选
  - 按模版中 `filterable=true` 的字段组合筛选
  - 分页与侧栏收起
- 右侧工作区支持：
  - 自动将 `editable=false` 的字段放入只读资料区，将可编辑字段放入标注区；两栏可独立滚动
  - 编辑当前记录字段值
  - 删除字段
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

所有中间文件都输出到当前浏览器会话在系统临时目录中的工作区，文件名形如：

`<原始文件名去后缀>_YYYYMMDD_HHMMSS_ffffff<原后缀>`

- 不覆盖原始数据文件
- 手动模式：点击“保存到文件”时写盘
- 自动模式：字段修改后自动写盘
- 点击“下载结果”将结果下载回用户电脑
- 临时工作区不是持久存储，服务重启后不会保留
