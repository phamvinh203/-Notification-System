# Stage 1: build dashboard (Vite) — bundle UI tĩnh
FROM node:22-alpine AS ui-build
WORKDIR /ui
COPY dashboard/package.json dashboard/package-lock.json ./
RUN npm ci
COPY dashboard/ ./
RUN npm run build

# Stage 2: runtime — API + worker + dashboard tĩnh (serve bởi Fastify)
FROM node:22-alpine

WORKDIR /app

# cài deps trước để tận dụng layer cache
COPY package.json package-lock.json ./
RUN npm ci

COPY tsconfig.json ./
COPY src ./src
COPY templates ./templates
COPY --from=ui-build /ui/dist ./dashboard-dist

ENV NODE_ENV=production
ENV DASHBOARD_DIST=/app/dashboard-dist
EXPOSE 3000

# API (+ UI) mặc định; service worker trong docker-compose override command thành start-worker.ts
CMD ["npx", "tsx", "src/index.ts"]
