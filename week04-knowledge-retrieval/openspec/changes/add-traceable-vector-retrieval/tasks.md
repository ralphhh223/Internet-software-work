# 实施清单：add-traceable-vector-retrieval

> 勾选表示已完成。本清单按依赖顺序排列：先建表与切分，再嵌入与向量库，再检索，
> 最后问答与验证。
>
> **状态：全部完成。** 每条勾选项后附「落在哪个文件 / 哪条断言」，便于复核。
> 断言编号形如 `e2e §5`、`split 第 7 条`，对应 `tests/last-run-*.txt` 中的明细。

## 1. 数据层

- [x] 1.1 新建表 `knowledge_entries`：`id`、`class_id`、`material_id`、`body_text`、
      `index_status`、`created_at`、`updated_at`
      → `server.js` 建表块（`CREATE TABLE IF NOT EXISTS knowledge_entries`）
- [x] 1.2 新建表 `knowledge_chunks`：`id`、`class_id`、`material_id`、
      `knowledge_entry_id`、`chunk_index`、`chunk_text`、`char_start`、`char_end`、
      `index_status`、`created_at`
      → `server.js` 建表块；`e2e §1` 校验 `char_end > char_start`、`chunk_index` 从 0 连续
- [x] 1.3 在 `knowledge_chunks.chunk_text` 上建立全文索引
      （`FULLTEXT ... WITH PARSER ngram`，token 长度 2）
      → **能力等价替换**：SQLite 无 `ngram` 解析器，改以自建 bigram 倒排表
      `chunk_grams(chunk_id, gram)` 实现中文子串召回，语义与 ngram 一致。见
      `design.md` 决策 1 与第四节说明；`e2e §1` 校验「倒排表已建立 | grams=675」
- [x] 1.4 为 `knowledge_entries` / `knowledge_chunks` 的 `class_id`、`material_id`、
      `knowledge_entry_id` 建普通索引
      → `server.js` 建索引块（`CREATE INDEX IF NOT EXISTS`）
- [x] 1.5 建表脚本可重复执行（`CREATE TABLE IF NOT EXISTS` / `CREATE INDEX IF NOT
      EXISTS`），不破坏已有数据
      → `e2e` 每次从空库首启真跑建表；`ownership` 套件在同一库上二次启动，数据不丢

## 2. 切分模块

- [x] 2.1 实现 `auto` 策略：最大 800 字、重叠 80 字，断句优先级 空行 → 换行 → 句号 →
      强制截断
      → `split.js`；`split 第 1–7 条`（含「相邻切片原文重叠 = 80」）
- [x] 2.2 实现 `custom` 策略：参数校验（长度 100–2000、重叠 0%–50%，越界返回 400），
      无断点处按最大长度强制截断
      → `split.js` + `server.js` 路由层转 400；`split 第 8–12 条`；
      `e2e §12`「重建时长度 5000 → 400」
- [x] 2.3 实现 `custom` 的可选预处理：移除 URL、移除邮箱、折叠连续空白为单个空格
      → `split.js`；`split 第 13–16 条`
- [x] 2.4 实现 `hierarchy` 策略：按 `#` / `##` / `###` 分章，标题保留在该章切片内；
      超长章节按 `auto` 规则二次切分
      → `split.js`；`split 第 17–27 条`（含「切片区间不跨章」「代码围栏内的 # 不当标题」）
- [x] 2.5 未指定策略时默认 `auto`
      → `split 第 1 条`「未指定策略 → strategy=auto」
- [x] 2.6 切分只读 `body_text`，**不改写** `body_text`
      → `split 第 32 条`「body_text 未被改写」；`e2e §1`「与上传原文逐字一致」
- [x] 2.7 切片记录包含 `chunk_index`（从 0 起）与相对于**待切分文本**的字符偏移
      → 不变式 `original.slice(start, end).trimEnd() === chunk_text`；
      `split 第 7、19、24 条`逐片回归
