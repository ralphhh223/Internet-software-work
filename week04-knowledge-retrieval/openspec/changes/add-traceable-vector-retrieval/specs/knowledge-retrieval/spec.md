# 规约变更：knowledge-retrieval

本文件为 `add-traceable-vector-retrieval` 变更相对于 `knowledge-retrieval` 规约的增量。
所有条目均为新增（ADDED），不修改既有 Requirement。

---

## ADDED Requirements

### Requirement: 材料切分写入切片表

系统 SHALL 在材料上传成功后，将知识库正文 `knowledge_entries.body_text` 切分为若干
切片并写入 `knowledge_chunks` 表。每条切片 SHALL 至少包含切片正文 `chunk_text`、切片
序号 `chunk_index`、在待切分文本中的字符偏移，以及所属 `class_id`、`material_id`、
`knowledge_entry_id`、`index_status`。

切分模块 SHALL NOT 改写 `knowledge_entries.body_text`，SHALL NOT 调用嵌入服务，
SHALL NOT 写入向量库。

#### Scenario: 上传后生成切片

- **WHEN** 教师成功上传一份材料
- **THEN** 该材料对应的 `knowledge_entries.body_text` 被切分为一条或以上切片
- **AND** 每条切片在 `knowledge_chunks` 中有一行记录，且 `chunk_index` 从 0 起连续
- **AND** `knowledge_entries.body_text` 与上传原文逐字一致

#### Scenario: 种子材料启动时补齐索引

- **WHEN** 服务启动且存在尚未建立索引的种子材料
- **THEN** 系统对这些材料按 `auto` 策略切分并建立索引

---

### Requirement: 提供三种切分策略

系统 SHALL 提供 `auto`、`custom`、`hierarchy` 三种切分策略。未指定策略时 SHALL 按
`auto` 处理。

- `auto`：最大 800 字，重叠 80 字；优先在空行、换行、句号处断开；请求中另行填写的
  长度与预处理参数不生效。
- `custom`：最大长度 100–2000 字，重叠比例 0%–50%；无断点处按最大长度强制截断；可预先
  移除 URL 与邮箱，或将连续空白折叠为单个空格。
- `hierarchy`：按 Markdown 的 `#`、`##`、`###` 层级分章，标题保留在该章切片内；某章
  超过最大长度时，再按 `auto` 规则二次切分。

#### Scenario: 未指定策略

- **WHEN** 调用方请求切分但未指定策略
- **THEN** 系统按 `auto` 策略切分，切片长度不超过 800 字、相邻切片重叠 80 字

#### Scenario: 自定义策略参数越界

- **WHEN** 调用方以 `custom` 策略传入最大长度 5000 字
- **THEN** 系统拒绝该参数（返回 400），不产生切片

#### Scenario: 标题策略保留标题

- **WHEN** 以 `hierarchy` 策略切分一份含 `## 第二章` 的 Markdown 材料
- **THEN** `## 第二章` 及其正文出现在同一条切片内

#### Scenario: 预处理不改写原文

- **WHEN** 以开启「移除 URL」的 `custom` 策略切分
- **THEN** 切片正文中不含 URL
- **AND** `knowledge_entries.body_text` 中该 URL 仍然存在

---

### Requirement: 切片正文存于关系库、向量存于向量库

系统 SHALL 将切片正文保存在 MySQL 的 `knowledge_chunks.chunk_text`，SHALL 将向量保存
在 Qdrant 集合 `campusclaw_chunks`（余弦度量）。Qdrant 中的 `payload` SHALL 仅包含
`class_id`、`material_id`、`knowledge_entry_id`、`chunk_id`、`chunk_index`，
SHALL NOT 包含切片正文。

向量主键 SHALL 等于 `knowledge_chunks.id`，且等于 `payload.chunk_id`。

#### Scenario: 两侧数据形态

- **WHEN** 取任意一条切片对照两侧存储
- **THEN** MySQL 中存在该切片的 `chunk_text` 与字符偏移
- **AND** Qdrant 中该点的 payload 不包含任何正文文本
- **AND** 向量主键、`knowledge_chunks.id`、`payload.chunk_id` 三者相等

#### Scenario: 嵌入失败不影响原文

- **WHEN** 某切片的嵌入调用失败
- **THEN** 该切片的 `index_status` 为 `failed`
- **AND** 材料记录与 `body_text` 仍然保留
- **AND** Qdrant 中不存在该切片的向量点

#### Scenario: 摘录来源

- **WHEN** 任意检索模式返回命中结果
- **THEN** 结果中的摘录文本取自 MySQL 的 `chunk_text`，而非向量库

