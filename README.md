# 🏆 AI 技能竞赛 · 实时评分系统

把原版「单机版（localStorage）AI 技能大赛评分小程序」改造为**可多人实时扫码评分、组织者看实时大屏统计**的全栈网站。

- 👤 **评委**：手机扫码打开评分页，提交四维加权评分。
- 📺 **主持人**：打开大屏页，自动刷新排行榜（SSE 实时推送）。
- 💾 **数据统一存服务端**（`data/scores.json`），不同设备实时互通、集中汇总。

## 技术栈

| 能力 | 方案 |
|------|------|
| 服务端 | Node.js 内置 `http` 模块（**零框架**，无 Express） |
| 二维码 | `qrcode`（唯一外部依赖，纯 JS） |
| 实时推送 | SSE（Server-Sent Events，基于内置 http，无需 `ws`） |
| 存储 | `data/scores.json`（内存缓存 + 每次写入落盘） |
| 前端 | 原生 HTML/CSS/JS，复用原版小程序 UI 与评分逻辑 |

## 目录结构

```
ai-score-live/
├── package.json        # 依赖与启动脚本
├── server.js           # 服务端（http + SSE + 文件存储 + 二维码）
├── public/
│   ├── index.html      # 评委评分页（移动端优先）
│   └── live.html       # 主持人大屏页（二维码 + 实时排行榜）
├── data/
│   └── scores.json     # 评分数据（首次启动自动创建）
├── qrcode.png          # 启动后自动生成的二维码图片
└── README.md
```

## 本地运行

```bash
# 1. 进入项目目录
cd ai-score-live

# 2. 安装唯一依赖（本地，不要 -g）
npm install

# 3. 启动
npm start
# 或： node server.js
```

启动后控制台会打印：

```
👤 评委评分页：  http://<局域网IP>:3000
📺 主持人大屏页：http://<局域网IP>:3000/live
```

- 用手机扫码（或访问评分页）即可评分。
- 在同一 WiFi 下的手机扫码后，大屏页会**实时刷新**排行榜。
- 端口可自定义：`PORT=8080 npm start`

## 公网部署（让场外/异地人员也能扫码）

- **二维码地址自动识别**：部署到 Render / Fly.io / 任意反向代理平台时，系统会读取平台透传的 `X-Forwarded-Proto` 与请求 `Host`，**自动**把二维码指向公网域名——**不设置 `PUBLIC_URL` 也能正确扫码**。
- **仍推荐显式设置 `PUBLIC_URL`**：手动指定最稳妥，避免个别平台不透明代理导致识别偏差。
- 本地 `npm start`（无代理）时，二维码回退为局域网 IP，仅供同 WiFi 调试。

### 方案 A：云服务器部署
1. 把整个目录上传到云服务器（如腾讯云/阿里云）。
2. `npm install && npm start`（可用 `pm2` 守护进程）。
3. 在安全组/防火墙放行对应端口（默认 3000）。
4. 设置环境变量 `PUBLIC_URL` 指向对外域名，二维码与打印地址会自动改用公网地址：
   ```bash
   PUBLIC_URL=https://ai-score.your-domain.com npm start
   ```

### 方案 B：内网穿透（本机直连，无需服务器）
使用 frp / ngrok / cpolar 等工具，把本机 `3000` 端口映射到公网域名，然后：
```bash
PUBLIC_URL=https://xxx.cpolar.cn npm start
```
> 设置 `PUBLIC_URL` 后，启动生成的 `qrcode.png` 与 `/api/qrcode` 接口都会编码该公网地址，评委直接扫码即可访问。

### 方案 C：容器 / 平台一键部署（推荐）

项目已附带 `Dockerfile` 与 `Procfile`，可直接部署到任意支持 Node 的云平台：

- **Docker / 云服务器**：
  ```bash
  docker build -t ai-score .
  docker run -d -p 3000:3000 -e PUBLIC_URL=https://你的域名 ai-score
  ```
- **Render / Fly.io / Railway / Heroku**：连接 Git 仓库后，平台自动识别 `Dockerfile` 或 `Procfile` 构建，`Start` 命令为 `node server.js`，在环境变量里设置 `PUBLIC_URL` 即可。

> 推荐显式设置 `PUBLIC_URL`（见各方案命令）以获得最稳妥的公网二维码；不设置时，系统也会自动根据平台透传的协议与域名生成，绝大多数 PaaS 可直接扫码。

## API 说明

| 方法 | 路径 | 说明 |
|------|------|------|
| GET | `/` | 评委评分页 |
| GET | `/live` | 主持人大屏页 |
| POST | `/api/score` | 提交评分 |
| GET | `/api/stats` | 当前统计快照 |
| GET | `/api/stream` | SSE 实时流（连接即推，新评分即广播） |
| GET | `/api/qrcode` | 二维码 PNG 图片 |
| GET | `/qrcode.png` | 启动生成的二维码静态文件 |

### POST `/api/score` 请求体

```json
{
  "judgeType": "leader",          // "leader" | "public"
  "judgeName": "龙章其",          // 评委姓名
  "workName": "人力资源部(雪梨队)", // 参赛队名
  "innovation": 9,               // 1-10 整数
  "practicality": 8,             // 1-10 整数
  "quality": 7,                  // 1-10 整数
  "presentation": 9              // 1-10 整数
}
```

- 字段非法返回 `400 { "ok": false, "error": "..." }`。
- 成功返回 `200 { "ok": true, "record": { ...加权总分与时间戳... } }`。
- 加权总分：`创新性*0.30 + 实用性*0.40 + 作品质量*0.20 + 现场呈现*0.10`。

### GET `/api/stats` 返回示例

```json
{
  "totalRecords": 12,
  "totalWorks": 8,
  "totalJudges": 5,
  "works": [
    {
      "workName": "人力资源部(雪梨队)",
      "leaderCount": 2,
      "publicCount": 3,
      "totalCount": 5,
      "leaderAvg": 8.40,
      "publicAvg": 7.20,
      "finalScore": 7.80
    }
  ],
  "recent": [ /* 最近 20 条记录 */ ]
}
```

- `finalScore = leaderAvg * 0.5 + publicAvg * 0.5`（无领导分则 leaderAvg=0，大众同理）。
- `works` 按 `finalScore` 降序。
- `totalJudges` 为去重(评委姓名 + 评委类型)的数量。

## 注意事项

- 数据全部本地自包含存储，不调用任何外部网络服务/API。
- 评分数据保存在 `data/scores.json`，备份或清空该文件即可重置数据。
- 大屏页自带 SSE 断线自动重连（3 秒）。