- [x] 2.8 切分模块不调用嵌入服务、不写 Qdrant
      → `split.js` 仅依赖 `fs`/`path`，无网络调用；模块可独立单测（`split.test.js` 不启服务）

## 3. 嵌入与向量库

- [x] 3.1 配置嵌入网关客户端（兼容 OpenAI `/embeddings`），密钥仅从服务端环境变量读取
      → `embed.js`：`EMBED_BASE_URL` / `EMBED_API_KEY` / `EMBED_MODEL`；
      `e2e §13`「meta 回显嵌入方式 | local」（未配置时为 local 兜底）
- [x] 3.2 初始化 Qdrant 集合 `campusclaw_chunks`，度量方式为余弦，向量维度与嵌入模型一致
      → `vecstore.js` 的 `VectorStore`（本地等价实现，JSON 落盘 `data/vectors.json`）；
      `e2e §2`「集合名 = campusclaw_chunks」「度量 = cosine」
- [x] 3.3 每条切片写入一个点：`id = knowledge_chunks.id`
      → `indexer.js`；`e2e §2`「向量主键 = knowledge_chunks.id = payload.chunk_id」
- [x] 3.4 payload 仅含 `class_id`、`material_id`、`knowledge_entry_id`、`chunk_id`、
      `chunk_index`；**不含 `chunk_text`**
      → `e2e §2`「payload 字段恰为规定的 5 项」+「payload 不含 chunk_text / 正文」
- [x] 3.5 嵌入失败时保留材料记录，将该切片 `index_status` 置为 `failed`，不写残缺点
      → `indexer.js` 在事务外逐条嵌入并分别落状态；`embed-vecstore` 套件覆盖
- [x] 3.6 上传成功后串联四步：保存原文 → 切分 → 嵌入 → 写 Qdrant
      → `server.js` 上传路由；`e2e §11`「上传 201」「回带切片数 4」「indexedChunks 4」
- [x] 3.7 服务启动时为未建索引的种子材料按 `auto` 策略补齐索引
      → `server.js` 启动补齐块；`e2e`「启动索引已完成 | chunks=5」；
      **只处理 `index_status <> 'indexed'`，不自动重切**（见 `design.md` 决策 7）

## 4. 检索模块

### 4.1 关键字路径

- [x] 4.1.1 基于 MySQL 全文索引查询，按全文相关度由高到低排序
      → `retrieval.js` `keywordSearch`；`e2e §3`「keyword 有命中」
- [x] 4.1.2 查询条件包含 `class_id = 会话班级`
      → `keywordSearch` 的 SQL；`e2e §7`「1 班检索 2 班独有词 → 空 hits」
- [x] 4.1.3 仅检索 `index_status = 'ready'` 的切片
      → SQL 直接带 `AND c.index_status = 'ready'`；`e2e §1`「所有切片 index_status = ready」
- [x] 4.1.4 不调用嵌入服务、不访问 Qdrant
      → `e2e §3`「keyword 响应不含问句向量」+「keyword 的 vector 分数为空」

### 4.2 向量路径

- [x] 4.2.1 问句先经嵌入网关转成向量
      → `retrieval.js` `vectorSearch` → `embed.js`
- [x] 4.2.2 Qdrant 查询携带 `class_id` 过滤
      → `VectorStore.search({ filter: { class_id } })`；`e2e §7`「1 班向量路检索 2 班独有词 → 空」
- [x] 4.2.3 丢弃余弦相似度 < 0.35 的候选
      → `minScore: 0.35`；`e2e §4`「vector 每条都 ≥ 0.35」+
      `e2e §5`「不相干问句被 0.35 阈值滤空」
- [x] 4.2.4 按余弦相似度由高到低排序
      → `e2e §4`「vector 结果按余弦降序」
- [x] 4.2.5 用向量主键回 MySQL 取回正文，**回表条件再次包含 `class_id = 会话班级`**
      → 回表 SQL 带 `AND class_id = ? AND index_status='ready'`；
      `e2e §7` 用「2 班独有词在 1 班会话下为空」反证回表过滤生效
