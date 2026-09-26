# Notification System (demo)

Hệ thống notification học kiến trúc event-driven: Fastify API → BullMQ (Redis) → Worker → mock providers → SQLite delivery tracking.

> Yêu cầu **Node ≥ 22.5** (dùng module built-in `node:sqlite`) và Docker (chạy Redis).

## Chạy

```bash
# 1. Redis
docker compose up -d redis

# 2. Cài deps (lần đầu)
npm install

# 3. Server (API + worker + Bull Board)
npm run dev
```

Terminal khác — chạy demo end-to-end:

```bash
npm run demo
```

## Biến môi trường

| Biến | Default | Ý nghĩa |
|---|---|---|
| `PORT` | `3000` | Cổng API |
| `REDIS_URL` | `redis://localhost:6379` | Redis |
| `FAIL_RATE` | `0.3` | Xác suất mock provider fail (0–1). `0.5`+ để thấy retry rõ |
| `DB_PATH` | `notifications.db` | File SQLite |

## API

| Method | Path | Mô tả |
|---|---|---|
| POST | `/notifications` | Gửi: `{channel, recipient, subject?, body, sendAt?}`. Có `sendAt` → scheduled. Trả `202 {id, status}` |
| GET | `/notifications?status=&channel=` | Danh sách |
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
```

## Luồng

```
POST /notifications → DB row (queued/scheduled) + job lên BullMQ
Worker: processing → provider mock (300-800ms, fail theo FAIL_RATE)
  thành công → sent
  fail      → BullMQ retry (3 lần, backoff 1s/2s/4s) → hết → failed (dead)
GET /notifications/:id → timeline: enqueued → processing → (retry_scheduled)* → sent | dead
```
