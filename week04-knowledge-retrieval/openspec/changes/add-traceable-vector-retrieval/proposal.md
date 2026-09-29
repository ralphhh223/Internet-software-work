# 变更提案：add-traceable-vector-retrieval

## 为什么

第 3 课已经完成登录鉴权、按班级隔离与教研材料入库：材料文件落盘、正文写入
`knowledge_entries.body_text`，前端可以按班级列出材料并下载。

但资料目前只能"看"，不能"问"。学生要在一份几十页的讲义里找某个知识点，只能自己
翻。把整份材料塞给大模型也不成立：模型参数里并不包含本校讲义，却仍会把没见过的问题
答得煞有介事，而且回答无法回溯到原文的哪一句。

因此需要在本班材料范围内增加检索能力：

1. 用一句自然语言定位到本班材料中的相关片段，而不是靠关键词肉眼翻找；
2. 每条命中都能说清"来自哪份材料的哪一个切片、对应原文哪一段字符"；
3. 资料中确实没有依据时，明确回答"未找到"，不得以低相关度切片凑数，也不得让生成
   模型凭记忆编造。

第 3 课的认证模块、角色校验与上传入库链路在本课直接沿用，不做重做。

## 变更内容

### 1. 新增切分（chunking）环节

上传成功后，将 `knowledge_entries.body_text` 切分为若干切片，写入新表
`knowledge_chunks`。支持三种策略：

- `auto`：最大 800 字、重叠 80 字（约 10%），优先在空行、换行、句号处断开；未指定
  策略时的默认值，种子材料启动补齐索引同样使用该策略。
- `custom`：最大长度 100–2000 字、重叠比例 0%–50%，无断点处按最大长度强制截断；可选
  移除 URL／邮箱，或将连续空白折叠为单个空格。
- `hierarchy`：按 Markdown 的 `#`、`##`、`###` 层级分章，标题保留在该章切片内；某章
  过长时再按自动窗口规则二次切分。

切分模块**不改写** `body_text`，也不调用嵌入服务、不写向量库。

### 2. 新增向量嵌入与向量库存储

每个切片经嵌入网关转换为一条定长浮点向量，写入 Qdrant（集合
`campusclaw_chunks`，度量方式为余弦）。

- **切片正文保留在 MySQL**，Qdrant 中只存向量与几个标识字段；
- Qdrant 的 `payload` 仅含 `class_id`、`material_id`、`knowledge_entry_id`、
  `chunk_id`、`chunk_index`，**不含正文**；
- **向量主键 = `knowledge_chunks.id` = `payload.chunk_id`**，三者一致，回表查询无需映射表；
- 嵌入失败时材料记录仍然保留，对应切片标记为 `failed`，不写入残缺向量。

### 3. 新增三种检索模式

| 模式 | 访问的组件 | 排序依据 |
|---|---|---|
| `keyword` | 仅 MySQL 全文索引（`FULLTEXT ... WITH PARSER ngram`，token 长度 2） | 全文相关度由高到低 |
| `vector` | 问句嵌入 → Qdrant 按 `class_id` 过滤 → 向量主键回 MySQL 取正文 | 余弦相似度由高到低，低于 0.35 的候选丢弃 |
| `hybrid` | 同时执行上述两条路径 | 各路先过滤，再按名次执行 RRF（`k = 60`） |

`hybrid` 融合的是**名次**而非分数，缺席的一路不贡献分数。**默认使用 `hybrid`。**

### 4. 新增问答接口 `POST /api/ask`

- 仅以用户**最新一句**提问发起本班混合检索，取前 **4 条**切片；
- 有命中切片 → 将材料标题、切片序号、切片正文交给对话网关，回答正文以 `[1]`、`[2]`
  标注出处，与 `citations` 列表顺序一致；
- **无命中切片 → 直接返回「资料中未找到相关内容」，`citations` 为空，不调用对话网关**；
- 客户端注入的 `system` 消息一律丢弃，`system` 提示由服务端写入；
- 本课不实现流式输出（留待第 5 课）。

### 5. 检索侧的班级隔离

- 班级标识**仅取自登录会话**；请求体、查询字符串或请求头中携带的 `class_id`
  在解析后一律丢弃；
- `keyword` 与 `vector` **两条路径都必须**按会话班级过滤，且 `keyword` 路径只检索
  `index_status = ready` 的切片；
- 向量路径**回 MySQL 取正文时再次核对班级**——即便向量库漏加过滤，回表仍应排除他班记录；
- **跨班级检索对外表现为无命中**：HTTP 200 + 空 `hits`，不得以 403／404 泄露"该资料
  属于其他班级"。按材料标识打开详情仍沿用第 3 课规则：跨班级与不存在统一返回 404。

### 6. 新增索引重建能力

已入库材料**不会自动重新切分**。教师可按新策略显式重建索引：先删除旧切片与旧向量
记录，再按**本次请求中的策略**重新切分、嵌入、写入。

### 7. 降级与错误约定

| 情形 | 行为 |
|---|---|
| 空查询 | HTTP 400 |
| Qdrant 不可用 | `keyword` 仍正常返回；`vector`／`hybrid` 返回 HTTP 503，不编造相似度分数 |
| 嵌入服务失败 | 材料保留，切片标 `failed`；该批切片不参与向量检索 |
| 检索无候选 | HTTP 200 + 空 `hits` + 固定文案 |

## 影响

### 新增数据

