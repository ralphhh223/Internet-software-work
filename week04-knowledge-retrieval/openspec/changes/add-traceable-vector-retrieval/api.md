# 接口契约：add-traceable-vector-retrieval

本文件规定本次变更新增的接口形状，是 `specs/knowledge-retrieval/spec.md` 的可调用侧面。
规约说「必须做到什么」，本文件说「怎么调用、返回什么字段」。

约定：接口前缀 `/week04/api`；除登录外**全部需要登录**（Cookie `session`），
未登录一律 `401` 并带 `needLogin: true`。

---

## 一、通用约定

### 1. 身份与班级的来源

所有接口的 `class_id` **只从会话读取**。请求体、查询串、请求头中携带的任何班级编号
在解析后被丢弃，不参与任何过滤。

```jsonc
// 服务端的实际写法：请求体里的 class_id 一个字都不读
const r = await retrieval.search(indexDeps, { classId: user.classId, ... });
```

### 2. 命中对象（`hit`）的字段

三种检索模式返回的 `hits[]` 元素形状一致 —— **可追溯性不随模式改变**：

| 字段 | 类型 | 说明 |
|---|---|---|
| `materialId` | number | 材料主键 |
| `materialTitle` | string | 材料标题 |
| `materialUrl` | string | 打开该材料详情的地址 |
| `chunkId` | number | 切片主键（= 向量主键 = `payload.chunk_id`） |
| `chunkIndex` | number | 该材料内第几片，从 0 起 |
| `charStart` / `charEnd` | number | **在原文中的字符区间**，用于定位 |
| `excerpt` | string | 摘录，**始终取自 MySQL 的 `chunk_text`** |
| `scores` | object | 各路的分数与名次，见下 |

`scores` 的形状随模式不同：

```jsonc
// keyword：只有全文相关度
{ "keyword": 0.42, "rank": { "keyword": 1 } }

// vector：只有余弦
{ "vector": 0.3661, "rank": { "vector": 1 } }

// hybrid：两路名次 + RRF 分数
{ "rrf": 0.032787, "rank": { "keyword": 1, "vector": 1 } }
```

> `rank` 中**缺席的一路不出现**（不是补 0）—— 这是 RRF「缺席不贡献分数」的对外体现。

---

## 二、`GET /week04/api/retrieval/meta`

回显本次部署的检索参数，便于前端与验收方对照，**不需要猜**。

- 角色：登录即可
- 响应 `200`：

```jsonc
{
  "modes": ["keyword", "vector", "hybrid"],
  "defaultMode": "hybrid",
  "minVectorScore": 0.35,
  "rrfK": 60,
  "embedding": "local"          // 或 "gateway"；只回显方式，不含任何密钥
}
```

---

## 三、`GET|POST /week04/api/retrieval/search`

三模式检索。`class_id` 只取自会话。

### 请求

| 参数 | 位置 | 必填 | 说明 |
|---|---|---|---|
| `q` | query 或 body | 是 | 查询内容；为空或仅含空白 → `400` |
| `mode` | query 或 body | 否 | `keyword` / `vector` / `hybrid`，默认 `hybrid`；非法值 → `400` |
| `limit` | query 或 body | 否 | 返回条数上限 |

### 响应 `200`

```jsonc
{
  "scope": "class",
  "mode": "hybrid",
  "query": "数列极限是怎么定义的",
  "hits": [ /* hit 对象 */ ],
  "note": "ok",
  "noteText": "",
  "counts": { "keyword": 1, "vector": 1, "hybrid": 1 }
}
```

### 关键约定

| 约定 | 说明 |
|---|---|
| `keyword` 响应**不含问句向量** | 响应 key 集合为 `scope / mode / query / hits / note / noteText / counts`，既接口未走向量路，就不返回向量 |
| `keyword` 的 `scores.vector` 为空 | 证明没有访问向量库 |
| `vector` 丢弃余弦 `< 0.35` | 每条命中都 `≥ 0.35` |
| `hybrid` 按 RRF 名次融合 | `rrf = Σ 1/(60 + rank)`；两路均中必然排在只中一路之前 |
| 无候选 | `200` + `hits: []` + `noteText: "资料中未找到相关内容"`，**不以低相关度切片凑数** |
| 跨班级 | `200` + `hits: []`，**不用 403/404** |
| 向量库不可用 | `503` |

### 降级响应 `503`

```jsonc
{ "error": "向量检索当前不可用，请改用关键字模式",
  "mode": "vector",
  "vectorUnavailable": true }
```

**不带任何相似度分数。** 拿不到就是拿不到，不编。

