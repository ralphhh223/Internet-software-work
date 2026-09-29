/*
 * CampusClaw —— 第 4 课：检索模块
 *
 * 三种模式（规约要求，默认 hybrid）：
 *   keyword  只查关系库全文索引，不调嵌入、不碰向量库
 *   vector   问句嵌入 → 向量库按班级过滤 → 余弦 < 0.35 丢弃 → 回表取正文
 *   hybrid   两路都跑，按名次做 RRF（k = 60）融合
 *
 * ── 关于关键字路径的实现选择（值得说明） ──
 * 规约的参考实现是 MySQL 的 `FULLTEXT ... WITH PARSER ngram`。SQLite 的 FTS5
 * 自带 `unicode61` 分词器，对中文是按「连续汉字串」整体切分的 ——
 * 「函数与极限」会变成一个 token，于是搜「极限」命中不了。
 * 这正是 MySQL 要额外挂 ngram 解析器的原因。
 *
 * FTS5 也支持 `tokenize='trigram'`，但只在 SQLite ≥ 3.34 且参数写对时可用，
 * 环境依赖太重。所以这里的做法是：
 *   1) 建一张 FTS5 表作为**全文索引**，用它做「候选召回 + 打分」；
 *   2) 另建一张 **bigram 倒排表**（chunk_id, gram）做真正的中文子串召回，
 *      打分用「命中 gram 数 / 问句 gram 数」的覆盖率。
 * 两者都是「关系库里的全文索引」，都不调嵌入、不碰向量库，因此不违背规约的意图；
 * 换成 MySQL 时，把这一层替换为 `MATCH ... AGAINST` 即可，上层接口不变。
 *
 * ── 打分与排序 ──
 * keyword 用覆盖率（0–1）当分数，由高到低；
 * vector 用余弦（已由向量库按 0.35 过滤）；
 * hybrid 只融合**名次**：score = Σ 1 / (k + rank)，k = 60。
 * 单项缺席的那一路不贡献分数（不补 0 名次），
 * 这样「两路都命中」的切片天然比「只中一路」的靠前。
 */

const { cosine } = require('./embed');

const RRF_K = 60;
const VECTOR_MIN_SCORE = 0.35;
const DEFAULT_LIMIT = 8;

/* ---------- 中文 bigram ---------- */
/* 把文本切成用于倒排的 gram 集合。
   汉字取 bigram（单字也保留，覆盖「秩」这种一字查询）；
   拉丁数字按小写词切。 */
function gramsOf(text) {
  const s = String(text == null ? '' : text).toLowerCase();
  const set = new Set();
  for (const run of s.match(/[\u3400-\u4dbf\u4e00-\u9fff\u3040-\u30ff]+/g) || []) {
    if (run.length === 1) set.add(run);
    for (let i = 0; i + 1 < run.length; i++) set.add(run.slice(i, i + 2));
  }
  for (const w of s.match(/[a-z0-9]+/g) || []) set.add(w);
  return set;
}

/* ---------- 关键字路径 ---------- */
/**
 * 只依赖关系库：候选来自 bigram 倒排表，条件里带上 class_id 与 index_status。
 * @returns {Array<{chunkId, score}>} 按覆盖率由高到低
 */
function keywordSearch(db, { classId, query, limit }) {
  const qgrams = Array.from(gramsOf(query));
  if (!qgrams.length) return [];

  const ph = qgrams.map(() => '?').join(',');
  /* 一次把候选召回：命中任一 gram 的切片。
     这里就要把 class_id 与 index_status 压进 SQL ——
     规约要求「关键字路径的查询条件包含 class_id，且只检索 ready 的切片」，
     放到上层过滤就晚了（别班的切片已经进了候选集、还会参与打分）。 */
  const rows = db.prepare(`
    SELECT g.chunk_id, COUNT(*) AS hit
    FROM chunk_grams g
    JOIN knowledge_chunks c ON c.id = g.chunk_id
    WHERE g.gram IN (${ph})
      AND c.class_id = ?
      AND c.index_status = 'ready'
    GROUP BY g.chunk_id
  `).all(...qgrams, classId);

  const total = qgrams.length;
  return rows
    .map(r => ({ chunkId: r.chunk_id, score: r.hit / total }))
    .sort((a, b) => b.score - a.score || a.chunkId - b.chunkId)
    .slice(0, limit);
}

