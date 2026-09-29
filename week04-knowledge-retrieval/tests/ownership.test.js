/* 课程归属与资料署名回归（这一轮修的线上 bug）：
   1) 教这门课的老师必须能上传 —— 张老师对「高等数学」上传应 201；
   2) 不属于他任教的课必须拒绝；
   3) 界面里的资料署名不能与课表上的教师自相矛盾；
   4) 谁都不该被误标成「管理员」（历史回填曾把无主课程全甩给班里第一个账号）。

   用法：node --experimental-sqlite --no-warnings tests/ownership.test.js
   结果写在 tests/last-run-ownership.txt，临时库在 tests/_tmp_owner（跑完自动删）。

   刻意从空库首启：这样种子材料、回填、建账号都走一遍真实路径。
   空库里没有王老师/赵老师这些账号，正好复现「课表写了某位老师但系统里没有他」的情形。 */
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const { DatabaseSync } = require('node:sqlite');

const ROOT = path.join(__dirname, '..');
const OUT = [];
let pass = 0, fail = 0;
const log = s => OUT.push(s);
function ok(n, c, e) { if (c) { pass++; log('PASS ' + n + (e ? ' | ' + e : '')); } else { fail++; log('FAIL ' + n + (e ? ' | ' + e : '')); } }
function section(t) { log(''); log('--- ' + t + ' ---'); }

const TMP = path.join(__dirname, '_tmp_owner');
fs.rmSync(TMP, { recursive: true, force: true });
fs.mkdirSync(path.join(TMP, 'uploads'), { recursive: true });

const PORT = 8141, B = 'http://127.0.0.1:' + PORT;
const server = spawn(process.execPath, ['--experimental-sqlite', '--no-warnings', 'server.js'], {
  cwd: ROOT,
  env: Object.assign({}, process.env, {
    PORT: String(PORT), HOST: '127.0.0.1', CAMPUSCLAW_DATA_DIR: TMP
  }),
  stdio: 'ignore'
});
const sleep = ms => new Promise(r => setTimeout(r, ms));

async function login(u, pw) {
  const r = await fetch(B + '/api/login', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: u, password: pw })
  });
  const sc = r.headers.getSetCookie ? r.headers.getSetCookie() : [];
  return { status: r.status, cookie: (sc.length ? sc[0] : (r.headers.get('set-cookie') || '')).split(';')[0] };
}
async function jget(p, cookie) {
  const r = await fetch(B + p, { headers: cookie ? { Cookie: cookie } : {} });
  let j = null; try { j = await r.json(); } catch (e) { }
  return { status: r.status, json: j };
}
async function upload(cookie, courseId, name, content) {
  const fd = new FormData();
  fd.append('file', new Blob([Buffer.from(content, 'utf8')], { type: 'text/markdown' }), name);
  const r = await fetch(B + '/api/courses/' + courseId + '/files', {
    method: 'POST', headers: { Cookie: cookie }, body: fd
  });
  let j = null; try { j = await r.json(); } catch (e) { }
  return { status: r.status, json: j };
}