---

## 四、`POST /week04/api/ask`

先检索，再生成。

### 请求

```jsonc
{
  "messages": [
    { "role": "user", "content": "上一轮的问题" },
    { "role": "assistant", "content": "上一轮的回答" },
    { "role": "user", "content": "本轮的问题" }
  ]
}
```

- 只有**最新一句 user 提问**用于检索，历史仅作上下文附在其后；
- 请求体中的 `role: "system"` 消息**一律丢弃**，`system` 提示由服务端写入。

### 响应 `200`

```jsonc
{
  "answer": "根据本班资料……\n\n[1] # 第一章 函数与极限\n[2] 线性代数习题课笔记\n",
  "citations": [ /* hit 对象，与 [n] 同序 */ ],
  "grounded": true,
  "calledGateway": true
}
```

### 关键约定

| 情形 | 行为 |
|---|---|
| 有命中切片 | 取本班 `hybrid` 前 **4 条**；回答以 `[1]`、`[2]` 标注，**顺序与 `citations` 严格同序**；`calledGateway: true` |
| **无命中切片** | `200` + `answer: "资料中未找到相关内容"` + `citations: []` + **`calledGateway: false`（不调用对话网关）** |
| 向量库不可用 | `503` |
| 对话网关不可用 | `500` |

送进生成模块的内容只有 `材料标题 + 切片序号 + 切片正文 + 用户提问`；
**不含向量分量、不含向量库原始点、不含其他班级切片**。

> 判据是 `citations` 为空 + 固定文案，**不是**页面上有没有文字。
> 页面上出现一段话并不能证明模型被调用过。

---

## 五、`POST /week04/api/materials/:id/reindex`

教师显式重建索引。

- 角色：**教师**，且须为该课程的任教教师 → 否则 `403`
- 请求体（均可选）：

```jsonc
{
  "strategy": "custom",                 // auto | custom | hierarchy，默认 auto
  "maxLength": 200,                     // custom 必填，100–2000
  "overlapRatio": 0.2,                  // 0–0.5
  "preprocess": { "stripUrl": true, "stripEmail": false, "collapseWhitespace": false }
}
```

- 响应 `200`：

```jsonc
{ "ok": true, "strategy": "custom", "removedChunks": 4, "chunks": 10,
  "indexed": 10, "failed": 0 }
```

### 关键约定

| 约定 | 说明 |
|---|---|
| **先校验、后删除** | 参数非法（如 `maxLength: 5000`）→ `400`，且**一个切片都不删**。若先删再校验，一次误操作就能毁掉已有索引 |
| 先删旧切片与旧向量，再按**本次**策略重写 | 避免旧切片与新切片并存产生互相矛盾的重叠片段 |
| 重建后无孤儿主键 | 向量库中不存在指向已删除切片的点 |
| 已入库材料**不自动重切** | 启动补齐只处理 `index_status <> 'indexed'`；换策略必须显式调用本接口 |
| 参数越界错误文案 | `custom 策略的最大长度需为 100–2000 之间的整数` |
| 非任教教师 | `403` + `{"error":"这不是您任教的课程，无法重建其索引","ownerCourse":true}` |

---

## 六、`GET /week04/api/chunks`

本班切片一览，用于验收与排查。

- 角色：登录即可（学生与教师都可看**本班**）
- 响应 `200`：本班切片数组，按 `material_id`、`chunk_index` 排列
- 同样按班级隔离：`s002` 会话只看到 2 班的切片

---

## 七、`POST /week04/api/retrieval/__test__/outage`

**仅用于降级验收**，模拟向量库掉线。

- 挂载条件：环境变量 `CAMPUSCLAW_TEST_HOOKS=1`（**生产默认关闭**）
- 仍然需要登录 —— **不是公开接口**
- 请求体 `{ "down": true | false }` 切换可用性

---

## 八、状态码总表

| 码 | 含义 | 出现场景 |
|---|---|---|
| `200` | 成功 | 含「无命中」「跨班级」——这两者都是正常结果 |
| `400` | 参数错误 | 空查询、非法 `mode`、切分参数越界 |
| `401` | 未登录 | 任何 `/week04/api/*`（登录接口除外） |
| `403` | 角色/归属不足 | 学生上传、学生重建、非任教教师重建 |
| `404` | 材料不存在 | 跨班级与不存在**同构**，不泄露存在性 |
| `500` | 对话网关不可用 | `POST /ask` |
| `503` | 向量能力不可用 | `vector` / `hybrid` / `ask`，且不编造分数 |
