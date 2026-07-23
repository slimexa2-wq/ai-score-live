# AI 竞赛实时评分系统 - 容器镜像
FROM node:20-alpine

WORKDIR /app

# 先装依赖（利用镜像层缓存）
COPY package.json package-lock.json* ./
RUN npm install

# 复制源码
COPY . .

# 确保数据目录存在（评分落盘用）
RUN mkdir -p data

ENV PORT=3000
EXPOSE 3000

CMD ["node", "server.js"]