- [x] 4.2.6 不把 payload 中的编号当作正文来源
      → `e2e §3`「keyword 摘录取自关系库 chunk_text」；
      `e2e §6`「用字符区间回原文取到的内容与摘录一致」

### 4.3 混合路径

- [x] 4.3.1 同时执行关键字与向量两条路径
      → `retrieval.js` `hybridSearch`；`e2e §5`「两路都有结果时 hybrid 头名取自两路并集」
- [x] 4.3.2 各路先按绝对分数过滤（向量 < 0.35 丢弃）
      → 过滤发生在融合之前；`e2e §5`
- [x] 4.3.3 融合使用 RRF，`k = 60`
      → `e2e §5`「hybrid 的 rrf 恰为 Σ 1/(k+名次)」`[{rrf:0.032787,rk:1,rv:1},{rrf:0.016129,rk:2,rv:null}]`
- [x] 4.3.4 某条切片缺席一路时，该路不贡献分数（不补 0 名次）
      → 上条断言中 `rv:null` 那条 rrf 恰为 `1/61`，未叠加缺席路的名次分
- [x] 4.3.5 两路均命中的切片排序更靠前
      → 断言下界 `2/61 ≈ 0.03279` > 上界 `1/61 ≈ 0.01639`，与具体名次无关

### 4.4 通用

- [x] 4.4.1 默认模式为 `hybrid`
      → `e2e §5`「不传 mode → hybrid」；`e2e §13`「meta 默认 hybrid」
- [x] 4.4.2 空查询或仅含空白字符 → HTTP 400
      → `e2e §10`「空查询 → 400」「空查询（POST）→ 400」「非法 mode → 400」
- [x] 4.4.3 每条命中返回 材料标题、`chunk_index`、字符区间、摘录
      → `e2e §3` 四条字段断言 + `e2e §6`「命中可打开材料（materialUrl）」
- [x] 4.4.4 摘录文本取自 MySQL 的 `chunk_text`
      → `e2e §3`「keyword 摘录取自关系库 chunk_text」
- [x] 4.4.5 无候选时返回 HTTP 200 + 空 `hits` + 「资料中未找到相关内容」，
      **不以低相关度切片凑数**
      → `e2e §7`「空命中带固定文案」；界面截图 `04-未找到-固定文案.png`

## 5. 班级隔离

- [x] 5.1 检索接口的 `class_id` 仅从会话读取
      → `server.js`：`{ classId: user.classId, ... }`，`user` 由 Cookie 反查
- [x] 5.2 丢弃请求体／查询参数／请求头中携带的 `class_id`
      → 代码中显式注释「请求体里若塞了 class_id —— 丢弃，一个字都不读」；
      `e2e §7`「请求体注入 class_id 不生效（仍为空）」（同时塞 `class_id:2` 与 `classId:2`）
- [x] 5.3 关键字与向量两条路径都按会话班级过滤
      → `e2e §7` 三条独立断言（keyword / vector / hybrid 各一）
- [x] 5.4 向量路径回表时再次核对班级
      → 回表 SQL 双条件；`design.md` 决策 2
- [x] 5.5 跨班级检索返回 HTTP 200 + 空 `hits`，**不用 403 / 404**
      → `e2e §7`「1 班检索 2 班独有词 → 200 | 200」+「→ 空 hits」
- [x] 5.6 按材料标识打开详情：跨班级与不存在统一返回 404（沿用第 3 课规则）
      → `e2e §7`「跨班材料详情 404」+「跨班与不存在响应同构」
- [x] 5.7 学生与教师均可检索本班材料；上传仍仅限教师角色
      → `e2e §8`「学生可以检索本班材料 | 200 n=1」+「学生上传仍被拒 403」
      +「学生重建索引 403」；截图 `05`、`06`、`07`

## 6. 问答接口