- 表 `knowledge_entries`（知识库条目，含 `body_text`、`class_id`、`index_status`）
- 表 `knowledge_chunks`（切片，含 `chunk_text`、`chunk_index`、字符偏移、`index_status`、
  `class_id`、`material_id`、`knowledge_entry_id`）
- 表 `knowledge_chunks` 上的全文索引（`chunk_text`，`WITH PARSER ngram`）
- Qdrant 集合 `campusclaw_chunks`（余弦度量）

### 新增外部依赖

- **Qdrant**（compose 中的服务，不对宿主暴露端口）
- **嵌入网关**（兼容 OpenAI `/embeddings` 接口，仅服务端调用）
- **对话网关**（仅在已取得切片之后调用）

三类依赖的密钥均**不下发到浏览器**，客户端无法直连。

### 受影响的接口

| 接口 | 变化 |
|---|---|
| `POST /api/ask` | 新增 |
| `GET /api/search`（或 `POST /api/retrieval/search`） | 新增，支持 `mode` 参数 |
| `POST /api/materials/:id/reindex` | 新增，教师角色 |
| 材料上传接口 | 上传成功后追加切分／嵌入／写入向量四个步骤 |
| 材料详情接口 | 沿用第 3 课跨班级 404 规则，不变 |

### 不受影响

- 现有 `courses` / `teachers` / `sessions` / `course_files` 四张表及其接口
- 登录、登出、会话 Cookie、统一鉴权网关
- 第 3 课的上传白名单、大小限制、随机文件名与下载接口
- 现有前端「课程表 / 班级材料」两个标签页

### 对照现有代码：变更落在哪里

本项目当前是「零第三方依赖的 Node 单进程 + 可选 Docker 双容器」。本课要在其上追加
检索能力，改动点与**不动点**如下（行号对应当前 `server.js`）。

**新增（占本次改动绝大部分）**

| 位置 | 内容 |
|---|---|
| `server.js` 建表块（现 54–94 行之后） | 追加 `knowledge_entries`、`knowledge_chunks` 建表与索引 DDL |
| `server.js` 新增模块 | 切分模块（三策略）、嵌入客户端、Qdrant 客户端、检索模块（三模式 + RRF）、问答编排 |
| `server.js` HTTP 路由块（现 377 行鉴权块内） | 新增 `GET /api/search`、`POST /api/ask`、`POST /api/materials/:id/reindex` |
| `data/` | 新增 Qdrant 容器数据卷；MySQL 换成独立服务后 `courses.db` 的角色收窄 |
| `docker-compose.yml` | 新增 `qdrant` 服务（**无 `ports`，只有 `expose`**）、`mysql` 服务 |
| `deploy/nginx.conf` | 现有 `location /api/` 已能覆盖新接口，无需新增块 |
| `.env` / `.env.example` | 新增嵌入、对话网关地址与密钥，以及 Qdrant 连接参数 |
| `index.html` / `app.js` | 新增检索视图与问答视图（第三个标签页） |

**复用（不改）**

| 位置 | 为什么能直接复用 |
|---|---|
| `currentTeacher(req)`（300–307 行） | 已经能从 Cookie 反查出 `{id, username, name}`，检索侧只要再取一次 `class_id` 即可 |
| 统一鉴权块（377–379 行） | 新接口写在 `if (p.startsWith('/api/'))` 之内就自动受保护 |
| `ensureColumn()`（97–100 行） | 后续若要给老库补字段，沿用这条路，不删库重建 |
| 上传接口（419–458 行） | 只在其成功返回**之前**串上「切分 → 嵌入 → 写 Qdrant」，白名单与限额逻辑一行不动 |
| `course_files` 表 | 作为材料主表继续使用；`knowledge_entries.material_id` 指向它的 `id` |

**需要注意的一处口径差异**

课题给出的参考实现是 **Go + MySQL + Qdrant**，而本项目当前是 **Node + SQLite**。
规约（`specs/knowledge-retrieval/spec.md`）写的是**行为契约**——班级隔离、三种模式、
SQL 级过滤、RRF `k=60`、无依据不调模型——这些与语言无关。真正需要做的替换是：

- **SQLite → MySQL**：因为要用 `FULLTEXT ... WITH PARSER ngram`（SQLite 没有等价能力，
  FTS5 的分词与 `ngram` 语义不同）；
- **新增 Qdrant**：SQLite 没有向量检索能力。

若课程环境已提供 MySQL，则按课题实现；若沿用本项目现有形态，需要明确 Qdrant 对 SQLite
场景的替代关系（向量仍必须在独立向量库中，SQLite 不承担该职责）。

### 风险

1. **重复正文**：若为图省事把 `chunk_text` 写进 Qdrant payload，正文将存在两份副本，且
   摘录可能取自向量库而与 MySQL 不一致。本课明确要求摘录**始终取自 MySQL 的
   `chunk_text`**。
2. **单侧过滤**：只在 MySQL 或只在 Qdrant 加班级条件都不安全，必须两侧都加并在回表时
   再核对一次。
3. **Qdrant 端口暴露**：为调试方便把 Qdrant 端口映射到宿主，客户端即可绕过认证直连。
   Qdrant 不得对外暴露端口。
4. **切换策略未重建**：改了策略但未重建索引，旧切片与旧向量仍在，检索结果与预期不符。
   若曾将连续空白折叠为空格，则换行符不复存在，再以换行作分隔符将无法切分。
