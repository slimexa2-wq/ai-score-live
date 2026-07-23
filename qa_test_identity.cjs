'use strict';
/* ============================================================
 *  QA 回归验证脚本·身份唯一性功能（严过关）
 *  ----------------------------------------------------------
 *  被测功能：评委身份唯一性 + 同一评委对同一作品仅能评分一次
 *  验证点（共 6 项）：
 *    1. 评委+作品唯一：重复提交返回 409，且 error 含「已对作品《...》评过分」
 *    2. 换作品可提交：同一评委换 workName 应成功（200）
 *    3. 换评委可提交：不同 judgeName 对同一 workName 应成功（200）
 *    4. GET /api/used-judges 结构：{ ok, used: { leader:{name:[w]}, public:{name:[w]} } }
 *    5. 清空释放：POST /api/clear 后原组合可再次提交（200），且 used 为空映射
 *    6. 不破坏原功能：四维 1-10 整数校验、加权分、统计聚合、SSE 广播仍正常
 *  ----------------------------------------------------------
 *  执行方式：本脚本以子进程启动 server.js（PORT=3302，独立 DATA_DIR），
 *            用 Node 22 全局 fetch 发请求，结束自动关闭子进程。
 * ============================================================ */

const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');

const ROOT = __dirname;
const PORT = 3302;
const BASE = `http://127.0.0.1:${PORT}`;
// 使用独立数据目录，避免污染正式 data/scores.json
const DATA_DIR = path.join(ROOT, '.qa_identity_tmp');

// ---- 结果收集 ----
const results = [];
function record(name, pass, detail) {
  results.push({ name, pass, detail });
  console.log(`${pass ? '✅ PASS' : '❌ FAIL'} | ${name}\n      ${detail}`);
}

// ---- HTTP 助手 ----
async function postScore(body) {
  const resp = await fetch(BASE + '/api/score', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  let data = null;
  try { data = await resp.json(); } catch (_) {}
  return { status: resp.status, data };
}
async function getJson(p) {
  const resp = await fetch(BASE + p);
  let data = null;
  try { data = await resp.json(); } catch (_) {}
  return { status: resp.status, data };
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function weightedScore(s) {
  return Number(
    (s.innovation * 0.30 + s.practicality * 0.40 + s.quality * 0.20 + s.presentation * 0.10).toFixed(2)
  );
}

// 等待服务端就绪
async function waitReady(timeoutMs = 8000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const r = await fetch(BASE + '/api/stats');
      if (r.ok) return true;
    } catch (_) {}
    await sleep(150);
  }
  return false;
}