(async () => {
  const t0 = Date.now(); let ready = false;
  while (Date.now() - t0 < 25000) {
    try { if ((await fetch(B + '/health')).ok) { ready = true; break; } } catch (e) { } await sleep(300);
  }
  ok('服务已就绪', ready);
  if (!ready) return finish();

  const z = await login('zhang', '123456');    // 1 班教师
  const a = await login('admin', 'admin123');  // 1 班另一个教师账号
  const s1 = await login('s001', '123456');    // 1 班学生
  ok('账号登录成功', z.status === 200 && a.status === 200 && s1.status === 200);

  const cr = await jget('/api/courses', z.cookie);
  const courses = cr.json || [];
  const byId = new Map(courses.map(c => [c.id, c]));
  ok('课程列表可读', courses.length > 0, 'n=' + courses.length);

  /* ================= 1. 回填不越权：没有「管理员」误标 ================= */
  section('1 历史课程归属回填');
  const adminOwned = courses.filter(c => c.ownerName === '管理员');
  ok('没有把无主课程甩给管理员', adminOwned.length === 0,
    'adminOwned=' + adminOwned.map(c => c.id + ':' + c.subject).join(','));

  /* 张老师教的课必须认得出是他 */
  const math = courses.find(c => c.subject === '高等数学' && c.teacher === '张老师');
  ok('存在一门「高等数学」且任教教师是张老师', !!math);
  if (math) {
    ok('该课 canManage=true', math.canManage === true, 'owner=' + math.ownerName);
    ok('该课 canClaim=false', math.canClaim === false);
  }

  /* ================= 2. 任教教师能上传（本轮修的 bug） ================= */
  section('2 任教教师上传');
  if (math) {
    const up = await upload(z.cookie, math.id, '高数-极限定义.md', '# 极限\n\nε-N 语言。');
    ok('张老师上传自己任教的高等数学 → 201', up.status === 201,
      'status=' + up.status + ' ' + JSON.stringify(up.json).slice(0, 120));
  }

  /* ================= 3. 非任教教师被拒 ================= */
  section('3 越权上传被拒');
  /* 找一门「本班、有归属、且不是张老师」的课；空库里可能没有，
     那就用「管理员任职/他人任职」的路径代替：直接找 canManage=false 且 canClaim=false 的课。 */
  const other = courses.find(c => c.canManage === false && c.canClaim === false);
  const claimable = courses.find(c => c.canClaim === true);
  if (other) {
    const up = await upload(z.cookie, other.id, '越权.md', 'x');
    ok('往别人任教的课上传 → 403', up.status === 403,
      'course=' + other.id + ' status=' + up.status);
  } else {
    log('SKIP 本班没有「他人任教」的课，403 路径未覆盖');
  }
  if (claimable) {
    /* 无归属的课：上传即认领（这是设计行为，不是越权） */
    const cid = claimable.id;
    const up = await upload(z.cookie, cid, '认领探针.md', '认领后应可写。');
    ok('上传无归属课即认领 → 201', up.status === 201, 'course=' + cid + ' status=' + up.status);
    const after = (await jget('/api/courses', z.cookie)).json.find(c => c.id === cid);
    ok('认领后 ownerName 落成张老师', !!after && after.ownerName === '张老师',
      after ? 'owner=' + after.ownerName : 'missing');
  }

  /* ================= 4. 学生不能上传 ================= */
  section('4 学生权限');
  if (math) {
    const up = await upload(s1.cookie, math.id, '学生.md', 'x');
    ok('学生上传 → 403', up.status === 403, 'status=' + up.status);
  }

  /* ================= 5. 资料署名与课表教师不自相矛盾 ================= */
  section('5 资料署名一致性');
  const mr = await jget('/api/materials', z.cookie);
  const mats = (mr.json && mr.json.materials) || [];
  const bad = mats.filter(m => m.uploader && m.course.teacher && m.uploader !== m.course.teacher);
  ok('每份资料的署名都与所在课的教师一致', bad.length === 0,
    bad.map(m => m.name + '(' + m.uploader + '≠' + m.course.teacher + ')').join('; '));

  /* 数据层复核：课程的 owner 与资料 uploaded_by 对得上 */
  const db = new DatabaseSync(path.join(TMP, 'courses.db'));
  const pairs = db.prepare(`
    SELECT c.id, c.subject, c.teacher, c.owner_id,
           (SELECT f.uploaded_by FROM course_files f WHERE f.course_id=c.id LIMIT 1) AS up_id
    FROM courses c WHERE c.owner_id IS NOT NULL
  `).all();
  const drift = pairs.filter(p => p.up_id != null && p.up_id !== p.owner_id);
  ok('有归属的课：资料上传人 = 任教教师', drift.length === 0,
    drift.map(p => p.subject + '(owner=' + p.owner_id + ',up=' + p.up_id + ')').join('; '));
  db.close();

  return finish();
})().catch(e => { log('异常：' + (e && e.stack || e)); fail++; finish(); });

function finish() {
  log('');
  log('PASS=' + pass + ' FAIL=' + fail);
  fs.writeFileSync(path.join(__dirname, 'last-run-ownership.txt'), OUT.join('\n'), 'utf8');
  console.log(OUT.join('\n'));
  try { server.kill(); } catch (e) { }
  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch (e) { }
  setTimeout(() => process.exit(fail ? 1 : 0), 300);
}
