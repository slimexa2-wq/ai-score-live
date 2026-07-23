'use strict';

/**
 * ============================================================
 *  AI 技能竞赛 · 实时评分服务端
 * ------------------------------------------------------------
 *  - 仅依赖 Node.js 内置模块（http / fs / path / os）
 *  - 唯一外部依赖：qrcode（生成二维码图片）
 *  - 实时推送：SSE（Server-Sent Events，基于 http）
 *  - 数据存储：data/scores.json（内存缓存 + 每次写入落盘）
 *  - 监听 0.0.0.0，端口 process.env.PORT || 3000
 * ============================================================
 */

const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const QRCode = require('qrcode');

// ----------------------------------------------------------------
// 基础配置
// ----------------------------------------------------------------
const ROOT = __dirname;
const PUBLIC_DIR = path.join(ROOT, 'public');
const DATA_DIR = path.join(ROOT, 'data');
const DATA_FILE = path.join(DATA_DIR, 'scores.json');
const PORT = parseInt(process.env.PORT || '3000', 10);
const HOST = '0.0.0.0';
const RECENT_LIMIT = 20;

// 与前端保持一致的常量（用于参考，不参与评分计算）
const LEADER_NAMES = ['龙章其', '景主席', '徐万霞', '肖小松'];
const PUBLIC_NAMES = ['第一组', '第二组', '第三组', '第四组', '第五组', '第六组', '第七组', '第八组'];
const TEAM_NAMES = [
  '人力资源部(雪梨队)',
  '公共事务部(美少女战士队)',
  '市场拓展部(写报告不熬夜队)',
  '保安子公司(勇敢牛牛队)',
  '宜宾分公司(祥英小队)',
  '郫都分公司(精益智营队)',
  '龙泉+双流分公司(智汇小队)',
  '绵阳分公司(风险防控队)'
];

// 四维权重（与前端、原版小程序一致）
const WEIGHTS = { innovation: 0.30, practicality: 0.40, quality: 0.20, presentation: 0.10 };

// ----------------------------------------------------------------
// 数据存储层
// ----------------------------------------------------------------
const store = { data: [] };

function ensureDataDir() {
  if (!fs.existsSync(DATA_DIR)) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
  }
}

function loadData() {
  ensureDataDir();
  try {
    if (fs.existsSync(DATA_FILE)) {
      const raw = fs.readFileSync(DATA_FILE, 'utf-8');
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) {
        store.data = parsed;
        console.log(`📂 已从 data/scores.json 加载 ${store.data.length} 条历史评分记录`);
        return;
      }
    }
  } catch (err) {
    console.error('⚠️ 读取 scores.json 失败，将以空数据启动：', err.message);
  }
  store.data = [];
}

function persistData() {
  ensureDataDir();
  try {
    fs.writeFileSync(DATA_FILE, JSON.stringify(store.data, null, 2), 'utf-8');
  } catch (err) {
    console.error('⚠️ 写入 scores.json 失败：', err.message);
  }
}

function genId() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}

// ----------------------------------------------------------------
// SSE 客户端管理
// ----------------------------------------------------------------
const sseClients = new Set();

function addSseClient(res) {
  sseClients.add(res);
}

function removeSseClient(res) {
  sseClients.delete(res);
}

function broadcastStats() {
  if (sseClients.size === 0) return;
  const payload = `event: stats\ndata: ${JSON.stringify(computeStats())}\n\n`;
  for (const res of sseClients) {
    try {
      res.write(payload);
    } catch (err) {
      removeSseClient(res);
    }
  }
}

// ----------------------------------------------------------------
// 统计计算
// ----------------------------------------------------------------
function computeStats() {
  const records = store.data;
  const workMap = new Map();

  for (const r of records) {
    if (!workMap.has(r.workName)) {
      workMap.set(r.workName, { leader: [], public: [] });
    }
    const bucket = workMap.get(r.workName);
    if (r.judgeType === 'leader') bucket.leader.push(r);
    else bucket.public.push(r);
  }

  const works = [];
  for (const [workName, { leader, public: pub }] of workMap.entries()) {
    const leaderAvg = leader.length
      ? leader.reduce((sum, r) => sum + r.weightedScore, 0) / leader.length
      : 0;
    const publicAvg = pub.length
      ? pub.reduce((sum, r) => sum + r.weightedScore, 0) / pub.length
      : 0;
    const finalScore = leaderAvg * 0.5 + publicAvg * 0.5;
    works.push({
      workName,
      leaderCount: leader.length,
      publicCount: pub.length,
      totalCount: leader.length + pub.length,
      leaderAvg: Number(leaderAvg.toFixed(2)),
      publicAvg: Number(publicAvg.toFixed(2)),
      finalScore: Number(finalScore.toFixed(2))
    });
  }
  // 按最终得分降序
  works.sort((a, b) => b.finalScore - a.finalScore);

  const uniqueJudges = new Set(records.map((r) => `${r.judgeName}|${r.judgeType}`));
  const recent = records.slice(-RECENT_LIMIT).reverse();

  return {
    totalRecords: records.length,
    totalWorks: workMap.size,
    totalJudges: uniqueJudges.size,
    works,
    recent
  };
}

