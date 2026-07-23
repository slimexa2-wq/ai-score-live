'use strict';
/* ============================================================
 *  QA 独立验证脚本（严过关）
 *  - 用 Node 22 全局 fetch（UTF-8 安全）
 *  - 独立重实现 weightedScore / computeStats 公式，与服务端对账
 *  - 不修改任何业务代码
 * ============================================================ */
const http = require('http');
const fs = require('fs');
const path = require('path');

const BASE = 'http://127.0.0.1:3100';
const ROOT = __dirname;

// ---- 文档规定的权重（与 server.js / 前端一致） ----
const WEIGHTS = { innovation: 0.30, practicality: 0.40, quality: 0.20, presentation: 0.10 };

function weightedScore(s) {
  return Number(
    (s.innovation * WEIGHTS.innovation +
      s.practicality * WEIGHTS.practicality +
      s.quality * WEIGHTS.quality +
      s.presentation * WEIGHTS.presentation).toFixed(2)
  );
}

// 独立重实现 computeStats（与服务端 server.js:119 逻辑一致，用于对账）
function computeExpectedStats(records) {
  const workMap = new Map();
  for (const r of records) {
    if (!workMap.has(r.workName)) workMap.set(r.workName, { leader: [], public: [] });
    const bucket = workMap.get(r.workName);
    if (r.judgeType === 'leader') bucket.leader.push(r);
    else bucket.public.push(r);
  }
  const works = [];
  for (const [workName, { leader, public: pub }] of workMap.entries()) {
    const leaderAvg = leader.length ? leader.reduce((s, r) => s + r.weightedScore, 0) / leader.length : 0;
    const publicAvg = pub.length ? pub.reduce((s, r) => s + r.weightedScore, 0) / pub.length : 0;
    const finalScore = leaderAvg * 0.5 + publicAvg * 0.5;
    works.push({
      workName,
      leaderCount: leader.length,
      publicCount: pub.length,
      totalCount: leader.length + pub.length,
      leaderAvg: Number(leaderAvg.toFixed(2)),
      publicAvg: Number(publicAvg.toFixed(2)),
      finalScore: Number(finalScore.toFixed(2)),
    });
  }
  works.sort((a, b) => b.finalScore - a.finalScore);
  const judges = new Set(records.map((r) => `${r.judgeName}|${r.judgeType}`));
  return {
    totalRecords: records.length,
    totalWorks: workMap.size,
    totalJudges: judges.size,
    works,
  };
}

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
async function getStats() {
  const resp = await fetch(BASE + '/api/stats');
  return { status: resp.status, data: await resp.json() };
}
async function getPage(p) {
  const resp = await fetch(BASE + p);
  const text = await resp.text();
  return { status: resp.status, text, contentType: resp.headers.get('content-type') };
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitFor(fn, timeoutMs, interval = 100) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try { if (await fn()) return true; } catch (_) {}
    await sleep(interval);
  }
  return false;
}

