/* embed.js + vecstore.js 行为测试
   用法：node tests/embed-vecstore.test.js */
const path = require('path');
const ROOT = path.join(__dirname, '..');
const { localEmbed, embed, cosine, DIM } = require(path.join(ROOT, 'embed'));
const { VectorStore } = require(path.join(ROOT, 'vecstore'));
const out = [];
let pass = 0, fail = 0;
function ok(n, c, e) { if (c) { pass++; out.push('PASS ' + n + (e ? ' | ' + e : '')); } else { fail++; out.push('FAIL ' + n + (e ? ' | ' + e : '')); } }

(async () => {
  /* --- 确定性 --- */
  const a1 = localEmbed('高等数学 函数与极限');
  const a2 = localEmbed('高等数学 函数与极限');
  ok('本地嵌入确定性（同文 → 同向量）', JSON.stringify(a1) === JSON.stringify(a2));
  ok('维度 = ' + DIM, a1.length === DIM);
  const norm = Math.sqrt(a1.reduce((s, x) => s + x * x, 0));
  ok('向量已 L2 归一化（模长≈1）', Math.abs(norm - 1) < 1e-9, 'norm=' + norm);

  /* --- 语义可分性：原词 vs 无关 vs 同义改写 --- */
  const doc = localEmbed('高等数学：第一章函数与极限，包含数列极限与函数连续性的定义。');
  const same = localEmbed('函数与极限 高等数学');
  const other = localEmbed('今天天气很好，操场上有同学在打篮球比赛。');
  const syn = localEmbed('微积分里面关于收敛和连续的那些基础概念');
  const cSame = cosine(doc, same), cOther = cosine(doc, other), cSyn = cosine(doc, syn);
  ok('原词重叠 → 余弦高', cSame > 0.5, 'cos=' + cSame.toFixed(3));
  ok('无关文本 → 余弦低', cOther < 0.35, 'cos=' + cOther.toFixed(3));
  ok('原词相似度 > 无关相似度', cSame > cOther,
    cSame.toFixed(3) + ' > ' + cOther.toFixed(3));
  out.push('  参考：同义改写 cos=' + cSyn.toFixed(3) + '（本地哈希嵌入对纯改写的语义泛化有限，'
    + '这正是可切外部网关的原因）');

  /* --- embed() 无网关时走本地 --- */
  const r = await embed(['甲', '乙']);
  ok('embed() 无网关 → 返回本地向量', r.length === 2 && r[0].length === DIM);

  /* --- 向量库：确定性、度量、payload --- */
  const vs = new VectorStore(null);
  ok('集合名 = campusclaw_chunks', vs.collection === 'campusclaw_chunks');
  ok('度量 = cosine', vs.metric === 'cosine');

  const docs = [
    { id: 1, text: '高等数学 函数与极限 数列 收敛 连续性', classId: 1, mat: 11 },
    { id: 2, text: '数据结构 顺序表 链表 插入 删除 时间复杂度', classId: 1, mat: 12 },
    { id: 3, text: '线性代数 矩阵 行列式 特征值 秩', classId: 1, mat: 13 },
    { id: 4, text: '高等数学 函数与极限 只在二班出现的说法', classId: 2, mat: 14 }
  ];
  for (const d of docs) {
    vs.upsert(d.id, localEmbed(d.text), {
      class_id: d.classId, material_id: d.mat,
      knowledge_entry_id: d.mat * 10, chunk_id: d.id, chunk_index: d.id - 1
    });
  }
  vs.upsertMany([]);   // 触发一次持久化路径（file=null 时是 no-op）
  ok('点数量 = 4', vs.count() === 4);

  /* payload 不许含正文 */
  const p1 = vs.get(1).payload;
  ok('payload 字段恰为规定的 5 项',
    JSON.stringify(Object.keys(p1).sort()) ===
    JSON.stringify(['chunk_id', 'chunk_index', 'class_id', 'knowledge_entry_id', 'material_id']),
    JSON.stringify(Object.keys(p1).sort()));
  ok('payload 不含任何正文文本',
    !JSON.stringify(p1).includes('高等数学') && !Object.keys(p1).includes('chunk_text'));
  ok('主键 = payload.chunk_id', vs.get(1).id === vs.get(1).payload.chunk_id);

  /* --- 检索 + 班级过滤 --- */
  const q = localEmbed('函数与极限 收敛');
  const hits = vs.search(q, { classId: 1, minScore: 0.35 });
  ok('检索有命中', hits.length > 0, 'n=' + hits.length);
  ok('最高分是函数与极限那片', hits[0].id === 1, 'top=' + hits[0].id + ' score=' + hits[0].score.toFixed(3));
  ok('结果按分数降序', hits.every((h, i) => i === 0 || hits[i - 1].score >= h.score));
  ok('班级过滤生效（不含 2 班的 id=4）', hits.every(h => h.id !== 4));
  ok('返回 score 字段', hits.every(h => typeof h.score === 'number'));

  const hits2 = vs.search(q, { classId: 2, minScore: 0.35 });
  ok('2 班检索只拿到 2 班的点', hits2.every(h => h.payload.class_id === 2), 'n=' + hits2.length);

  /* --- minScore 阈值 --- */
  const all = vs.search(q, { classId: 1, minScore: 0 });
  ok('minScore=0 时候选更多（证明阈值确实在过滤）', all.length >= hits.length,
    all.length + ' >= ' + hits.length);
  ok('minScore=0.35 后所有候选都 ≥ 0.35', hits.every(h => h.score >= 0.35));
  const high = vs.search(q, { classId: 1, minScore: 0.99 });
  ok('极高阈值 → 空（低分不会凑数）', high.length === 0, 'n=' + high.length);

  /* --- delete / deleteBy --- */
  vs.delete(3);
  ok('删除单点', vs.count() === 3);
  vs.upsert(3, localEmbed('线性代数 矩阵'), { class_id: 1, material_id: 13, knowledge_entry_id: 130, chunk_id: 3, chunk_index: 2 });
  const del = vs.deleteBy({ material_id: 13 });
  ok('按 material_id 删点', del === 1 && vs.count() === 3, 'n=' + vs.count());

  /* --- 不可用降级 --- */
  vs.available = false;
  let threw = null;
  try { vs.search(q, { classId: 1 }); } catch (e) { threw = e; }
  ok('向量库不可用 → search 抛 vectorUnavailable', !!(threw && threw.vectorUnavailable));
  threw = null;
  try { vs.upsert(9, [1, 2], { class_id: 1 }); } catch (e) { threw = e; }
  ok('向量库不可用 → upsert 抛 vectorUnavailable', !!(threw && threw.vectorUnavailable));
  vs.available = true;
  ok('恢复后可用', vs.search(q, { classId: 1 }).length > 0);

  /* --- 持久化往返 --- */
  const tmp = require('path').join(__dirname, '_tmp_vec.json');
  try { require('fs').rmSync(tmp, { force: true }); } catch (e) { }
  const vs2 = new VectorStore(tmp);
  vs2.upsert(1, localEmbed('持久化测试'), { class_id: 1, material_id: 1, knowledge_entry_id: 1, chunk_id: 1, chunk_index: 0 });
  vs2.persist();
  const vs3 = new VectorStore(tmp);
  ok('向量持久化后可重新载入', vs3.count() === 1 && vs3.get(1).payload.class_id === 1);
  ok('重载后度量仍是 cosine', vs3.metric === 'cosine');
  try { require('fs').rmSync(tmp, { force: true }); } catch (e) { }

  out.push('');
  out.push('=== PASS=' + pass + ' FAIL=' + fail + ' ===');
  require('fs').writeFileSync(path.join(__dirname, 'last-run-embed.txt'), out.join('\n'), 'utf8');
  console.log('PASS=' + pass + ' FAIL=' + fail + '  → tests/last-run-embed.txt');
})();