---

### Requirement: 提供三种检索模式

系统 SHALL 提供 `keyword`、`vector`、`hybrid` 三种检索模式，默认 SHALL 为 `hybrid`。
检索接口 SHALL 接受模式参数并据此选择路径。

- `keyword` SHALL 仅查询 MySQL 全文索引（`FULLTEXT ... WITH PARSER ngram`），
  SHALL NOT 调用嵌入服务，SHALL NOT 访问 Qdrant；结果按全文相关度由高到低排序。
- `vector` SHALL 先将问句嵌入，再在 Qdrant 中按班级过滤检索，余弦相似度低于 0.35 的
  候选 SHALL 被丢弃，随后以向量主键回 MySQL 取回正文；结果按余弦相似度由高到低排序。
- `hybrid` SHALL 同时执行上述两条路径，各路独立过滤后按名次执行 RRF
  （`k = 60`）；缺席的一路 SHALL NOT 贡献分数。

#### Scenario: 关键字命中且不产生问句向量

- **WHEN** 以原词发起 `keyword` 检索
- **THEN** 返回包含该词的切片
- **AND** 响应中不含问句向量，且未调用嵌入服务

#### Scenario: 同义改写命中向量路径

- **WHEN** 以同义改写发起 `keyword` 检索，再以同一句发起 `vector` 检索
- **THEN** `keyword` 路径无命中或命中明显偏少
- **AND** `vector` 路径仍可返回语义相近的切片

#### Scenario: 低相似度候选被丢弃

- **WHEN** `vector` 检索返回的候选余弦相似度为 0.20
- **THEN** 该候选不出现在最终 `hits` 中

#### Scenario: 混合融合按名次而非分数

- **WHEN** `hybrid` 检索中两条路径给出的分数尺度不同
- **THEN** 系统按两路各自的名次执行 RRF（`k = 60`）融合
- **AND** 两路均命中的切片排序更靠前

#### Scenario: 默认模式

- **WHEN** 调用检索接口但未指定 `mode`
- **THEN** 系统以 `hybrid` 模式执行

---

### Requirement: 检索结果可回溯至原文

每条命中结果 SHALL 至少包含材料标题、切片序号 `chunk_index`、字符区间与一段摘录，
并 SHALL 支持打开对应材料。

#### Scenario: 命中结果字段完整

- **WHEN** 检索返回一条命中
- **THEN** 该命中包含材料标题、切片序号、在原文中的字符区间与摘录
- **AND** 可依据该命中定位并打开对应材料

#### Scenario: 无相关内容不凑数

- **WHEN** 提问内容与本班材料无关，所选模式过滤后无候选切片
- **THEN** 响应为 HTTP 200
- **AND** `hits` 为空，正文为「资料中未找到相关内容」
- **AND** 系统不以相关度明显偏低的切片填充结果

---

### Requirement: 问答接口先检索再生成

系统 SHALL 提供 `POST /api/ask`。该接口 SHALL 仅以用户最新一句提问发起本班混合检索，
取前 4 条切片。

- 存在命中切片时，SHALL 将材料标题、切片序号与切片正文连同用户提问交给对话网关，
  回答正文 SHALL 以 `[1]`、`[2]` 标注出处，且标注顺序 SHALL 与 `citations` 列表一致。
- 不存在命中切片时，SHALL 直接返回「资料中未找到相关内容」，`citations` SHALL 为空，
  且 SHALL NOT 调用对话网关。
- 客户端传入的 `system` 消息 SHALL 被丢弃；`system` 提示由服务端写入。
- 本课 SHALL NOT 实现流式输出。

#### Scenario: 有依据时调用生成模型

- **WHEN** 本班材料中确有针对该问题的依据
- **THEN** 回答正文中出现 `[1]`、`[2]` 标注
- **AND** 标注顺序与 `citations` 列表顺序一致

#### Scenario: 无依据时不调用生成模型

- **WHEN** 提问为材料中不可能出现的内容（如天气、比分）
- **THEN** 响应为 HTTP 200，正文为「资料中未找到相关内容」
- **AND** `citations` 为空
- **AND** 对话网关未被调用

#### Scenario: 丢弃客户端注入的 system 消息

- **WHEN** 请求体中携带 `role: system` 的消息
- **THEN** 该消息不进入交给对话网关的输入
- **AND** 对话模块收到的 `system` 提示完全由服务端生成

#### Scenario: 对话模块看不到的内容

