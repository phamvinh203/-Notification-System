# Runtime chạy TS trực tiếp bằng tsx (dev dep) — không cần build step
FROM node:22-alpine

WORKDIR /app

# cài deps trước để tận dụng layer cache
COPY package.json package-lock.json ./
RUN npm ci

COPY tsconfig.json ./
COPY src ./src
COPY templates ./templates

ENV NODE_ENV=production
EXPOSE 3000

# API mặc định; service worker trong docker-compose sẽ override command thành start-worker.ts
CMD ["npx", "tsx", "src/index.ts"]