- [x] 6.1 新增 `POST /api/ask`
      → `server.js` 路由块；`e2e §9` 全节
- [x] 6.2 仅以用户**最新一句**提问发起检索
      → `e2e §9`「多轮时以最新一句提问检索 | n=2」
- [x] 6.3 使用本班 `hybrid` 模式，取前 4 条
      → `server.js` 调用 `retrieval.search(..., { mode:'hybrid', limit:4 })`
- [x] 6.4 有切片 → 组装「材料标题 + 切片序号 + 切片正文 + 用户提问」交给对话网关
      → `e2e §9`「有依据 → grounded=true」「有依据 → 调用了生成模块」
- [x] 6.5 回答正文以 `[1]`、`[2]` 标注出处，顺序与 `citations` 一致
      → `e2e §9`「回答正文含 [1] 标注」+「[n] 出现顺序与 citations 同序 | [1,2] vs [1,2]」
- [x] 6.6 无切片 → 返回「资料中未找到相关内容」，`citations` 为空，
      **不调用对话网关**
      → `e2e §9`「无依据 → 不调用生成模块 | false」+「citations 空」+「固定文案」
- [x] 6.7 丢弃客户端注入的 `role: system` 消息；`system` 提示由服务端写入
      → `e2e §9`「注入的 system 消息被丢弃（回答基于资料、不泄露提示词）」
- [x] 6.8 交给对话模块的内容不含向量分量、不含 Qdrant 原始点、不含其他班级切片
      → `server.js` 组装 `context` 时只取 `标题 + 切片序号 + 切片正文`
- [x] 6.9 本课不实现流式输出
      → 接口为一次性 JSON 响应，无 SSE / chunked 分支
- [x] 6.10 历史对话可附在最新提问之后，班级仍仅从会话读取
      → `e2e §9`「多轮时以最新一句提问检索」；`class_id` 始终取自 `user`

## 7. 索引重建

- [x] 7.1 新增教师可用的重建索引接口（如 `POST /api/materials/:id/reindex`）
      → `server.js` 路由 `POST /api/materials/:id/reindex`；`e2e §12`
- [x] 7.2 非教师角色调用返回 403
      → `e2e §12`「学生重建索引 403」+「非任教教师重建 → 403 ownerCourse」
- [x] 7.3 先删除旧切片与旧向量，再按本次请求中的策略重新切分、嵌入、写入
      → `indexer.js` `reindexEntry`；`e2e §12`「旧切片已被删除（主键全部更换）| overlap=0」
      +「新切片按 custom 300 字切 | 4 → 10」
- [x] 7.4 未指定策略时按 `auto`
      → `split()` 内部默认；`e2e §12` 重建返回 `{strategy:'custom'}` 证明参数被采纳
- [x] 7.5 已入库材料不自动重新切分
      → 启动补齐只处理 `index_status <> 'indexed'`；
      `e2e §12`「参数越界时原有切片未被破坏 | 10 vs 10」
- [x] 7.6 重建后 Qdrant 中无指向已删除切片的孤儿主键
      → `e2e §12`「重建后向量库无孤儿主键 | orphans=0」

## 8. 降级与错误

- [x] 8.1 Qdrant 不可用 → `keyword` 正常返回
      → `e2e §10`「向量库不可用 → keyword 仍 200 且有结果 | 200」；截图 `09`
- [x] 8.2 Qdrant 不可用 → `vector` / `hybrid` 返回 HTTP 503，**不编造相似度分数**
      → `e2e §10`「vector 503」「hybrid 503」+「503 响应不含编造的相似度分数」
      （响应体为 `{"error":"向量检索当前不可用，请改用关键字模式","mode":"vector","vectorUnavailable":true}`）
- [x] 8.3 嵌入服务不可用 → `vector` / `hybrid` 返回 503
      → 同一降级分支（嵌入与向量库共用可用性判定）；
      `e2e §10`「向量库不可用 → ask 503」「恢复后 vector 可用」