- **WHEN** 检索命中并调用对话网关
- **THEN** 交给对话模块的内容仅含材料标题、切片序号、切片正文与用户提问
- **AND** 不含向量分量、不含 Qdrant 原始点数据、不含其他班级的切片

---

### Requirement: 班级标识仅取自会话

检索接口 SHALL 仅从登录会话读取 `class_id`。请求体、查询字符串或请求头中另行携带的
班级编号，在解析后 SHALL 被丢弃。

#### Scenario: 请求体中的 class_id 无效

- **WHEN** 以 A 班会话发起检索，并在请求体中写入 B 班的 `class_id`
- **THEN** 实际过滤条件仍为 A 班
- **AND** 结果中不出现 B 班的切片

---

### Requirement: 两条检索路径均须按班级过滤

`keyword` 路径 SHALL 在 MySQL 查询条件中包含 `class_id = 会话班级`，且 SHALL 仅检索
`index_status = ready` 的切片。

`vector` 路径 SHALL 在 Qdrant 查询中携带 `class_id` 过滤；取得向量主键后，SHALL 以同一
班级条件回 MySQL 取回正文；SHALL NOT 仅凭 payload 中的编号作为正文来源。

#### Scenario: 向量路径回表时再次核对班级

- **WHEN** 向量库未加班级过滤而返回了其他班级的向量主键
- **THEN** 回表查询以会话班级为条件
- **AND** 其他班级的切片不出现在结果中

#### Scenario: 未就绪切片不参与关键字检索

- **WHEN** 某切片 `index_status` 为 `failed`
- **THEN** `keyword` 检索不返回该切片

---

### Requirement: 跨班级检索对外表现为无命中

跨班级检索 SHALL 返回 HTTP 200 与空命中列表，SHALL NOT 以 403 或 404 向调用方暗示
该资料属于其他班级。

按材料标识打开详情 SHALL 沿用既有规则：跨班级与不存在均返回 404。

#### Scenario: 跨班级检索无命中

- **WHEN** 以 A 班会话检索一个仅出现在 B 班正文中的词
- **THEN** 响应为 HTTP 200
- **AND** `hits` 为空
- **AND** 问答接口返回固定文案

#### Scenario: 跨班级材料详情为 404

- **WHEN** 以 A 班会话请求打开 B 班的材料详情
- **THEN** 响应为 HTTP 404
- **AND** 与请求一个不存在的材料标识所得到的响应一致

---

### Requirement: 向量库不可用时降级

Qdrant 不可用时，`keyword` 模式 SHALL 仍可返回结果；`vector` 与 `hybrid` 模式 SHALL 返回
HTTP 503，且 SHALL NOT 编造相似度分数。

#### Scenario: 停止向量库后关键字仍可用

- **WHEN** Qdrant 停止服务，以 `keyword` 模式发起检索
- **THEN** 响应为 HTTP 200 且返回 MySQL 中的切片正文

#### Scenario: 停止向量库后向量模式 503

- **WHEN** Qdrant 停止服务，以 `vector` 或 `hybrid` 模式发起检索
- **THEN** 响应为 HTTP 503

---

### Requirement: 空查询与无效参数处理

查询内容为空或仅含空白字符时，系统 SHALL 返回 HTTP 400。

#### Scenario: 空查询

- **WHEN** 调用检索接口并传入空字符串查询
- **THEN** 响应为 HTTP 400

---

### Requirement: 支持显式重建索引

教师 SHALL 能够对已入库材料显式重建索引。重建 SHALL 先删除旧切片与旧向量记录，
再按本次请求中的策略重新切分、嵌入并写入。已入库材料 SHALL NOT 自动重新切分。

#### Scenario: 重建使用本次策略

- **WHEN** 教师以 `hierarchy` 策略对一份原本以 `auto` 切分的材料重建索引
- **THEN** 旧切片与旧向量被删除
- **AND** 新切片按 `hierarchy` 策略生成

#### Scenario: 未重建则旧切片保留

- **WHEN** 材料上传后未执行重建索引
- **THEN** 原有切片与向量保持不变

#### Scenario: 重建后无过期主键残留

- **WHEN** 重建索引完成
- **THEN** Qdrant 中不存在指向已删除切片的向量主键

#### Scenario: 非教师角色不得重建

- **WHEN** 以学生角色调用重建索引接口
- **THEN** 响应为 HTTP 403，且不产生任何切片变更

---

## 附：本课不实现的项

- 交叉编码器重排序（rerank）
- 流式输出
- 编排框架（LangChain／LlamaIndex／Dify 一类）
- Qdrant 端口对外暴露