// ----------------------------------------------------------------
// 请求体解析（JSON）
// ----------------------------------------------------------------
function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    let size = 0;
    const MAX = 1024 * 1024; // 1MB 上限
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > MAX) {
        reject(new Error('请求体过大'));
        req.destroy();
        return;
      }
      body += chunk;
    });
    req.on('end', () => {
      if (!body) return resolve({});
      try {
        resolve(JSON.parse(body));
      } catch (e) {
        reject(new Error('JSON 解析失败'));
      }
    });
    req.on('error', (err) => reject(err));
  });
}

// ----------------------------------------------------------------
// HTTP 响应辅助
// ----------------------------------------------------------------
function sendJson(res, status, obj) {
  const data = JSON.stringify(obj);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store'
  });
  res.end(data);
}

function sendHtmlFile(res, filePath) {
  fs.readFile(filePath, (err, buf) => {
    if (err) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('404 Not Found');
      return;
    }
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(buf);
  });
}

function sendImageFile(res, filePath) {
  fs.readFile(filePath, (err, buf) => {
    if (err) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('404 Not Found');
      return;
    }
    res.writeHead(200, { 'Content-Type': 'image/png', 'Cache-Control': 'no-cache' });
    res.end(buf);
  });
}

// ----------------------------------------------------------------
// 参数校验
// ----------------------------------------------------------------
function toInt(v) {
  const n = Number(v);
  return Number.isInteger(n) ? n : null;
}

function validateScore(body) {
  if (typeof body !== 'object' || body === null) return '请求体格式错误';

  const { judgeType, judgeName, workName, innovation, practicality, quality, presentation } = body;

  if (judgeType !== 'leader' && judgeType !== 'public') {
    return 'judgeType 必须为 "leader" 或 "public"';
  }
  if (typeof judgeName !== 'string' || !judgeName.trim()) {
    return 'judgeName 不能为空';
  }
  if (typeof workName !== 'string' || !workName.trim()) {
    return 'workName 不能为空';
  }

  const dims = { innovation, practicality, quality, presentation };
  for (const key of Object.keys(dims)) {
    const v = toInt(dims[key]);
    if (v === null || v < 1 || v > 10) {
      return `${key} 必须为 1-10 的整数`;
    }
  }
  return null;
}

// ----------------------------------------------------------------
// 局域网 / 对外地址
// ----------------------------------------------------------------
function getLanIp() {
  const ifaces = os.networkInterfaces();
  for (const name of Object.keys(ifaces)) {
    for (const iface of ifaces[name] || []) {
      if ((iface.family === 'IPv4' || iface.family === 4) && !iface.internal) {
        return iface.address;
      }
    }
  }
  return 'localhost';
}

// 二维码缓存；可通过 PUBLIC_URL 环境变量覆盖为对外公网地址
let qrBuffer = null;
let baseUrl = `http://localhost:${PORT}`;

function resolveBaseUrl() {
  if (process.env.PUBLIC_URL) {
    return process.env.PUBLIC_URL.replace(/\/+$/, '');
  }
  return `http://${getLanIp()}:${PORT}`;
}

async function generateQrCode() {
  try {
    qrBuffer = await QRCode.toBuffer(baseUrl, { type: 'png', width: 512, margin: 2 });
    fs.writeFileSync(path.join(ROOT, 'qrcode.png'), qrBuffer);
    console.log('✅ 已生成二维码文件：qrcode.png (' + baseUrl + ')');
  } catch (err) {
    console.error('⚠️ 生成二维码失败：', err.message);
  }
}

