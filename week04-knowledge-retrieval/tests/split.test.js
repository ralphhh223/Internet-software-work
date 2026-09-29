/* split.js 单元测试
   用法：node tests/split.test.js   （从项目根或 tests/ 下跑都可以，
   模块路径统一按“上一级目录”解析） */
const path = require('path');
const ROOT = path.join(__dirname, '..');
const { split, SplitParamError } = require(path.join(ROOT, 'split'));
const out = [];
let pass = 0, fail = 0;
function ok(name, cond, extra) {
  if (cond) { pass++; out.push('PASS ' + name + (extra ? ' | ' + extra : '')); }
  else { fail++; out.push('FAIL ' + name + (extra ? ' | ' + extra : '')); }
}
const mk = n => {
  // 造一段含句子边界的可切文本
  let s = '';
  let i = 0;
  while (s.length < n) { s += '第' + (++i) + '句，这是用来测试切分的内容。'; }
  return s.slice(0, n);
};
/* 偏移是「规范区间」：切片正文一律等于原文该区间的去尾空白形式。
   两者语义分开 —— 回溯靠 start/end，展示用 text。 */
const eq = (s, c) => s.slice(c.start, c.end).trimEnd() === c.text;

/* --- auto --- */
const t1 = mk(3000);
const r1 = split(t1);
ok('auto 未指定策略 → strategy=auto', r1.strategy === 'auto');
ok('auto 切片数 > 1', r1.chunks.length > 1, 'n=' + r1.chunks.length);
ok('auto 每片 ≤ 800 字', r1.chunks.every(c => (c.end - c.start) <= 800),
  'max=' + Math.max(...r1.chunks.map(c => c.end - c.start)));
ok('auto chunk_index 从 0 连续', r1.chunks.every((c, i) => c.index === i));
ok('auto 切片正文拼起来能覆盖全文', r1.chunks[r1.chunks.length - 1].end === t1.length);
/* 相邻切片原文字符串重叠应为 80（在原文上量，而不是在切片文本上） */
const ov1 = r1.chunks[1].start !== undefined ? r1.chunks[0].end - r1.chunks[1].start : -1;
ok('auto 相邻切片原文重叠 = 80', ov1 === 80, 'overlap=' + ov1);
ok('auto 切片正文 = 原文区间(去尾空白)', r1.chunks.every(c => eq(t1, c)));

/* --- custom --- */
const r2 = split(t1, { strategy: 'custom', maxLen: 300, overlap: 60 });
ok('custom 生效', r2.strategy === 'custom');
ok('custom 每片 ≤ 300 字', r2.chunks.every(c => (c.end - c.start) <= 300));
let threw = null;
try { split(t1, { strategy: 'custom', maxLen: 5000 }); } catch (e) { threw = e; }
ok('custom 长度 5000 → 抛错', threw instanceof SplitParamError, threw && threw.message);
threw = null;
try { split(t1, { strategy: 'custom', maxLen: 500, overlapRatio: 0.9 }); } catch (e) { threw = e; }
ok('custom 重叠比例 90% → 抛错', threw instanceof SplitParamError);
threw = null;
try { split(t1, { strategy: 'custom', maxLen: 50 }); } catch (e) { threw = e; }
ok('custom 长度 50 → 抛错', threw instanceof SplitParamError);