// ============================================================
//  主流程
// ============================================================
(async () => {
  // 确保独立数据目录干净
  if (fs.existsSync(DATA_DIR)) {
    fs.rmSync(DATA_DIR, { recursive: true, force: true });
  }
  fs.mkdirSync(DATA_DIR, { recursive: true });

  // ---- 启动 server.js 子进程 ----
  const serverProc = spawn(process.execPath, ['server.js'], {
    cwd: ROOT,
    env: { ...process.env, PORT: String(PORT), DATA_DIR },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let serverErr = '';
  serverProc.stderr.on('data', (d) => { serverErr += d.toString(); });

  const started = await waitReady();
  if (!started) {
    record('环境·服务端启动成功', false, 'server.js 在 ' + PORT + ' 未在超时内就绪，stderr=' + serverErr);
    serverProc.kill('SIGKILL');
    finish();
    return;
  }
  record('环境·服务端成功启动(PORT=' + PORT + ',独立DATA_DIR)', true, 'stats 接口已可访问');

  // 先清空，保证从干净状态开始（防御性）
  await postClearAndExpect();

  // ---------- 验证点 1：评委+作品唯一（重复提交 409） ----------
  const baseBody = { judgeType: 'leader', judgeName: '龙章其', workName: '人力资源部(雪梨队)', innovation: 9, practicality: 8, quality: 7, presentation: 9 };
  const r1a = await postScore(baseBody);
  record('验证点1·首次提交成功(200,ok:true)',
    r1a.status === 200 && r1a.data && r1a.data.ok === true,
    `status=${r1a.status}, ok=${r1a.data && r1a.data.ok}`);

  const r1b = await postScore(baseBody); // 完全相同的 judgeType+judgeName+workName
  const errMsg = (r1b.data && r1b.data.error) || '';
  record('验证点1·重复提交返回 409',
    r1b.status === 409,
    `status=${r1b.status}(期望409)`);
  record('验证点1·error 含「已对作品《...》评过分」',
    r1b.status === 409 && errMsg.includes('已对作品《') && errMsg.includes('》评过分') && errMsg.includes('人力资源部(雪梨队)'),
    `error="${errMsg}"`);

  // ---------- 验证点 2：同一评委换作品可提交 ----------
  const r2 = await postScore({ ...baseBody, workName: '保安子公司(勇敢牛牛队)' });
  record('验证点2·同一评委换作品成功(200)',
    r2.status === 200 && r2.data && r2.data.ok === true,
    `status=${r2.status}, ok=${r2.data && r2.data.ok}`);

  // ---------- 验证点 3：换评委对同一作品可提交 ----------
  const r3 = await postScore({ ...baseBody, judgeName: '景主席' }); // 同 workName=人力资源部(雪梨队)
  record('验证点3·不同评委同作品成功(200)',
    r3.status === 200 && r3.data && r3.data.ok === true,
    `status=${r3.status}, ok=${r3.data && r3.data.ok}`);

  // 同时再放一个 public 类型，便于验证 used-judges 分组
  await postScore({ judgeType: 'public', judgeName: '第一组', workName: '人力资源部(雪梨队)', innovation: 8, practicality: 7, quality: 6, presentation: 9 });

  // ---------- 验证点 4：GET /api/used-judges 结构 ----------
  const uj = await getJson('/api/used-judges');
  const used = (uj.data && uj.data.used) || null;
  const okStruct =
    uj.status === 200 &&
    uj.data && uj.data.ok === true &&
    used && typeof used === 'object' &&
    used.leader && typeof used.leader === 'object' &&
    used.public && typeof used.public === 'object';
  record('验证点4·结构 { ok:true, used:{leader:{},public:{}} }',
    okStruct,
    `status=${uj.status}, ok=${uj.data && uj.data.ok}, hasLeader=${!!(used && used.leader)}, hasPublic=${!!(used && used.public)}`);

  // leader 分组：龙章其→[人力资源部(雪梨队),保安子公司(勇敢牛牛队)]; 景主席→[人力资源部(雪梨队)]
  const leaderMap = (used && used.leader) || {};
  const lzq = leaderMap['龙章其'] || [];
  const jzxt = leaderMap['景主席'] || [];
  record('验证点4·leader 分组->评委→[作品]映射正确',
    lzq.includes('人力资源部(雪梨队)') && lzq.includes('保安子公司(勇敢牛牛队)') &&
    jzxt.length === 1 && jzxt[0] === '人力资源部(雪梨队)',
    `龙章其=${JSON.stringify(lzq)}, 景主席=${JSON.stringify(jzxt)}`);

  const publicMap = (used && used.public) || {};
  record('验证点4·public 分组含第一组→[人力资源部(雪梨队)]',
    (publicMap['第一组'] || []).includes('人力资源部(雪梨队)'),
    `public.第一组=${JSON.stringify(publicMap['第一组'])}`);

  // 去重：龙章其出现两次不同作品，不应出现重复项
  record('验证点4·同一评委多作品时 workName 去重(无重复元素)',
    lzq.length === new Set(lzq).size,
    `龙章其作品列表=${JSON.stringify(lzq)}`);

  // ---------- 验证点 5：清空释放 ----------
  // 先记录占用组合
  const occupied = { judgeType: 'leader', judgeName: '龙章其', workName: '人力资源部(雪梨队)' };

  // 清空
  const clr = await fetch(BASE + '/api/clear', { method: 'POST' });
  let clrData = null; try { clrData = await clr.json(); } catch (_) {}
  record('验证点5·POST /api/clear 返回 200 ok:true',
    clr.status === 200 && clrData && clrData.ok === true,
    `status=${clr.status}, ok=${clrData && clrData.ok}`);

  // 清空后 used-judges 应为空映射
  // 注意：清空后服务端 used={}，leader/public 键可能直接不存在，
  //       因此用「取不到则按空对象处理」的方式判定是否为空。
  const ujAfter = await getJson('/api/used-judges');
  const usedAfter = (ujAfter.data && ujAfter.data.used) || {};
  const leaderObj = (usedAfter.leader && typeof usedAfter.leader === 'object') ? usedAfter.leader : {};
  const publicObj = (usedAfter.public && typeof usedAfter.public === 'object') ? usedAfter.public : {};
  const leaderEmpty = Object.keys(leaderObj).length === 0;
  const publicEmpty = Object.keys(publicObj).length === 0;
  record('验证点5·清空后 /api/used-judges 返回空映射',
    leaderEmpty && publicEmpty,
    `leaderKeys=${Object.keys(leaderObj).length}, publicKeys=${Object.keys(publicObj).length}`);

  // 原占用组合再次提交应成功（200）
  const r5 = await postScore({
    judgeType: occupied.judgeType, judgeName: occupied.judgeName, workName: occupied.workName,
    innovation: 6, practicality: 6, quality: 6, presentation: 6,
  });
  record('验证点5·清空后原组合可再次提交(200)',
    r5.status === 200 && r5.data && r5.data.ok === true,
    `status=${r5.status}, ok=${r5.data && r5.data.ok}`);

  // ---------- 验证点 6：不破坏原功能 ----------
  // 6a. 四维 1-10 整数校验（边界与非法）
  const beforeInvalid = await getJson('/api/stats');
  const baselineCount = beforeInvalid.data.totalRecords;
  const invalidCases = [
    ['四维越界(innovation=11)', { judgeType: 'leader', judgeName: 'X', workName: 'Y', innovation: 11, practicality: 5, quality: 5, presentation: 5 }],
    ['四维越界(innovation=0)', { judgeType: 'leader', judgeName: 'X', workName: 'Y', innovation: 0, practicality: 5, quality: 5, presentation: 5 }],
    ['非整数(innovation=5.5)', { judgeType: 'leader', judgeName: 'X', workName: 'Y', innovation: 5.5, practicality: 5, quality: 5, presentation: 5 }],
    ['judgeType 非法', { judgeType: 'admin', judgeName: 'X', workName: 'Y', innovation: 5, practicality: 5, quality: 5, presentation: 5 }],
  ];
  let allInvalidOk = true;
  const invalidDetails = [];
  for (const [label, body] of invalidCases) {
    const r = await postScore(body);
    const ok = r.status === 400 && r.data && r.data.ok === false;
    if (!ok) { allInvalidOk = false; invalidDetails.push(`${label}:status=${r.status}`); }
    else invalidDetails.push(`${label}:400✓`);
  }
  const afterInvalid = await getJson('/api/stats');
  record('验证点6a·非法四维/类型全部返回 400', allInvalidOk, invalidDetails.join(' | '));
  record('验证点6a·非法提交未写入数据', afterInvalid.data.totalRecords === baselineCount,
    `清空前记录基线=${baselineCount}, 提交非法后=${afterInvalid.data.totalRecords}`);

  // 6b. 加权分计算正确（手动对账）
  const wsBody = { judgeType: 'leader', judgeName: '徐万霞', workName: '公共事务部(美少女战士队)', innovation: 10, practicality: 9, quality: 8, presentation: 7 };
  const expectWs = weightedScore({ innovation: 10, practicality: 9, quality: 8, presentation: 7 }); // 10*.3+9*.4+8*.2+7*.1=9.10
  const r6b = await postScore(wsBody);
  record('验证点6b·加权分计算正确(手算 9.10)',
    r6b.data && r6b.data.record && r6b.data.record.weightedScore === expectWs,
    `返回=${r6b.data && r6b.data.record && r6b.data.record.weightedScore}, 期望=${expectWs}`);

  // 6c. 统计聚合（totalWorks / totalRecords / works 列表非空且含作品）
  const st = await getJson('/api/stats');
  const worksArr = (st.data && st.data.works) || [];
  record('验证点6c·统计聚合正常(totalWorks≥1,totalRecords≥1)',
    st.data && st.data.totalWorks >= 1 && st.data.totalRecords >= 1 && worksArr.length >= 1,
    `totalWorks=${st.data && st.data.totalWorks}, totalRecords=${st.data && st.data.totalRecords}, worksCount=${worksArr.length}`);

  // 6d. SSE 广播：连接后数秒内收到含新数据的 stats 事件
  const sse = await openSSE();
  const gotInitial = await waitFor(() => sse.events.some((e) => e.event === 'stats'), 5000);
  const sseWork = 'SSE广播验证队';
  const before = (await getJson('/api/stats')).data.totalRecords;
  await postScore({ judgeType: 'leader', judgeName: '肖小松', workName: sseWork, innovation: 5, practicality: 5, quality: 5, presentation: 5 });
  const gotPush = await waitFor(() => {
    return sse.events.some((e) => {
      if (e.event !== 'stats') return false;
      try {
        const d = JSON.parse(e.data);
        return d.totalRecords === before + 1 && d.works.some((w) => w.workName === sseWork);
      } catch (_) { return false; }
    });
  }, 8000);
  try { sse.req.destroy(); } catch (_) {}
  record('验证点6d·SSE 连接即收到 stats 快照', gotInitial, `initialSnapshot=${gotInitial}`);
  record('验证点6d·新评分后 SSE 推送含新作品的 stats', gotPush, `pushReceived=${gotPush}`);

  // ---------- 收尾 ----------
  serverProc.kill('SIGKILL');
  finish();
})().catch((e) => {
  console.error('测试脚本异常：', e);
  process.exit(2);
});

// ---- SSE 客户端 ----
function openSSE() {
  const http = require('http');
  return new Promise((resolve) => {
    const req = http.get(BASE + '/api/stream', (res) => {
      let buf = '';
      const events = [];
      res.setEncoding('utf8');
      res.on('data', (chunk) => {
        buf += chunk;
        let i;
        while ((i = buf.indexOf('\n\n')) !== -1) {
          const raw = buf.slice(0, i);
          buf = buf.slice(i + 2);
          let ev = 'message', data = '';
          for (const line of raw.split('\n')) {
            if (line.startsWith('event:')) ev = line.slice(6).trim();
            else if (line.startsWith('data:')) data += line.slice(5).trim();
          }
          events.push({ event: ev, data });
        }
      });
      resolve({ req, res, events });
    });
  });
}

async function waitFor(fn, timeoutMs, interval = 100) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try { if (await fn()) return true; } catch (_) {}
    await sleep(interval);
  }
  return false;
}

async function postClearAndExpect() {
  // 防御性清空（不影响验证点5，验证点5 会在已占用状态下再次清空并断言）
  try {
    await fetch(BASE + '/api/clear', { method: 'POST' });
  } catch (_) {}
  await sleep(100);
}

function finish() {
  const passed = results.filter((r) => r.pass).length;
  const failed = results.length - passed;
  console.log('\n==============================================');
  console.log(`  身份唯一性回归测试汇总：总计 ${results.length} | 通过 ${passed} | 失败 ${failed}`);
  console.log('==============================================');

  // 清理临时数据目录
  try { if (fs.existsSync(DATA_DIR)) fs.rmSync(DATA_DIR, { recursive: true, force: true }); } catch (_) {}

  process.exit(failed === 0 ? 0 : 1);
}
