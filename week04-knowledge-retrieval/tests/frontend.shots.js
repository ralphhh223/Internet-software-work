/* 第 4 课前端取证：用真实浏览器登录 → 打开「知识库检索」→ 截图。
   用法：node --experimental-sqlite --no-warnings tests/frontend.shots.js
   步骤：起服务 → CDP 连 Edge → 填账号 → 切标签 → 输入问句 → 检索 → 截屏。
   每种角色/场景各一张图。 */
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
/* 本项目零依赖：用 Node 内置的 WebSocket（v22 起为全局），不装 ws 包。 */
const WebSocketImpl = globalThis.WebSocket;

const ROOT = path.join(__dirname, '..');   // server.js 在上一级
const TMP = path.join(__dirname, '_tmp_shot');
fs.rmSync(TMP, { recursive: true, force: true });
fs.mkdirSync(path.join(TMP, 'uploads'), { recursive: true });

const PORT = 8211, B = 'http://127.0.0.1:' + PORT;
const CDP = 9444;
const EDGE = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const PROFILE = path.join(TMP, 'edge-profile');
const SHOTS = path.join(ROOT, '第4课证据');
fs.mkdirSync(SHOTS, { recursive: true });

const srv = spawn(process.execPath, ['--experimental-sqlite', '--no-warnings', 'server.js'], {
  cwd: ROOT,
  env: Object.assign({}, process.env, {
    PORT: String(PORT), HOST: '127.0.0.1', CAMPUSCLAW_DATA_DIR: TMP,
    /* 第 8 节要从前端观察「向量库掉线 → 503」的界面表现，
       所以打开测试钩子（钩子本身仍需登录，不是公开接口）。 */
    CAMPUSCLAW_TEST_HOOKS: '1'
  }),
  stdio: 'ignore'
});
const edge = spawn(EDGE, [
  '--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
  '--remote-debugging-port=' + CDP, '--remote-allow-origins=*',
  '--user-data-dir=' + PROFILE, '--window-size=1280,1000',
  '--hide-scrollbars', 'about:blank'
], { stdio: 'ignore' });

const sleep = ms => new Promise(r => setTimeout(r, ms));
const log = [];
let ws = null, id = 0;
const pend = new Map();

function send(method, params, sessionId) {
  const msg = { id: ++id, method, params: params || {} };
  if (sessionId) msg.sessionId = sessionId;
  ws.send(JSON.stringify(msg));
  return new Promise((res, rej) => {
    pend.set(msg.id, { res, rej });
    setTimeout(() => { if (pend.has(msg.id)) { pend.delete(msg.id); rej(new Error('timeout ' + method)); } }, 25000);
  });
}

async function evaluate(expr, sessionId) {
  const r = await send('Runtime.evaluate', {
    expression: expr, returnByValue: true, awaitPromise: true
  }, sessionId);
  if (r.exceptionDetails) throw new Error('eval: ' + JSON.stringify(r.exceptionDetails).slice(0, 300));
  return r.result && r.result.value;
}

async function shot(name) {
  const r = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true }, sessionId);
  const f = path.join(SHOTS, name);
  fs.writeFileSync(f, Buffer.from(r.data, 'base64'));
  log.push('  截图 ' + name + ' (' + Math.round(fs.statSync(f).size / 1024) + ' KB)');
  return f;
}

let sessionId = null;