/* ---------- 向量路径 ---------- */
/**
 * 问句嵌入 → 向量库按班级过滤 → 回表取正文。
 * 回表时**再次**带上 class_id —— 不能只信向量库的过滤
 * （规约明确要求「不以 payload 中的编号作为正文来源」）。
 */
async function vectorSearch(deps, { classId, query, limit }) {
  const { vecstore, db, embed } = deps;
  const qv = await embed(query);                      // 可能抛 EmbedError → 上层 503
  const raw = vecstore.search(qv, {
    classId,
    limit: limit * 2,                                 // 多取一些，回表可能筛掉
    minScore: VECTOR_MIN_SCORE                        // 0.35 在此处生效
  });

  const getRow = db.prepare(
    "SELECT id, class_id FROM knowledge_chunks WHERE id = ? AND class_id = ? AND index_status = 'ready'"
  );
  const out = [];
  for (const h of raw) {
    // 回表核对班级：向量库里若混进别班的点，这一步会把它挡掉
    const row = getRow.get(h.id, classId);
    if (!row) continue;
    out.push({ chunkId: h.id, score: h.score });
    if (out.length >= limit) break;
  }
  return out;
}

/* ---------- 归一化：把「单路结果」翻译成 hydrate 认得的条目 ----------
   BUG 备忘：vectorSearch 返回的是 {chunkId, score}，而 hydrate 读的是
   it.scoreVector —— 直接把单路结果丢进 hydrate，余弦分数会被静默丢掉
   （前端看到 vectorScore 全是 null，像是「没走成向量路」）。这里是唯一的
   翻译点：单路结果先经 normalize 再进 hydrate，融合路径则由 rrfFuse 负责填。 */
function normalize(items, path) {
  return items.map(it => ({
    chunkId: it.chunkId,
    rrf: null,
    rankKeyword: path === 'keyword' ? (items.indexOf(it) + 1) : null,
    rankVector: path === 'vector' ? (items.indexOf(it) + 1) : null,
    scoreKeyword: path === 'keyword' ? it.score : null,
    scoreVector: path === 'vector' ? it.score : null
  }));
}

/* ---------- RRF 融合 ---------- */
/**
 * 合并两路结果。**融合的是名次，不是分数** ——
 * 两路的分数尺度完全不同（覆盖率 0–1 vs 余弦 -1–1），直接加权没有意义。
 * 某条切片缺席某一路时，那一路不为它贡献任何分数（不补 0 名次、
 * 也不按「最后一名」折算），这样「两路均命中」的切片 RRF 值必然更高。
 */
function rrfFuse(kw, vec, limit) {
  const acc = new Map();
  const add = (list, name) => {
    list.forEach((item, i) => {
      let e = acc.get(item.chunkId);
      if (!e) {
        e = { chunkId: item.chunkId, rrf: 0, rankKeyword: null, rankVector: null,
              scoreKeyword: null, scoreVector: null };
        acc.set(item.chunkId, e);
      }
      e.rrf += 1 / (RRF_K + (i + 1));
      if (name === 'keyword') { e.rankKeyword = i + 1; e.scoreKeyword = item.score; }
      else { e.rankVector = i + 1; e.scoreVector = item.score; }
    });
  };
  add(kw, 'keyword');
  add(vec, 'vector');

  const list = Array.from(acc.values());
  list.sort((a, b) => b.rrf - a.rrf
    || (b.rankKeyword != null ? 1 : 0) - (a.rankKeyword != null ? 1 : 0)
    || a.chunkId - b.chunkId);
  return list.slice(0, limit);
}

/* ---------- 组装可溯源结果 ---------- */
/*
 * 每条命中必须给出：材料标题、切片序号、字符区间、摘录，并能定位到材料。
 * 摘录**一律取自关系库的 chunk_text**，不从向量库拿（向量库压根没存正文）。
 */