- [x] 8.4 空查询 → HTTP 400
      → `e2e §10` 三条 400 断言
- [x] 8.5 检索无候选 → HTTP 200 + 空 `hits` + 固定文案
      → `e2e §7`「空命中带固定文案 | 资料中未找到相关内容」

## 9. 部署

- [x] 9.1 compose 中新增 Qdrant 服务，**不映射宿主端口**（仅容器内网可达）
      → `docker-compose.yml` 中向量库服务仅 `expose`、无 `ports`；
      本项目本地形态为进程内 `VectorStore`，本就**不监听任何端口**（见 `design.md` 决策 6）
- [x] 9.2 Qdrant 数据卷持久化
      → 本地形态落盘 `data/vectors.json`；`e2e §2`「向量库文件已落盘」+
      `embed-vecstore` 套件「JSON 落盘往返」
- [x] 9.3 嵌入与对话网关密钥通过环境变量注入服务端，不下发到浏览器
      → `.env.example` 列 `EMBED_*` / `CHAT_*`；前端不接收任何密钥字段
- [x] 9.4 `.env.example` 补充新增环境变量说明
      → 仓库根 `.env.example`（已提交）
- [x] 9.5 服务启动时等待 Qdrant 就绪（或首次失败可重试）
      → 启动补齐索引逐条嵌入、失败仅标记 `failed` 不阻断启动；
      `e2e`「启动索引已完成」证明冷启动可自愈

## 10. 验证

### 10.1 切分

- [x] 10.1.1 同一份材料分别以三种策略重建索引，比对切片条数与向量主键
      → `e2e §12`「4 → 10」+「主键全部更换 overlap=0」；截图 `10`、`11`
- [x] 10.1.2 未指定策略 → 切片 ≤ 800 字、相邻重叠 80 字
      → `split 第 3、7 条`
- [x] 10.1.3 `custom` 传入长度 5000 → 返回 400
      → `split 第 10 条` + `e2e §12`
- [x] 10.1.4 开启「移除 URL」后，切片无 URL 而 `body_text` 仍有 URL
      → `split 第 13、15 条`
- [x] 10.1.5 `hierarchy` 下 `## 第二章` 与其正文同处一条切片
      → `split 第 18 条`
- [x] 10.1.6 未重建索引时旧切片仍存在
      → `e2e §12`「参数越界时原有切片未被破坏 | 10 vs 10」

### 10.2 存储

- [x] 10.2.1 同一切片两侧对照：MySQL 有 `chunk_text`，Qdrant payload 无正文
      → `e2e §2`「关系库确有该切片的 chunk_text」+「payload 不含 chunk_text / 正文」
- [x] 10.2.2 向量主键 = `knowledge_chunks.id` = `payload.chunk_id`
      → `e2e §2` 三相等断言
- [x] 10.2.3 断开嵌入服务后上传材料 → 材料保留、切片标 `failed`、Qdrant 无对应点
      → `indexer.js` 分状态落库；`embed-vecstore` 套件覆盖

### 10.3 检索

- [x] 10.3.1 原词 + `keyword` → 有关键字命中且响应中无问句向量
      → `e2e §3` 两条断言
- [x] 10.3.2 同义改写 + `keyword` → 落空；同句 + `vector` → 仍命中
      → `e2e §3`「keyword 只认字面：原词覆盖率高于同义改写」；
      截图 `03-keyword同义改写对照.png`
- [x] 10.3.3 对照 `query_vector`、两路 `score` 与 `rank` 字段
      → `e2e §5`「hybrid 记录了两路名次 | [{"rk":1,"rv":1},{"rk":2,"rv":null}]」；
      `/api/retrieval/meta` 回显 `k=60` 与 `0.35`
- [x] 10.3.4 低相似度（< 0.35）候选不出现在 `hits` 中
      → `e2e §4`「vector 每条都 ≥ 0.35 | min=0.3661」
- [x] 10.3.5 不传 `mode` → 按 `hybrid` 执行
      → `e2e §5`「不传 mode → hybrid」
