#!/usr/bin/env bash
#
# 腾讯云轻量应用服务器 · AI 技能大赛评分系统 一键部署脚本
# 适用系统：Ubuntu 22.04 LTS（腾讯云轻量应用服务器官方镜像）
#
# 用法（在服务器上以 root 执行其一）：
#   bash <(curl -sSL https://raw.githubusercontent.com/slimexa2-wq/ai-score-live/main/deploy/tencent-lighthouse-deploy.sh)
# 或先下载再执行：
#   sudo bash tencent-lighthouse-deploy.sh
#
# 脚本完成：安装 Node 20 + Nginx → 克隆代码 → systemd 保活 → Nginx 反代（关闭 SSE 缓冲）
# 关键点：Nginx 反代层关闭缓冲，保证大屏实时同步（不像 Cloudflare 隧道会缓冲 SSE）。
#
set -euo pipefail

APP_DIR="/opt/ai-score-live"
REPO_URL="https://github.com/slimexa2-wq/ai-score-live.git"
APP_PORT=3000

echo "=================================================="
echo " AI 技能大赛评分系统 · 腾讯云一键部署"
echo "=================================================="

# ---------------------------------------------------------------
# 1) 系统包
# ---------------------------------------------------------------
export DEBIAN_FRONTEND=noninteractive
echo "== 安装系统依赖 =="
apt-get update -y
apt-get install -y -q curl git nginx

# ---------------------------------------------------------------
# 2) Node.js 20.x（NodeSource）
# ---------------------------------------------------------------
if ! command -v node >/dev/null 2>&1 || [ "$(node -v | cut -d. -f1 | tr -d v)" -lt 18 ]; then
  echo "== 安装 Node.js 20 =="
  curl -fsSL https://deb.nodesource.com/setup_20.x | bash -
  apt-get install -y -q nodejs
fi
echo "Node: $(node -v)  npm: $(npm -v)"

# ---------------------------------------------------------------
# 3) 拉取代码
# ---------------------------------------------------------------
if [ -d "$APP_DIR/.git" ]; then
  echo "== 已存在，git pull 更新 =="
  cd "$APP_DIR" && git pull --ff-only
else
  echo "== 克隆仓库 =="
  git clone "$REPO_URL" "$APP_DIR"
fi

# ---------------------------------------------------------------
# 4) 安装依赖
# ---------------------------------------------------------------
cd "$APP_DIR"
echo "== 安装 npm 依赖 =="
npm install --omit=dev 2>/dev/null || npm install
npm install qrcode@^1.5.4 --no-audit --no-fund

# ---------------------------------------------------------------
# 5) systemd 保活服务（服务器重启自动拉起）
# ---------------------------------------------------------------
echo "== 注册 systemd 服务 =="
cat > /etc/systemd/system/ai-score.service <<EOF
[Unit]
Description=AI Score Live (AI 技能大赛实时评分)
After=network.target

[Service]
Type=simple
User=root
WorkingDirectory=$APP_DIR
Environment=PORT=$APP_PORT
Environment=DATA_DIR=$APP_DIR/data
Environment=NODE_ENV=production
ExecStart=/usr/bin/node $APP_DIR/server.js
Restart=always
RestartSec=3
StandardOutput=journal
StandardError=journal

[Install]
WantedBy=multi-user.target
EOF

systemctl daemon-reload
systemctl enable ai-score
systemctl restart ai-score
sleep 2
if systemctl is-active --quiet ai-score; then
  echo "== 服务已启动 (ai-score active) =="
else
  echo "!! 服务启动失败，查看日志：journalctl -u ai-score -n 50"
  exit 1
fi

# ---------------------------------------------------------------
# 6) Nginx 反代（关闭 SSE 缓冲，保证大屏实时同步）
# ---------------------------------------------------------------
echo "== 配置 Nginx 反代 =="
cp "$APP_DIR/deploy/nginx-ai-score.conf" /etc/nginx/sites-available/ai-score
ln -sf /etc/nginx/sites-available/ai-score /etc/nginx/sites-enabled/ai-score
rm -f /etc/nginx/sites-enabled/default
nginx -t
systemctl restart nginx
systemctl enable nginx

# ---------------------------------------------------------------
# 7) 完成提示
# ---------------------------------------------------------------
PUB_IP=$(curl -s --max-time 5 https://api.ipify.org || echo "你的服务器公网IP")
echo ""
echo "=================================================="
echo " 部署完成！"
echo "   主持人大屏:  http://$PUB_IP/live"
echo "   评委评分页:  http://$PUB_IP/"
echo "   状态接口:    http://$PUB_IP/api/stats"
echo "=================================================="
echo " 重要：请在腾讯云控制台『防火墙』放通 TCP 80 端口"
echo " 重启服务器后服务会自动拉起（systemd 保活）"
echo " 后续更新：cd $APP_DIR && git pull && sudo systemctl restart ai-score"
echo "=================================================="
