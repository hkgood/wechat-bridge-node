FROM node:20-alpine

# 国内源加速
RUN npm config set registry https://registry.npmmirror.com

WORKDIR /app

# 先 copy package 装依赖（利用 Docker 缓存）
COPY package*.json ./
RUN npm install --production

# 再 copy 源码
COPY src ./src

# 数据持久化目录
RUN mkdir -p /app/data
VOLUME ["/app/data"]

# 健康检查
HEALTHCHECK --interval=30s --timeout=5s --retries=3 \
  CMD wget -q -O- http://localhost:8080/healthz || exit 1

EXPOSE 8080

CMD ["node", "src/server.js"]