(async () => {
  /* 等 HTTP 与 CDP 都就绪 */
  let ok = false;
  for (let i = 0; i < 60; i++) { try { if ((await fetch(B + '/health')).ok) { ok = true; break; } } catch (e) { } await sleep(400); }
  log.push('服务就绪 ' + ok);
  if (!ok) throw new Error('服务没起来');
  await sleep(5000);   // 等启动索引

  let ver = null;
  for (let i = 0; i < 40; i++) {
    try { ver = await (await fetch('http://127.0.0.1:' + CDP + '/json/version')).json(); break; } catch (e) { } await sleep(400);
  }
  if (!ver) throw new Error('CDP 没起来');
  log.push('浏览器 ' + ver.Browser);

  const tgt = await (await fetch('http://127.0.0.1:' + CDP + '/json/new?' + encodeURIComponent(B + '/'), { method: 'PUT' })).json();
  ws = new WebSocketImpl(tgt.webSocketDebuggerUrl);
  await new Promise((res, rej) => {
    ws.addEventListener('open', res, { once: true });
    ws.addEventListener('error', e => rej(new Error('WS 连接失败')), { once: true });
  });
  ws.addEventListener('message', ev => {
    let m; try { m = JSON.parse(typeof ev.data === 'string' ? ev.data : Buffer.from(ev.data).toString('utf8')); } catch (e) { return; }
    if (m.id && pend.has(m.id)) {
      const p = pend.get(m.id); pend.delete(m.id);
      if (m.error) p.rej(new Error(m.error.message)); else p.res(m.result);
    }
  });
  await send('Page.enable');
  await send('Runtime.enable');
  await sleep(1200);

  async function goto(url) {
    await send('Page.navigate', { url });
    await sleep(1600);
  }
  async function login(u, pw) {
    await goto(B + '/');
    await evaluate(`(async()=>{
      const $=s=>document.querySelector(s);
      $('#l-user').value=${JSON.stringify(u)};
      $('#l-pass').value=${JSON.stringify(pw)};
      $('#login-form').dispatchEvent(new Event('submit',{cancelable:true,bubbles:true}));
      return 1;
    })()`);
    await sleep(1800);
    const who = await evaluate(`(document.getElementById('scope-user')||{}).textContent||''`);
    log.push('  登录 ' + u + ' → ' + who);
    return who;
  }
  async function openRetrieval() {
    await evaluate(`document.querySelector('#app-tabs .tab[data-pane="retrieval"]').click(); 1`);
    await sleep(1500);
  }
  async function search(q, mode, ask) {
    await evaluate(`(()=>{
      const $=s=>document.querySelector(s);
      $('#ret-q').value=${JSON.stringify(q)};
      document.querySelector('input[name="ret-mode"][value=${JSON.stringify(mode)}]').checked=true;
      document.querySelector('input[name="ret-mode"][value=${JSON.stringify(mode)}]').dispatchEvent(new Event('change',{bubbles:true}));
      $('#ret-ask').checked=${ask ? 'true' : 'false'};
      $('#ret-form').dispatchEvent(new Event('submit',{cancelable:true,bubbles:true}));
      return 1;
    })()`);
    await sleep(2600);
    return await evaluate(`(()=>({
      hits: document.querySelectorAll('#ret-hits .hit').length,
      sum: (document.getElementById('ret-sum')||{}).textContent||'',
      empty: !document.getElementById('ret-empty').hidden ? document.getElementById('ret-empty').textContent : '',
      ask: document.getElementById('ask-box').hidden ? '' : document.getElementById('ask-text').textContent,
      err: document.getElementById('ret-err').hidden ? '' : document.getElementById('ret-err').textContent
    }))()`);
  }

  /* ---------- 1. 教师：hybrid 检索 ---------- */
  log.push('');
  log.push('== 1 教师 hybrid 检索 ==');
  await login('zhang', '123456');
  await openRetrieval();
  const r1 = await search('数列极限的严格定义', 'hybrid', false);
  log.push('  命中 ' + r1.hits + ' 条 | ' + r1.sum);
  if (r1.err) log.push('  ERR ' + r1.err);
  await shot('01-教师-hybrid检索.png');

  /* ---------- 2. 教师：vector 模式 ---------- */
  log.push('');
  log.push('== 2 教师 vector 模式 ==');
  const r2 = await search('数列极限的严格定义', 'vector', false);
  log.push('  命中 ' + r2.hits + ' 条 | ' + r2.sum);
  await shot('02-教师-vector语义检索.png');

  /* ---------- 3. keyword 模式：同义改写落空 ---------- */
  log.push('');
  log.push('== 3 keyword vs 语义（同义改写） ==');
  const r3 = await search('收敛和连续的基础概念', 'keyword', false);
  log.push('  keyword 同义改写命中 ' + r3.hits + ' 条');
  const r3v = await search('收敛和连续的基础概念', 'vector', false);
  log.push('  vector  同义改写命中 ' + r3v.hits + ' 条');
  await shot('03-keyword同义改写对照.png');

  /* ---------- 4. 没找到：固定文案 ---------- */
  log.push('');
  log.push('== 4 无依据 → 固定文案 ==');
  const r4 = await search('今天天气怎么样啊', 'vector', false);
  log.push('  命中 ' + r4.hits + ' 条 | 空态文案="' + r4.empty + '"');
  await shot('04-未找到-固定文案.png');

  /* ---------- 5. 学生：检索 + 问答 ---------- */
  log.push('');
  log.push('== 5 学生检索 + 问答 ==');
  const who5 = await login('s001', '123456');
  await openRetrieval();
  const r5 = await search('数列极限是怎么定义的', 'hybrid', true);
  log.push('  命中 ' + r5.hits + ' 条 | ' + r5.sum);
  log.push('  回答: ' + String(r5.ask).replace(/\n/g, ' / ').slice(0, 120));
  await shot('05-学生-带问答.png');

  /* 学生看不到重建索引 */
  const stuRe = await evaluate(`(()=>{
    const b=document.getElementById('reindex-box');
    const btns=document.querySelectorAll('#ret-hits button[data-reindex]');
    return { boxHidden: b.hidden, shownBtns: [...btns].filter(x=>!x.hidden).length, total: btns.length };
  })()`);
  log.push('  学生侧重建索引：面板隐藏=' + stuRe.boxHidden + '，卡片上可点按钮 ' + stuRe.shownBtns + '/' + stuRe.total);

  /* ---------- 6. 跨班隔离 ---------- */
  log.push('');
  log.push('== 6 跨班隔离（1 班学生搜 2 班独有词） ==');
  const r6 = await search('CRC 循环冗余检验', 'keyword', false);
  log.push('  命中 ' + r6.hits + ' 条 | 空态文案="' + r6.empty + '"');
  await shot('06-学生-跨班检索为空.png');

  /* ---------- 7. 2 班学生搜同一词 ---------- */
  log.push('');
  log.push('== 7 2 班学生搜同一词（证明隔离而非缺数据） ==');
  const who7 = await login('s002', '123456');
  await openRetrieval();
  const r7 = await search('CRC 循环冗余检验', 'hybrid', false);
  log.push('  ' + who7 + ' 命中 ' + r7.hits + ' 条');
  await shot('07-二班学生-同词有命中.png');

  /* ---------- 8. 降级：向量库掉线时前端如实报错 ---------- */
  log.push('');
  log.push('== 8 降级：向量库不可用时 vector 的提示 ==');
  await login('zhang', '123456');
  await openRetrieval();
  /* 用同源的 fetch 打测试钩子（钩子仍需登录，会话 Cookie 已就位） */
  const flipOn = await evaluate(`(async()=>{
    const r = await fetch('/api/retrieval/__test__/outage',{method:'POST',
      headers:{'Content-Type':'application/json'},body:JSON.stringify({on:true})});
    return r.status + ' ' + JSON.stringify(await r.json());
  })()`);
  log.push('  钩子置为掉线：' + flipOn);
  const r8 = await search('数列极限的严格定义', 'vector', false);
  log.push('  命中 ' + r8.hits + ' 条 | 报错提示="' + r8.err + '"');
  await shot('08-降级-向量库不可用.png');
  /* keyword 不受影响 */
  const r8k = await search('数列极限的严格定义', 'keyword', false);
  log.push('  同一时刻 keyword 命中 ' + r8k.hits + ' 条（关键字路不受向量库影响）');
  await shot('09-降级-关键字仍可用.png');
  await evaluate(`fetch('/api/retrieval/__test__/outage',{method:'POST',
    headers:{'Content-Type':'application/json'},body:JSON.stringify({on:false})})`);
  await sleep(500);

  /* ---------- 10. 教师：重建索引（custom 策略） ---------- */
  log.push('');
  log.push('== 10 教师按策略重建索引 ==');
  await login('zhang', '123456');
  await openRetrieval();
  const r10a = await search('顺序表插入元素的时间复杂度', 'keyword', false);
  log.push('  重建前 keyword 命中 ' + r10a.hits + ' 条');
  await evaluate(`(async()=>{
    const $=s=>document.querySelector(s);
    const b=document.querySelector('#ret-hits button[data-reindex]');
    if(b) b.click();
    return 1;
  })()`);
  await sleep(700);
  const boxState = await evaluate(`(()=>{
    const b=document.getElementById('reindex-box');
    document.getElementById('re-strategy').value='custom';
    document.getElementById('re-strategy').dispatchEvent(new Event('change',{bubbles:true}));
    document.getElementById('re-max').value='200';
    document.getElementById('re-ov').value='20';
    return { shown: !b.hidden, target: document.getElementById('re-target').textContent.trim(),
             maxShown: !document.getElementById('re-max-wrap').hidden };
  })()`);
  log.push('  重建面板：显示=' + boxState.shown + '，custom 字段展开=' + boxState.maxShown);
  log.push('  ' + boxState.target);
  await shot('10-教师-重建索引面板.png');
  /* 真提交一次 */
  const r10b = await evaluate(`(async()=>{
    document.getElementById('reindex-form').dispatchEvent(new Event('submit',{cancelable:true,bubbles:true}));
    return 1;
  })()`);
  await sleep(3000);
  const afterTxt = await evaluate(`(()=>{
    const t=document.getElementById('toast');
    return { toast: t.hidden?'':t.textContent,
             sum: (document.getElementById('ret-sum')||{}).textContent||'',
             hits: document.querySelectorAll('#ret-hits .hit').length,
             err: document.getElementById('ret-err').hidden?'':document.getElementById('ret-err').textContent };
  })()`);
  log.push('  重建回执: ' + afterTxt.toast);
  log.push('  重建后 ' + afterTxt.sum + ' | 命中 ' + afterTxt.hits + ' 条');
  if (afterTxt.err) log.push('  ERR ' + afterTxt.err);
  await shot('11-教师-重建后结果.png');

  log.push('');
  log.push('取证完成');
  fs.writeFileSync(path.join(__dirname, 'last-run-shots.txt'), log.join('\n'), 'utf8');

  try { ws && ws.close(); } catch (e) { }
  try { edge.kill(); } catch (e) { }
  try { srv.kill(); } catch (e) { }
  await sleep(600);
  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch (e) { }
  process.exit(0);
})().catch(e => {
  log.push('EXCEPTION ' + (e && e.stack || e));
  try { ws && ws.close(); } catch (x) { }
  try { edge.kill(); } catch (x) { }
  try { srv.kill(); } catch (x) { }
  fs.writeFileSync(path.join(__dirname, 'last-run-shots.txt'), log.join('\n'), 'utf8');
  process.exit(1);
});
