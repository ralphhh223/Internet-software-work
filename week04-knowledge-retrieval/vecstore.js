/*
 * CampusClaw —— 第 4 课：向量库层
 *
 * 规约把向量存在 Qdrant 集合 campusclaw_chunks 里，并给了三条硬约束：
 *   1) 度量方式是余弦；
 *   2) payload 只放标识（class_id / material_id / knowledge_entry_id / chunk_id / chunk_index），
 *      **不放正文**；
 *   3) 点的主键 = 切片表主键 = payload.chunk_id。
 *
 * 本项目没有外部服务，所以这里实现一个「行为等价的本地向量库」：
 * 同一套接口形状（upsert / search / delete / count），余弦度量，
 * payload 结构与约束逐条照搬。真接 Qdrant 时，只需把这一层换成 HTTP 调用，
 * 上层检索代码一行不用改 —— 这也是把向量库单独封一层的原因。
 *
 * 关键设计：**查询时按 class_id 过滤由本层完成**，
 * 且上层回表时还会再核对一次班级（规约要求两条路径都过滤）。
 */

const fs = require('fs');
const path = require('path');
const { cosine } = require('./embed');

const COLLECTION = 'campusclaw_chunks';

class VectorStore {
  /**
   * @param {string} file 落盘文件；传 null 表示纯内存（测试用）
   */
  constructor(file) {
    this.file = file || null;
    this.collection = COLLECTION;
    this.metric = 'cosine';
    /* id(number) -> { id, vector, payload }。用 Map 而不是数组：
       按主键 upsert / 删除都是 O(1)，重建索引要频繁删旧点。 */
    this.points = new Map();
    this.available = true;    // 置 false 模拟「向量库不可用」，用来验收降级路径
    this.load();
  }

  load() {
    if (!this.file) return;
    try {
      if (!fs.existsSync(this.file)) return;
      const raw = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      if (raw && raw.collection === COLLECTION && Array.isArray(raw.points)) {
        for (const p of raw.points) this.points.set(Number(p.id), p);
      }
    } catch (e) {
      console.warn('[vecstore] 向量文件读取失败，按空库启动：' + e.message);
    }
  }

  persist() {
    if (!this.file) return;
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      const tmp = this.file + '.tmp';
      fs.writeFileSync(tmp, JSON.stringify({
        collection: COLLECTION,
        metric: this.metric,
        points: Array.from(this.points.values())
      }));
      fs.renameSync(tmp, this.file);
    } catch (e) {
      console.warn('[vecstore] 向量文件写入失败：' + e.message);
    }
  }

  /* 向量库不可用时的统一错误：调用方据此决定「keyword 照常、vector/hybrid 503」 */
  _guard() {
    if (!this.available) {
      const err = new Error('向量库不可用');
      err.vectorUnavailable = true;
      throw err;
    }
  }

  /**
   * 写入/覆盖一个点。
   * payload 里的字段由调用方给全；这里再兜一层：**任何情况下都不写入正文**。
   */
  upsert(id, vector, payload) {
    this._guard();
    const clean = {
      class_id: payload.class_id,
      material_id: payload.material_id,
      knowledge_entry_id: payload.knowledge_entry_id,
      chunk_id: Number(id),
      chunk_index: payload.chunk_index
    };
    this.points.set(Number(id), { id: Number(id), vector, payload: clean });
  }

  upsertMany(items) {
    for (const it of items) this.upsert(it.id, it.vector, it.payload);
    this.persist();
  }

  /** 删除单点 */
  delete(id) {
    this._guard();
    this.points.delete(Number(id));
  }

  /** 按条件删除：重建索引时按 material_id 清掉旧向量 */
  deleteBy(filter) {
    this._guard();
    let n = 0;
    for (const [id, p] of this.points) {
      if (matches(p.payload, filter)) { this.points.delete(id); n++; }
    }
    return n;
  }

  /**
   * 向量检索。
   * @param {number[]} vector 问句向量
   * @param {object} opt { classId, limit, minScore }
   * @returns {Array<{id, score, payload}>} 按余弦由高到低
   */
  search(vector, opt) {
    this._guard();
    const o = opt || {};
    const limit = o.limit || 10;
    /* minScore 默认 0.35 —— 规约写死的「余弦低于 0.35 的候选不予保留」。
       过滤放在向量库里而不是上层，是为了少回表、
       也避免「先取出再丢弃」在日志与响应里留下不该出现的低分候选。 */
    const minScore = o.minScore != null ? o.minScore : 0.35;

    const hits = [];
    for (const p of this.points.values()) {
      // 班级过滤必须在候选集里就生效：不能把别班的点算进分数再筛
      if (o.classId != null && p.payload.class_id !== o.classId) continue;
      const score = cosine(vector, p.vector);
      if (score < minScore) continue;
      hits.push({ id: p.id, score, payload: p.payload });
    }
    hits.sort((a, b) => b.score - a.score || a.id - b.id);   // 同分按 id 稳定排序
    return hits.slice(0, limit);
  }

  count(filter) {
    if (!filter) return this.points.size;
    let n = 0;
    for (const p of this.points.values()) if (matches(p.payload, filter)) n++;
    return n;
  }

  /** 取出某个点的 payload（用于验收「payload 不含正文」） */
  get(id) { return this.points.get(Number(id)) || null; }
}

function matches(payload, filter) {
  if (!filter) return true;
  for (const k of Object.keys(filter)) {
    if (filter[k] == null) continue;
    if (payload[k] !== filter[k]) return false;
  }
  return true;
}

module.exports = { VectorStore, COLLECTION };
