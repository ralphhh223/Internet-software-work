/*
 * CampusClaw —— 第 4 课：索引模块
 *
 * 把「正文 → 切片 → 嵌入 → 向量」串起来，并提供重建索引。
 *
 * 三条容易踩错、这里刻意写清的规则：
 *   1) 切分**不改写** knowledge_entries.body_text（原始正文是溯源的最后凭据）；
 *   2) 嵌入失败 → 材料保留、该切片 index_status='failed'、**不写残缺点**；
 *   3) 重建索引 → **先删旧切片与旧向量，再按本次策略重写**；
 *      已入库材料**不自动重新切分**（只有显式重建才重切）。
 */

const { split, SplitParamError } = require('./split');

const READY = 'ready';
const FAILED = 'failed';

/**
 * 为一份知识库正文建立索引。
 *
 * @param {object} deps { db, vecstore, embed }
 * @param {object} entry { id, class_id, material_id, body_text }
 * @param {object} opts  { strategy, maxLen, overlap, overlapRatio, stripUrls, ... }
 * @returns {Promise<{chunks:number, indexed:number, failed:number, strategy:string}>}
 */
async function indexEntry(deps, entry, opts) {
  const { db, vecstore, embed } = deps;
  const o = opts || {};

  /* 参数校验在**写库之前**：越界就该 400 且一片都不产生（规约验收项）。 */
  const plan = split(entry.body_text, o);     // 可能抛 SplitParamError

  db.exec('BEGIN');
  let created = 0;
  try {
    const insChunk = db.prepare(`
      INSERT INTO knowledge_chunks
        (class_id, material_id, knowledge_entry_id, chunk_index, chunk_text,
         char_start, char_end, index_status, created_at)
      VALUES (?,?,?,?,?,?,?,?,?)
    `);
    const insGram = db.prepare('INSERT OR IGNORE INTO chunk_grams (chunk_id, gram) VALUES (?,?)');
    const now = new Date().toISOString();

    for (const c of plan.chunks) {
      /* 先以 pending 入库，拿到主键（= 将来向量库的点主键）。
         主键必须在嵌入之前就确定，否则没法把两侧对上。 */
      const r = insChunk.run(
        entry.class_id, entry.material_id, entry.id, c.index, c.text,
        c.start, c.end, 'pending', now
      );
      const chunkId = Number(r.lastInsertRowid);
      created++;
      /* 倒排表与切片表同事务写入：两者不一致就会出现
         「关键词能召回、但按 id 取不到正文」的幽灵命中。 */
      for (const g of gramsOfChunk(c.text)) insGram.run(chunkId, g);
    }
    db.prepare('UPDATE knowledge_entries SET index_status = ?, updated_at = ? WHERE id = ?')
      .run('indexed', now, entry.id);
    db.exec('COMMIT');
  } catch (e) {
    try { db.exec('ROLLBACK'); } catch (e2) { /* 忽略 */ }
    throw e;
  }

  /* 嵌入与写向量放在事务**之外**：
     嵌入要走网络（可能很慢或失败），把它圈进事务会长时间占着写锁；
     而且失败时我们要的语义是「切片留下但标 failed」，不是整体回滚。 */
  const pending = db.prepare(
    'SELECT id, chunk_text FROM knowledge_chunks WHERE knowledge_entry_id = ? ORDER BY chunk_index'
  ).all(entry.id);

  let indexed = 0, failed = 0;
  const setReady = db.prepare("UPDATE knowledge_chunks SET index_status = 'ready' WHERE id = ?");
  const setFailed = db.prepare("UPDATE knowledge_chunks SET index_status = 'failed' WHERE id = ?");

  for (const p of pending) {
    try {
      const v = await embed(p.chunk_text);
      vecstore.upsert(p.id, v, {
        class_id: entry.class_id,
        material_id: entry.material_id,
        knowledge_entry_id: entry.id,
        chunk_id: p.id,
        chunk_index: pending.indexOf(p)
      });
      setReady.run(p.id);
      indexed++;
    } catch (e) {
      /* 失败只降级这一片：材料与 body_text 都还在，别的切片照常可用。
         关键是**不写残缺点** —— 写进去会得到一个永远匹配不上的向量，
         比缺一个点更难排查。 */
      setFailed.run(p.id);
      failed++;
      console.warn('[index] 切片嵌入失败 id=' + p.id + '：' + e.message);
    }
  }
  if (indexed) vecstore.persist();

  return { chunks: created, indexed, failed, strategy: plan.strategy, plan };
}

/* 切片内去重后的 gram 列表 */
function gramsOfChunk(text) {
  const { gramsOf } = require('./retrieval');
  return Array.from(gramsOf(text));
}

/**
 * 重建索引：先删旧切片与旧向量，再按本次策略重写。
 * 未指定策略 → auto。
 *
 * @returns {Promise<{removedChunks, removedVectors, ...indexResult}>}
 */
async function reindexEntry(deps, entry, opts) {
  const { db, vecstore } = deps;

  // 先按本次策略试切一遍：参数越界要在这里就抛出去，不能删完旧的才发现参数不合法
  split(entry.body_text, opts || {});      // 校验用，结果丢弃

  const old = db.prepare(
    'SELECT id FROM knowledge_chunks WHERE knowledge_entry_id = ?'
  ).all(entry.id);

  let removedVectors = 0;
  for (const c of old) {
    /* 逐个删向量点。规约要求「重建后向量库中不存在指向已删除切片的孤儿主键」，
       所以删除必须真的落到向量库，不能只删切片行。 */
    try { vecstore.delete(c.id); removedVectors++; } catch (e) { /* 不可用时忽略，下面重写会重建 */ }
  }
  const removedChunks = db.prepare(
    'DELETE FROM knowledge_chunks WHERE knowledge_entry_id = ?'
  ).run(entry.id).changes;
  db.prepare('DELETE FROM chunk_grams WHERE chunk_id NOT IN (SELECT id FROM knowledge_chunks)').run();

  const res = await indexEntry(deps, entry, opts);
  return { removedChunks: Number(removedChunks), removedVectors, ...res };
}

module.exports = { indexEntry, reindexEntry, READY, FAILED };
