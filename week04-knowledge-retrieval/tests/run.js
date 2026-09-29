/*
 * 第 4 课测试总入口：node tests/run.js
 * 依次跑三个套件，任一失败则整体非零退出。
 */
const { spawnSync } = require('child_process');
const path = require('path');

const NODE = process.execPath;
const ROOT = path.join(__dirname, '..');

/* e2e 要起真服务并读 sqlite，得带上 flag；单元测试不需要但带上也无害 */
const SUITES = [
  { name: '切分策略 (split)', file: 'split.test.js', flags: [] },
  { name: '嵌入与向量库 (embed + vecstore)', file: 'embed-vecstore.test.js', flags: [] },
  { name: '后端端到端 (retrieval e2e)', file: 'retrieval.e2e.js', flags: ['--experimental-sqlite', '--no-warnings'] },
  { name: '课程归属与资料署名 (ownership)', file: 'ownership.test.js', flags: ['--experimental-sqlite', '--no-warnings'] }
];

let bad = 0;
for (const s of SUITES) {
  console.log('\n==== ' + s.name + ' ====');
  const r = spawnSync(NODE, [...s.flags, path.join(__dirname, s.file)], {
    cwd: ROOT, stdio: 'inherit'
  });
  if (r.status !== 0) bad++;
}

console.log('\n===============================');
console.log(bad ? '有 ' + bad + ' 个套件未通过' : '全部套件通过');
process.exit(bad ? 1 : 0);