// ----------------------------------------------------------------
// 路由处理
// ----------------------------------------------------------------
async function handleRequest(req, res) {
  let url;
  try {
    url = new URL(req.url, baseUrl);
  } catch (e) {
    res.writeHead(400, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('Bad Request');
    return;
  }
  const pathname = decodeURIComponent(url.pathname);

  // ---- 页面 ----
  if (req.method === 'GET' && (pathname === '/' || pathname === '/index.html')) {
    return sendHtmlFile(res, path.join(PUBLIC_DIR, 'index.html'));
  }
  if (req.method === 'GET' && (pathname === '/live' || pathname === '/live.html')) {
    return sendHtmlFile(res, path.join(PUBLIC_DIR, 'live.html'));
  }

  // ---- 二维码图片（接口） ----
  if (req.method === 'GET' && pathname === '/api/qrcode') {
    if (!qrBuffer) {
      try {
        qrBuffer = await QRCode.toBuffer(baseUrl, { type: 'png', width: 512, margin: 2 });
      } catch (err) {
        return sendJson(res, 500, { ok: false, error: '二维码生成失败' });
      }
    }
    res.writeHead(200, { 'Content-Type': 'image/png', 'Cache-Control': 'no-cache' });
    return res.end(qrBuffer);
  }

  // ---- 二维码图片（静态文件，兼容直接访问） ----
  if (req.method === 'GET' && pathname === '/qrcode.png') {
    return sendImageFile(res, path.join(ROOT, 'qrcode.png'));
  }

  // ---- 提交评分 ----
  if (req.method === 'POST' && pathname === '/api/score') {
    let body;
    try {
      body = await readJsonBody(req);
    } catch (err) {
      return sendJson(res, 400, { ok: false, error: '请求体解析失败：' + err.message });
    }

    const errMsg = validateScore(body);
    if (errMsg) {
      return sendJson(res, 400, { ok: false, error: errMsg });
    }

    const innovation = toInt(body.innovation);
    const practicality = toInt(body.practicality);
    const quality = toInt(body.quality);
    const presentation = toInt(body.presentation);

    const weightedScore = Number(
      (innovation * WEIGHTS.innovation +
        practicality * WEIGHTS.practicality +
        quality * WEIGHTS.quality +
        presentation * WEIGHTS.presentation).toFixed(2)
    );

    const record = {
      id: genId(),
      judgeType: body.judgeType,
      judgeName: String(body.judgeName).trim(),
      workName: String(body.workName).trim(),
      innovation,
      practicality,
      quality,
      presentation,
      weightedScore,
      timestamp: Date.now()
    };

    store.data.push(record);
    persistData();
    broadcastStats();

    return sendJson(res, 200, { ok: true, record });
  }

  // ---- 统计 ----
  if (req.method === 'GET' && pathname === '/api/stats') {
    return sendJson(res, 200, computeStats());
  }

  // ---- SSE 实时流 ----
  if (req.method === 'GET' && pathname === '/api/stream') {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no'
    });
    // 建议浏览器 3 秒后自动重连
    res.write('retry: 3000\n\n');
    addSseClient(res);

    // 连接即推送当前统计快照
    res.write(`event: stats\ndata: ${JSON.stringify(computeStats())}\n\n`);

    // 心跳保活，避免代理断开空闲连接
    const ping = setInterval(() => {
      try {
        res.write(': ping\n\n');
      } catch (e) {
        /* ignore */
      }
    }, 25000);

    req.on('close', () => {
      clearInterval(ping);
      removeSseClient(res);
    });
    return;
  }

  // ---- 404 ----
  res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
  res.end('404 Not Found');
}

// ----------------------------------------------------------------
// 启动
// ----------------------------------------------------------------
function start() {
  loadData();

  const server = http.createServer((req, res) => {
    handleRequest(req, res).catch((err) => {
      console.error('请求处理出错：', err);
      if (!res.headersSent) {
        sendJson(res, 500, { ok: false, error: '服务器内部错误' });
      }
    });
  });

  server.listen(PORT, HOST, () => {
    baseUrl = resolveBaseUrl();
    console.log('');
    console.log('🏆 AI 技能竞赛 · 实时评分系统已启动');
    console.log('────────────────────────────────────────');
    console.log(`👤 评委评分页：  ${baseUrl}`);
    console.log(`📺 主持人大屏页：${baseUrl}/live`);
    console.log('────────────────────────────────────────');
    console.log('📱 评委扫码即可评分，主持人打开大屏页查看实时排行榜');
    if (process.env.PUBLIC_URL) {
      console.log('🌐 已使用 PUBLIC_URL 作为对外地址（公网部署模式）');
    }
    console.log('');
    generateQrCode();
  });
}

start();
