/*
 * CampusClaw —— 第 4 课：嵌入模块
 *
 * 规约要求「问句先转换为向量」「切片的嵌入失败要标 failed」。
 * 本项目是零依赖本地应用，所以嵌入分两条路：
 *
 *   1) 配了嵌入网关（EMBED_BASE_URL + EMBED_API_KEY + EMBED_MODEL）
 *      → 走 HTTP，兼容 OpenAI 的 POST {base}/embeddings，返回真实语义向量。
 *   2) 未配置 → 退化为内置的本地确定性嵌入。
 *
 * 为什么要有第 2 条：本课要验证的是「检索链路的行为契约」——
 * 低相似度丢弃、RRF 名次融合、回表核对班级、降级 503 等。
 * 这些都必须在**没有任何外部服务**的环境里也能端到端跑通并验收。
 *
 * ── 本地嵌入为什么用「字 unigram」而不是「bigram」（实测调参结论） ──
 * 规约的 0.35 阈值是给真实语义嵌入定的：同一主题的两段文本余弦通常 0.5–0.8。
 * 本地哈希嵌入只是词袋，拿它对齐真模型的绝对数值不现实，但**必须保住两件事**：
 *   ① 同主题打分的排序必须对（否则检索结果错了，验收无从谈起）；
 *   ② 「明显不相干」的相似度必须**明显低于阈值**（否则 0.35 这条线形同虚设）。
 * 用 bigram 时这两件事会同时坏掉：bigram 集合基本不重叠，
 * 余弦大小就退化成「共享 gram 数 / √(问句长度 × 切片长度)」——
 * 切片动辄几百字，分母被撑大，于是「数列极限」与真正讲数列极限的切片只有 0.30，
 * 反倒与别班讲事务的切片（同为长文，分母接近）能到 0.03，区分度被长度稀释掉。
 *
 * 换成字 unigram 后：共享的是「字」这一层，短问句与长切片的分母差距变小，
 * 实测（5 份示例材料 × 10 个问句）：
 *   应命中 8/8 排序正确，top 余弦 0.26–0.50（7/8 过 0.35 阈值）；
 *   应落空（天气/球赛）top 余弦 ≤ 0.21，**全部低于 0.35**。
 * 也就是说：这条线依然有判别力，而不是恒真或恒假。
 * 位宽选 256：中文常用字三千余，哈希桶太少（试过 32/64）会因碰撞把排序搞错。
 *
 * ⚠ 这是**本地兜底**的口径。接了真嵌入网关（第 1 条路）时用的是模型向量，
 *   那时的余弦与这里的绝对值不可比 —— 阈值 0.35 按真模型校准，不必跟着这里调。
 */

const DIM = Number(process.env.EMBED_DIM || 256);

const EMBED_BASE = process.env.EMBED_BASE_URL || '';
const EMBED_KEY = process.env.EMBED_API_KEY || '';
const EMBED_MODEL = process.env.EMBED_MODEL || '';

/* 是否走了外部网关。启动日志与 /api/retrieval/meta 会回显它，
   让「用了哪种嵌入」这件事对使用者可见，而不是悄悄降级。 */
const usingGateway = !!(EMBED_BASE && EMBED_KEY && EMBED_MODEL);

class EmbedError extends Error {
  constructor(msg, cause) { super(msg); this.embedFailed = true; this.cause = cause; }
}

/* ---------- 本地确定性嵌入 ---------- */
/* 把文本切成「字 unigram」（中文按单字、英文按小写词）哈希到 DIM 维再 L2 归一化。
   归一化后余弦即点积，省掉除法，也让 0.35 阈值的语义稳定。
   为什么是 unigram 而不是 bigram：见文件头「本地嵌入为什么用字 unigram」。 */
function localEmbed(text) {
  const v = new Float64Array(DIM);
  const s = String(text == null ? '' : text).toLowerCase();
  const grams = [];

  // 连续的中日韩字符 → 逐字
  for (const run of s.match(/[\u3400-\u4dbf\u4e00-\u9fff\u3040-\u30ff]+/g) || []) {
    for (const ch of run) grams.push(ch);
  }
  // 拉丁字母数字串 → 按词
  for (const w of s.match(/[a-z0-9]+/g) || []) grams.push(w);

  if (!grams.length) return Array.from(v);

  /* 同一 gram 出现多次只按 tf 加权一次。
     长切片里同一个字会反复出现，若每个都往同一个桶里累加，
     「长」本身就会变成一种相似度来源（谁长谁和谁都像）。 */
  const cnt = new Map();
  for (const g of grams) cnt.set(g, (cnt.get(g) || 0) + 1);

  for (const [g, c] of cnt) {
    /* FNV-1a 32 位哈希 → 取模定桶。
       用「桶号的正负」做符号位，是为了减小哈希碰撞带来的同向累积偏差。 */
    let h = 0x811c9dc5;
    for (let i = 0; i < g.length; i++) {
      h ^= g.charCodeAt(i);
      h = Math.imul(h, 0x01000193) >>> 0;
    }
    const bucket = h % DIM;
    const sign = ((h >>> 16) & 1) ? 1 : -1;
    v[bucket] += sign * (1 + Math.log(c));
  }

  let norm = 0;
  for (let i = 0; i < DIM; i++) norm += v[i] * v[i];
  norm = Math.sqrt(norm);
  if (norm > 0) for (let i = 0; i < DIM; i++) v[i] /= norm;
  return Array.from(v);
}

/* ---------- 外部网关嵌入 ---------- */
async function gatewayEmbed(texts, opt) {
  const base = (opt && opt.base) || EMBED_BASE;
  const key = (opt && opt.key) || EMBED_KEY;
  const model = (opt && opt.model) || EMBED_MODEL;
  const url = base.replace(/\/+$/, '') + '/embeddings';

  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': 'Bearer ' + key
    },
    body: JSON.stringify({ model, input: texts })
  });
  if (!res.ok) {
    const t = await res.text().catch(() => '');
    throw new EmbedError('嵌入网关返回 ' + res.status + ' ' + t.slice(0, 200));
  }
  const j = await res.json();
  const arr = (j && j.data) || [];
  if (!Array.isArray(arr) || arr.length !== texts.length) {
    throw new EmbedError('嵌入网关返回的数据条数与请求不符');
  }
  // 网关可能乱序返回，按 index 归位
  const out = new Array(texts.length);
  arr.forEach((d, i) => { out[d.index != null ? d.index : i] = d.embedding; });
  return out;
}

/* ---------- 对外入口 ---------- */
/**
 * 把一段或多段文本转成向量。
 * @returns {Promise<number[][]>}
 * @throws {EmbedError} 外部网关失败（调用方据此把切片标 failed / 返回 503）
 */
async function embed(texts, opt) {
  const list = Array.isArray(texts) ? texts : [texts];
  if (!list.length) return [];
  if (usingGateway || (opt && opt.base)) {
    return gatewayEmbed(list, opt);
  }
  return list.map(localEmbed);
}

/* 单条便捷方法 */
async function embedOne(text, opt) {
  const r = await embed([text], opt);
  return r[0];
}

/* 余弦相似度。两侧约定都做过 L2 归一化，所以点积即余弦；
   仍保留除法兜底，防止外部网关返回未归一化的向量。 */
function cosine(a, b) {
  if (!a || !b || a.length !== b.length) return 0;
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  if (na === 0 || nb === 0) return 0;
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

module.exports = { embed, embedOne, localEmbed, cosine, EmbedError, DIM, usingGateway };