function hydrate(db, classId, items) {
  const stmt = db.prepare(`
    SELECT c.id AS chunk_id, c.chunk_index, c.chunk_text, c.char_start, c.char_end,
           c.material_id,
           f.original_name AS material_title,
           f.course_id,
           co.subject AS course_subject
    FROM knowledge_chunks c
    LEFT JOIN course_files f ON f.id = c.material_id
    LEFT JOIN courses co ON co.id = f.course_id
    WHERE c.id = ? AND c.class_id = ? AND c.index_status = 'ready'
  `);

  const out = [];
  for (const it of items) {
    const row = stmt.get(it.chunkId, classId);
    if (!row) continue;      // 已失效的切片不回给前端
    out.push({
      chunkId: row.chunk_id,
      materialId: row.material_id,
      materialTitle: row.material_title || '(材料已删除)',
      courseId: row.course_id,
      courseSubject: row.course_subject || '',
      chunkIndex: row.chunk_index,
      charStart: row.char_start,
      charEnd: row.char_end,
      excerpt: buildExcerpt(row.chunk_text),
      excerptFull: row.chunk_text,
      /* 分数一律由服务端算、原样回传；降级时不编造 */
      rrf: it.rrf != null ? Number(it.rrf.toFixed(6)) : null,
      rankKeyword: it.rankKeyword == null ? null : it.rankKeyword,
      rankVector: it.rankVector == null ? null : it.rankVector,
      keywordScore: it.scoreKeyword == null ? null : Number(it.scoreKeyword.toFixed(4)),
      vectorScore: it.scoreVector == null ? null : Number(it.scoreVector.toFixed(4))
    });
  }
  return out;
}

/* 摘录：压平换行、截断到 160 字。
   截断只是为了界面好读，完整正文仍在 excerptFull 里。 */
function buildExcerpt(text, max) {
  const m = max || 160;
  const flat = String(text || '').replace(/\s+/g, ' ').trim();
  return flat.length <= m ? flat : flat.slice(0, m) + '…';
}

/* ---------- 对外入口 ---------- */
/**
 * @param {object} deps { db, vecstore, embed }
 * @param {object} opt  { classId, query, mode, limit }
 * @returns {Promise<{mode, hits, note, keywordCount, vectorCount}>}
 * @throws {Error} err.emptyQuery / err.vectorUnavailable / err.embedFailed
 */
async function search(deps, opt) {
  const { db } = deps;
  const o = opt || {};
  const classId = o.classId;                       // 一定来自会话，调用方保证
  const mode = o.mode || 'hybrid';                 // 未指定 → hybrid
  const query = String(o.query == null ? '' : o.query);
  const limit = o.limit || DEFAULT_LIMIT;

  if (!query.trim()) {
    const err = new Error('查询内容不能为空');
    err.emptyQuery = true;
    throw err;
  }

  let kw = [], vec = [], result = [], note = null;

  if (mode === 'keyword') {
    kw = keywordSearch(db, { classId, query, limit });
    result = normalize(kw, 'keyword');
  } else if (mode === 'vector') {
    vec = await vectorSearch(deps, { classId, query, limit });
    result = normalize(vec, 'vector');
  } else if (mode === 'hybrid') {
    /* 先各跑一路，再融合。
       keyword 一定成功（纯关系库）；vector 失败就整体 503 ——
       半份结果冒充 hybrid 会让人以为向量路也参与了。 */
    kw = keywordSearch(db, { classId, query, limit: limit * 2 });
    vec = await vectorSearch(deps, { classId, query, limit: limit * 2 });
    result = rrfFuse(kw, vec, limit);
  } else {
    const err = new Error("mode 只能是 keyword / vector / hybrid");
    err.badMode = true;
    throw err;
  }

  const hits = hydrate(db, classId, result);
  if (!hits.length) note = NOT_FOUND_TEXT;
  return {
    mode,
    query,
    hits,
    note,
    noteText: NOT_FOUND_TEXT,
    counts: { keyword: kw.length, vector: vec.length }
  };
}

const NOT_FOUND_TEXT = '资料中未找到相关内容';

module.exports = {
  search, keywordSearch, vectorSearch, rrfFuse, hydrate, normalize, gramsOf, buildExcerpt,
  NOT_FOUND_TEXT, RRF_K, VECTOR_MIN_SCORE, DEFAULT_LIMIT
};