// ---- SSE 客户端 ----
function openSSE() {
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

function mkRec(judgeType, judgeName, workName, inn, pra, qua, pre) {
  return {
    judgeType, judgeName, workName,
    innovation: inn, practicality: pra, quality: qua, presentation: pre,
    weightedScore: weightedScore({ innovation: inn, practicality: pra, quality: qua, presentation: pre }),
  };
}

// ============================================================
//  主流程
// ============================================================
(async () => {
  const localRecords = []; // 我独立维护的“真实数据”，用于与服务端对账

  // ---------- 1. 启动健康：页面可达 + 含「AI竞赛」 ----------
  const home = await getPage('/');
  record('启动健康·GET / 200 且含「AI竞赛」',
    home.status === 200 && home.text.includes('AI竞赛'),
    `status=${home.status}, contentType=${home.contentType}, includes('AI竞赛')=${home.text.includes('AI竞赛')}`);

  const live = await getPage('/live');
  record('启动健康·GET /live 200',
    live.status === 200 && live.contentType.includes('text/html'),
    `status=${live.status}, contentType=${live.contentType}`);

  // 控制台打印 & qrcode.png 已生成（读取启动日志 + 磁盘文件）
  const log = fs.existsSync(path.join(ROOT, 'server.log')) ? fs.readFileSync(path.join(ROOT, 'server.log'), 'utf8') : '';
  const qrPath = path.join(ROOT, 'qrcode.png');
  const qrExists = fs.existsSync(qrPath);
  let qrHeaderOk = false;
  if (qrExists) {
    const b = fs.readFileSync(qrPath);
    qrHeaderOk = b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47;
  }
  record('启动健康·控制台打印评委URL/大屏URL',
    log.includes('评委评分页') && log.includes('主持人大屏页'),
    `日志含评委/大屏URL=${log.includes('评委评分页') && log.includes('主持人大屏页')}`);
  record('启动健康·生成 qrcode.png 且为合法PNG',
    qrExists && qrHeaderOk,
    `exists=${qrExists}, pngHeader=${qrHeaderOk}`);

  // ---------- 2. 合法提交 + weightedScore ----------
  const validBody = { judgeType: 'leader', judgeName: '龙章其', workName: '人力资源部(雪梨队)', innovation: 9, practicality: 8, quality: 7, presentation: 9 };
  const expectedWs = weightedScore({ innovation: 9, practicality: 8, quality: 7, presentation: 9 }); // 9*.3+8*.4+7*.2+9*.1=8.20
  const r1 = await postScore(validBody);
  const rec1 = mkRec('leader', '龙章其', '人力资源部(雪梨队)', 9, 8, 7, 9);
  localRecords.push(rec1);
  record('合法提交·200 {ok:true,record}',
    r1.status === 200 && r1.data && r1.data.ok === true && !!r1.data.record,
    `status=${r1.status}, ok=${r1.data && r1.data.ok}`);
  record('合法提交·weightedScore 计算正确(手算 8.20)',
    r1.data && r1.data.record && r1.data.record.weightedScore === expectedWs,
    `返回=${r1.data && r1.data.record && r1.data.record.weightedScore}, 期望=${expectedWs}`);

  // 提交后立即查 stats（仅 1 条）
  let st = await getStats();
  record('合法提交·stats.totalRecords=1',
    st.data.totalRecords === 1,
    `totalRecords=${st.data.totalRecords}`);

  // ---------- 3. 聚合算法（关键，手算对账） ----------
  // Work A=人力资源部(雪梨队) 已有一条 leader(9,8,7,9)=8.20
  await postScore({ judgeType: 'leader', judgeName: '景主席', workName: '人力资源部(雪梨队)', innovation: 7, practicality: 6, quality: 5, presentation: 8 });
  localRecords.push(mkRec('leader', '景主席', '人力资源部(雪梨队)', 7, 6, 5, 8)); // 6.30
  await postScore({ judgeType: 'public', judgeName: '第一组', workName: '人力资源部(雪梨队)', innovation: 8, practicality: 7, quality: 6, presentation: 9 });
  localRecords.push(mkRec('public', '第一组', '人力资源部(雪梨队)', 8, 7, 6, 9)); // 7.30

  // Work B=保安子公司(勇敢牛牛队)
  await postScore({ judgeType: 'leader', judgeName: '徐万霞', workName: '保安子公司(勇敢牛牛队)', innovation: 10, practicality: 10, quality: 10, presentation: 10 });
  localRecords.push(mkRec('leader', '徐万霞', '保安子公司(勇敢牛牛队)', 10, 10, 10, 10)); // 10.0
  await postScore({ judgeType: 'leader', judgeName: '肖小松', workName: '保安子公司(勇敢牛牛队)', innovation: 8, practicality: 8, quality: 8, presentation: 8 });
  localRecords.push(mkRec('leader', '肖小松', '保安子公司(勇敢牛牛队)', 8, 8, 8, 8)); // 8.0
  await postScore({ judgeType: 'public', judgeName: '第二组', workName: '保安子公司(勇敢牛牛队)', innovation: 6, practicality: 6, quality: 6, presentation: 6 });
  localRecords.push(mkRec('public', '第二组', '保安子公司(勇敢牛牛队)', 6, 6, 6, 6)); // 6.0

  st = await getStats();
  const expected = computeExpectedStats(localRecords);
  const worksByName = {};
  for (const w of st.data.works) worksByName[w.workName] = w;
  const expWorksByName = {};
  for (const w of expected.works) expWorksByName[w.workName] = w;

  // 3a. totals
  record('聚合·totalRecords=6',
    st.data.totalRecords === expected.totalRecords,
    `返回=${st.data.totalRecords}, 期望=${expected.totalRecords}`);
  record('聚合·totalWorks=2',
    st.data.totalWorks === expected.totalWorks,
    `返回=${st.data.totalWorks}, 期望=${expected.totalWorks}`);
  record('聚合·totalJudges=6(去重 judgeName|judgeType)',
    st.data.totalJudges === expected.totalJudges,
    `返回=${st.data.totalJudges}, 期望=${expected.totalJudges}`);

  // 3b. Work A 公式
  const wa = worksByName['人力资源部(雪梨队)'];
  const waExp = expWorksByName['人力资源部(雪梨队)'];
  record('聚合·WorkA leaderAvg=(8.20+6.30)/2=7.25',
    wa && wa.leaderAvg === waExp.leaderAvg,
    `返回=${wa && wa.leaderAvg}, 期望=${waExp.leaderAvg}, leaderCount=${wa && wa.leaderCount}`);
  record('聚合·WorkA publicAvg=7.30',
    wa && wa.publicAvg === waExp.publicAvg,
    `返回=${wa && wa.publicAvg}, 期望=${waExp.publicAvg}, publicCount=${wa && wa.publicCount}`);
  record('聚合·WorkA finalScore=leaderAvg*0.5+publicAvg*0.5',
    wa && wa.finalScore === waExp.finalScore,
    `返回=${wa && wa.finalScore}, 期望=${waExp.finalScore}`);

  // 3c. Work B 公式（干净数值）
  const wb = worksByName['保安子公司(勇敢牛牛队)'];
  const wbExp = expWorksByName['保安子公司(勇敢牛牛队)'];
  record('聚合·WorkB leaderAvg=(10+8)/2=9.00',
    wb && wb.leaderAvg === 9.0,
    `返回=${wb && wb.leaderAvg}, 期望=9.00`);
  record('聚合·WorkB publicAvg=6.00',
    wb && wb.publicAvg === 6.0,
    `返回=${wb && wb.publicAvg}, 期望=6.00`);
  record('聚合·WorkB finalScore=9*0.5+6*0.5=7.50',
    wb && wb.finalScore === 7.5,
    `返回=${wb && wb.finalScore}, 期望=7.50`);

  // 3d. 排序：finalScore 降序
  const orderDesc = st.data.works.every((w, i, arr) => i === 0 || arr[i - 1].finalScore >= w.finalScore);
  record('聚合·works 按 finalScore 降序',
    orderDesc,
    `顺序=[${st.data.works.map((w) => `${w.workName}:${w.finalScore}`).join(', ')}]`);

  // 3e. 去重验证：同一 judgeName|judgeType 再投一票给不同队伍，totalJudges 不应增加
  await postScore({ judgeType: 'leader', judgeName: '龙章其', workName: '保安子公司(勇敢牛牛队)', innovation: 5, practicality: 5, quality: 5, presentation: 5 });
  localRecords.push(mkRec('leader', '龙章其', '保安子公司(勇敢牛牛队)', 5, 5, 5, 5)); // 复用龙章其|leader
  st = await getStats();
  record('聚合·去重：复用评委不增加 totalJudges(仍=6,totalRecords=7)',
    st.data.totalJudges === 6 && st.data.totalRecords === 7,
    `totalJudges=${st.data.totalJudges}(期望6), totalRecords=${st.data.totalRecords}(期望7)`);

  // ---------- 4. 非法输入 ----------
  const baselineRecords = (await getStats()).data.totalRecords;
  const illegalCases = [
    ['缺字段(无innovation)', { judgeType: 'leader', judgeName: 'X', workName: 'Y', practicality: 5, quality: 5, presentation: 5 }],
    ['judgeType 非法(admin)', { judgeType: 'admin', judgeName: 'X', workName: 'Y', innovation: 5, practicality: 5, quality: 5, presentation: 5 }],
    ['四维越界(innovation=11)', { judgeType: 'leader', judgeName: 'X', workName: 'Y', innovation: 11, practicality: 5, quality: 5, presentation: 5 }],
    ['四维越界(innovation=0)', { judgeType: 'leader', judgeName: 'X', workName: 'Y', innovation: 0, practicality: 5, quality: 5, presentation: 5 }],
    ['非整数(innovation=5.5)', { judgeType: 'leader', judgeName: 'X', workName: 'Y', innovation: 5.5, practicality: 5, quality: 5, presentation: 5 }],
    ['非数字字符串(innovation="abc")', { judgeType: 'leader', judgeName: 'X', workName: 'Y', innovation: 'abc', practicality: 5, quality: 5, presentation: 5 }],
    ['空对象', {}],
  ];
  let allIllegalOk = true;
  const illegalDetails = [];
  for (const [label, body] of illegalCases) {
    const r = await postScore(body);
    const ok = r.status === 400 && r.data && r.data.ok === false && typeof r.data.error === 'string' && r.data.error.length > 0;
    if (!ok) { allIllegalOk = false; illegalDetails.push(`${label}: status=${r.status} ok=${r.data && r.data.ok}`); }
    else illegalDetails.push(`${label}: 400 ok:false (${r.data.error})`);
  }
  // 非法提交后 totalRecords 必须不变
  const afterIllegal = (await getStats()).data.totalRecords;
  record('非法输入·全部返回 400 {ok:false,error}', allIllegalOk, illegalDetails.join(' | '));
  record('非法输入·未写入数据(totalRecords 不变)', afterIllegal === baselineRecords,
    `提交前=${baselineRecords}, 提交后=${afterIllegal}`);

  // ---------- 5. UTF-8 中文 ----------
  const cnWork = '中文测试队伍甲';
  const cnJudge = '测试评委张三';
  const rcn = await postScore({ judgeType: 'public', judgeName: cnJudge, workName: cnWork, innovation: 7, practicality: 7, quality: 7, presentation: 7 });
  localRecords.push(mkRec('public', cnJudge, cnWork, 7, 7, 7, 7));
  st = await getStats();
  const cnFound = st.data.recent.some((r) => r.workName === cnWork && r.judgeName === cnJudge);
  record('UTF-8·中文 judgeName/workName 正确无乱码',
    rcn.status === 200 && cnFound,
    `提交 status=${rcn.status}, 回查 recent 含「${cnWork}」/${cnJudge}=${cnFound}`);

  // ---------- 6. 二维码接口 ----------
  const qrResp = await fetch(BASE + '/api/qrcode');
  const qrBuf = Buffer.from(await qrResp.arrayBuffer());
  const qrOk = qrResp.headers.get('content-type') === 'image/png' &&
    qrBuf[0] === 0x89 && qrBuf[1] === 0x50 && qrBuf[2] === 0x4e && qrBuf[3] === 0x47;
  record('二维码·GET /api/qrcode 返回 image/png 且合法PNG头',
    qrOk,
    `contentType=${qrResp.headers.get('content-type')}, header=${qrBuf.slice(0, 4).toString('hex')}`);

  // ---------- 7. SSE 实时推送 ----------
  const beforeSSE = (await getStats()).data.totalRecords;
  const sse = await openSSE();
  const gotInitial = await waitFor(() => sse.events.some((e) => e.event === 'stats'), 5000);
  // 提交一条新分
  const sseWork = 'SSE实时推送测试队';
  const rSse = await postScore({ judgeType: 'leader', judgeName: 'SSE评委', workName: sseWork, innovation: 6, practicality: 6, quality: 6, presentation: 6 });
  localRecords.push(mkRec('leader', 'SSE评委', sseWork, 6, 6, 6, 6));
  const gotPush = await waitFor(() => {
    return sse.events.some((e) => {
      if (e.event !== 'stats') return false;
      try {
        const d = JSON.parse(e.data);
        return d.totalRecords === beforeSSE + 1 && d.works.some((w) => w.workName === sseWork);
      } catch (_) { return false; }
    });
  }, 8000);
  try { sse.req.destroy(); } catch (_) {}
  record('SSE·连接即收到 event:stats 快照', gotInitial, `initialSnapshotReceived=${gotInitial}`);
  record('SSE·新评分后数秒内收到含新数据的 stats 事件',
    gotPush && rSse.status === 200,
    `pushReceived=${gotPush}, newPostStatus=${rSse.status}`);

  // ---------- 汇总 ----------
  const passed = results.filter((r) => r.pass).length;
  const failed = results.length - passed;
  console.log('\n==============================================');
  console.log(`  测试汇总：总计 ${results.length} | 通过 ${passed} | 失败 ${failed}`);
  console.log('==============================================');

  // 写出报告
  const report = [
    '# QA 独立验证报告（严过关）',
    '',
    `服务地址： ${BASE}`,
    `测试时间： ${new Date().toISOString()}`,
    '',
    `## 汇总`,
    `- 总计：${results.length} ｜ 通过：${passed} ｜ 失败：${failed}`,
    '',
    '## 逐条结果',
    ...results.map((r, i) => `${i + 1}. ${r.pass ? '✅' : '❌'} **${r.name}**  \n   ${r.detail}`),
  ].join('\n');
  fs.writeFileSync(path.join(ROOT, 'QA_REPORT.md'), report, 'utf8');

  process.exit(failed === 0 ? 0 : 1);
})().catch((e) => {
  console.error('测试脚本异常：', e);
  process.exit(2);
});