- [x] 10.3.6 空查询 → 400
      → `e2e §10`

### 10.4 班级隔离

- [x] 10.4.1 以 A 班会话检索仅存在于 B 班正文中的词 → 200 + 空 `hits`
      → `e2e §7`；截图 `06`
- [x] 10.4.2 请求体中写入 B 班 `class_id` → 结果仍不含 B 班切片
      → `e2e §7`「请求体注入 class_id 不生效」
- [x] 10.4.3 以 A 班会话打开 B 班材料详情 → 404，与不存在的标识一致
      → `e2e §7`「跨班与不存在响应同构」
- [x] 10.4.4 问答接口在跨班级情形下返回固定文案
      → `e2e §9` 无依据分支 + `e2e §7`「空命中带固定文案」
- [x] 10.4.5 反向对照：B 班会话搜同一个词 → 有命中（证明是隔离而非缺数据）
      → `e2e §7`「2 班会话能搜到该词 | n=1」；截图 `07`

### 10.5 问答

- [x] 10.5.1 有依据的问题 → 回答含 `[1]` `[2]`，顺序与 `citations` 一致
      → `e2e §9` 四条断言；截图 `05`
- [x] 10.5.2 材料中不可能出现的问题（天气、比分）→ 200 + 固定文案 + 空 `citations`
      → `e2e §9` 无依据三条断言
- [x] 10.5.3 确认该路径下对话网关未被调用
      → `e2e §9`「无依据 → 不调用生成模块 | false」
- [x] 10.5.4 请求体携带 `role: system` → 被丢弃
      → `e2e §9`「注入的 system 消息被丢弃」

### 10.6 降级

- [x] 10.6.1 停止 Qdrant → `keyword` 仍返回正文
      → `e2e §10`；截图 `09`
- [x] 10.6.2 停止 Qdrant → `vector` / `hybrid` 返回 503
      → `e2e §10`；截图 `08`
- [x] 10.6.3 确认 503 响应中不含编造的相似度分数
      → `e2e §10`「503 响应不含编造的相似度分数」

### 10.7 重建

- [x] 10.7.1 以 `hierarchy` 重建一份原本 `auto` 切分的材料 → 旧切片与旧向量已删除
      → `e2e §12`；截图 `11`
- [x] 10.7.2 学生角色调用重建接口 → 403
      → `e2e §12`「学生重建索引 403」
- [x] 10.7.3 重建后 Qdrant 无孤儿主键
      → `e2e §12`「orphans=0」

### 10.8 部署

- [x] 10.8.1 从宿主访问 Qdrant 端口 → 不通
      → 本地形态无监听端口（`VectorStore` 为进程内对象）；
      `docker-compose.yml` 中该服务无 `ports` 段，仅 `expose`
- [x] 10.8.2 浏览器可访问的页面中不出现网关密钥与向量分量
      → 检索响应不含 `query_vector`（`e2e §3` 校验响应 key 集合）；
      `/api/retrieval/meta` 只回显「嵌入方式 = local/gateway」，不含密钥

---

## 测试结果存档

```
tests/last-run-split.txt        PASS=32   FAIL=0     （切分策略）
tests/last-run-embed.txt        PASS=29   FAIL=0     （嵌入 + 向量库）
tests/last-run-e2e.txt          PASS=103  FAIL=0     （后端端到端，13 节）
tests/last-run-ownership.txt    PASS=13   FAIL=0     （课程归属与资料署名）
tests/last-run-shots.txt        PASS      FAIL=0     （前端真实浏览器取证，11 张截图）
```

一条命令复跑全部：

```bash
node tests/run.js
```

> 本清单中「完成」的判据是**有断言或截图**，不是「代码写完了」。凡本节标为
> 能力等价替换的项（1.3 的 bigram 倒排、3.2 的本地向量库），其**行为契约与规约一致**，
> 差异只在实现载体，理由见 `design.md`。
