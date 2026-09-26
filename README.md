# Notification System (demo)

Hệ thống notification học kiến trúc event-driven: Fastify API → BullMQ (Redis) → Worker → mock providers → SQLite delivery tracking.

> Yêu cầu **Node ≥ 22.5** (dùng module built-in `node:sqlite`) và Docker (chạy Redis).

## Chạy

### Cách 1 — local (hot reload, phù hợp khi code)

```bash
# 1. Redis
docker compose up -d redis

# 2. Cài deps (lần đầu)
npm install

# 3. API + worker cùng lúc
npm run dev
# hoặc chạy riêng từng process:
#   npm run dev:api
#   npm run dev:worker
```

### Cách 2 — Docker (đúng kiểu production: 3 container riêng biệt)

```bash
docker compose up --build
# → redis (queue), api (REST + Bull Board), worker (xử lý job)
```

Compose đặt sẵn `API_KEY=dev-secret-123` — mọi request cần header `x-api-key: dev-secret-123` (xem mục [Auth](#auth-api-key)).

Terminal khác — chạy demo end-to-end:

```bash
npm run demo
# server bật auth thì: API_KEY=dev-secret-123 npm run demo
```

## Biến môi trường

| Biến | Default | Ý nghĩa |
|---|---|---|
| `PORT` | `3000` | Cổng API |
| `REDIS_URL` | `redis://localhost:6379` | Redis |
| `FAIL_RATE` | `0.3` | Xác suất mock provider fail (0–1). `0.5`+ để thấy retry rõ |
| `DB_PATH` | `notifications.db` | File SQLite |
| `API_KEY` | *(không set — tắt auth)* | Set thì mọi endpoint `/notifications*` và `/admin/queues` yêu cầu header `x-api-key` |

## Auth (API key)

Set biến `API_KEY` → bật auth. Request thiếu hoặc sai header `x-api-key` nhận `401`.

- Áp dụng cho **tất cả** endpoint `/notifications*` và **Bull Board** `/admin/queues`.
- `GET /health` luôn mở (dùng cho docker healthcheck).
- Không set `API_KEY` → tắt auth hoàn toàn (tiện dev local).

```bash
curl -H "x-api-key: dev-secret-123" http://localhost:3000/notifications
```

## API

| Method | Path | Mô tả |
|---|---|---|
| GET | `/health` | Health check — luôn mở, không cần key |
| POST | `/notifications` | Gửi: `{channel, recipient, subject?, body, sendAt?}`. Có `sendAt` → scheduled. Trả `202 {id, status}` |
| GET | `/notifications?status=&channel=&limit=&offset=` | Danh sách, **phân trang**: trả `{items, total, limit, offset}`. `limit` 1–100 (default 20), `offset` ≥ 0 |
| GET | `/notifications/:id` | Chi tiết + timeline delivery events |
| DELETE | `/notifications/:id` | Hủy job scheduled (409 nếu không phải scheduled) |
| GET | `/admin/queues` | Bull Board UI — xem queue/retry/delayed trực quan |

## Ví dụ curl

```bash
# Gửi email ngay
curl -X POST http://localhost:3000/notifications -H 'content-type: application/json' \
  -d '{"channel":"email","recipient":"you@example.com","subject":"Hi","body":"Hello"}'

# Schedule SMS sau 1 giờ
curl -X POST http://localhost:3000/notifications -H 'content-type: application/json' \
  -d '{"channel":"sms","recipient":"+84901234567","body":"Nhac hen","sendAt":"2030-01-01T00:00:00.000Z"}'

# Trang 2, mỗi trang 10 dòng (kèm key nếu bật auth)
curl -H "x-api-key: dev-secret-123" "http://localhost:3000/notifications?limit=10&offset=10"
```

## Test

```bash
npm test          # chạy 1 lần
npm run test:watch
```

- **30 test**: db layer (unit), REST API + auth + pagination (integration), queue scheduling, worker + retry logic (integration).
- Test cần Redis sẽ **tự skip** nếu Redis không chạy — local không bật Docker vẫn được bộ unit test; **CI luôn chạy đủ** (GitHub Actions cấp service Redis).
- Chạy từng process riêng khi debug: `npm run dev:api` / `npm run dev:worker`.

## CI

GitHub Actions (`.github/workflows/ci.yml`): mỗi push/PR chạy `npm run typecheck` + `npm test` với service Redis 7.

## Luồng

```
POST /notifications → DB row (queued/scheduled) + job lên BullMQ
Worker: processing → provider mock (300-800ms, fail theo FAIL_RATE)
  thành công → sent
  fail      → BullMQ retry (3 lần, backoff 1s/2s/4s) → hết → failed (dead)
GET /notifications/:id → timeline: enqueued → processing → (retry_scheduled)* → sent | dead
```

## Kiến trúc process

```
src/index.ts        → API (Fastify + Bull Board)
src/start-worker.ts → Worker (concurrency 5)
```

Hai entry tách riêng nên API và worker scale độc lập — local `npm run dev` vẫn chạy cả hai bằng `concurrently`, Docker compose chạy 3 container: `redis` + `api` + `worker`.