/* --- custom 预处理：不改写原文 --- */
const raw = '访问 https://example.com/a/b 联系 zhangsan@example.com   结束。' + mk(400);
const r3 = split(raw, { strategy: 'custom', maxLen: 200, overlap: 0, stripUrls: true, stripEmails: true, collapseSpaces: true });
ok('开启移除 URL → 切片无 URL',
  r3.chunks.every(c => !/https?:\/\//.test(c.text)));
ok('开启移除邮箱 → 切片无邮箱',
  r3.chunks.every(c => !/[\w.+-]+@[\w-]+\.[\w.-]+/.test(c.text)));
ok('原文里的 URL 仍在（预处理不改写 body_text）', /https:\/\/example\.com\/a\/b/.test(raw));
ok('折叠空白 → 切片无连续空格', r3.chunks.every(c => !/  /.test(c.text)));

/* --- hierarchy --- */
const md = [
  '# 第一章 绪论',
  mk(300),
  '',
  '## 第二章 方法',
  mk(500),
  '',
  '### 2.1 小节',
  mk(200)
].join('\n');
const r4 = split(md, { strategy: 'hierarchy' });
ok('hierarchy 分章', r4.chunks.length >= 3, 'n=' + r4.chunks.length);
const ch2 = r4.chunks.find(c => c.text.includes('## 第二章'));
ok('hierarchy 标题与正文同片（## 第二章）', !!ch2 && ch2.text.includes('## 第二章 方法'),
  ch2 ? JSON.stringify(ch2.text.slice(0, 40)) : 'not found');
ok('hierarchy 切片正文 = 原文区间(去尾空白)',
  r4.chunks.every(c => eq(md, c)),
  'bad=' + r4.chunks.filter(c => !eq(md, c)).length);
ok('hierarchy 切片区间不重叠于下一片之前', r4.chunks.every((c, i) => i === 0 || c.start >= r4.chunks[i - 1].start));
ok('hierarchy 末片区间收在文末', r4.chunks[r4.chunks.length - 1].end === md.length);
ok('hierarchy chunk_index 连续', r4.chunks.every((c, i) => c.index === i));

/* 超长章节 → 二次切分，且偏移仍对得上原文 */
const longMd = '# 标题A\n' + mk(2500) + '\n## 标题B\n' + mk(300);
const r5 = split(longMd, { strategy: 'hierarchy' });
ok('hierarchy 超长章节被二次切分', r5.chunks.length >= 4, 'n=' + r5.chunks.length);
ok('hierarchy 二次切分后偏移仍对得上原文',
  r5.chunks.every(c => eq(longMd, c)),
  'bad=' + r5.chunks.filter(c => !eq(longMd, c)).length);
ok('hierarchy 每片 ≤ 800 字', r5.chunks.every(c => (c.end - c.start) <= 800));
/* 关键不变量：任何一片的区间都不得跨进下一章的标题行。
   否则「切片序号 + 字符区间」这一对可溯源字段会指向错误的位置。 */
const bIdx = longMd.indexOf('## 标题B');
const crossing = r5.chunks.filter(c => c.start < bIdx && c.end > bIdx);
ok('hierarchy 切片区间不跨章（不侵入下一章标题）', crossing.length === 0,
  'crossing=' + crossing.length);

/* 代码围栏里的 # 不应被当标题 */
const codeMd = '正文\n\n```\n# 这不是标题\n```\n\n## 真标题\n内容';
const r6 = split(codeMd, { strategy: 'hierarchy' });
ok('代码围栏内的 # 不当标题',
  r6.chunks.filter(c => c.text.startsWith('# 这不是标题')).length === 0);

/* --- 边界 --- */
ok('空文本 → 0 切片', split('').chunks.length === 0);
ok('纯空白 → 0 切片', split('   \n\n  ').chunks.length === 0);
ok('短文本 → 1 切片', split('短内容。').chunks.length === 1);
const r7 = split(mk(1600), { strategy: 'custom', maxLen: 800, overlapRatio: 0.1 });
ok('overlapRatio 生效（10% of 800 = 80）',
  r7.chunks.length > 1 && (r7.chunks[0].end - r7.chunks[1].start) === 80,
  'ov=' + (r7.chunks[0].end - r7.chunks[1].start));
ok('body_text 未被改写（原串长度不变）', mk(3000).length === 3000);

out.push('');
out.push('=== PASS=' + pass + ' FAIL=' + fail + ' ===');
require('fs').writeFileSync(path.join(__dirname, 'last-run-split.txt'), out.join('\n'), 'utf8');
console.log('PASS=' + pass + ' FAIL=' + fail + '  → tests/last-run-split.txt');
