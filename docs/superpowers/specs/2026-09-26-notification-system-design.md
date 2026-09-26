# Notification System — Design Spec

- **Date:** 2026-09-26
- **Status:** approved design, chờ implementation plan
- **Mục đích:** học tập / demo kiến trúc event-driven + message queue (không phải production service)

## 1. Mục tiêu & phạm vi

Xây hệ thống notification thể hiện đầy đủ 6 yêu cầu:

1. Gửi đa kênh: **push notification, email, SMS** (mock providers)
2. **Message queue** (BullMQ + Redis) — API tách rời worker
3. **Retry** khi gửi lỗi (exponential backoff, tự động)
4. **Notification scheduling** (gửi tại thời điểm tương lai, hủy được)
5. **Delivery status tracking** (timeline sự kiện per notification, query qua API)
6. **Event-driven**: ingress qua queue; xử lý driven bởi worker events

**Ngoài phạm vi (YAGNI):** template engine, i18n, user preference, rate limit per recipient, provider thật (SendGrid/Twilio/FCM), WebSocket real-time push, auth cho API, horizontal scaling worker.

## 2. Kiến trúc

```
Client ──POST /notifications──▶ REST API (Fastify)
                                   │ enqueue (delay = sendAt - now nếu scheduled)
                                   ▼
                          BullMQ queue "notifications" ◀──▶ Redis (docker-compose)
                                   │ consume
                                   ▼
                          Worker (BullMQ Worker)
                                   │ channel → provider adapter (mock)
                                   │ success → event "sent"
                                   │ fail    → BullMQ retry → hết attempts → "dead"
                                   ▼
                          SQLite (notifications + delivery_events)

Bull Board UI: /admin/queues (xem queue, retry, delayed jobs trên browser)
```

### Event-driven ở 2 tầng

- **Ingress:** API chỉ enqueue và trả `202` + id ngay — việc gửi thuộc worker (decoupled).
- **Xử lý:** worker lắng nghe BullMQ events (`active`, `completed`, `failed`) — mỗi event là 1 handler ghi `delivery_events` + cập nhật status. Trong production, event `sent`/`dead` sẽ publish tiếp cho service khác subscribe; demo này thể hiện qua DB + log.

## 3. Components

| Component | File | Vai trò |
|---|---|---|
| Bootstrap | `src/index.ts` | Khởi động API + worker + Bull Board trong 1 process (đủ cho demo) |
| Config | `src/config.ts` | Đọc env: `PORT`, `REDIS_URL`, `FAIL_RATE`, `DB_PATH` |
| DB | `src/db.ts` | SQLite qua better-sqlite3, tạo bảng nếu chưa có |
| API | `src/api/routes.ts` | REST endpoints, validate body bằng zod |
| Producer | `src/queue/queue.ts` | Định nghĩa queue + hàm enqueue, set `delay` cho scheduling |
| Worker | `src/queue/worker.ts` | Consumer: chọn provider theo channel, gọi gửi, ghi delivery events, config retry |
| Providers | `src/providers/*.ts` | Interface `NotificationProvider` + 3 mock (email/push/sms) + registry theo channel |
| Demo | `src/demo.ts` | Kịch bản end-to-end tự chạy |

### Mock providers

- Mỗi provider: sleep 300–800ms giả lập latency, rồi thành công hoặc throw.
- **FAIL_RATE** (env, default `0.3`) — xác suất fail mỗi lần gọi. Mục đích: cho retry **nhìn thấy được** khi demo. Đặt `FAIL_RATE=0` để luôn thành công.
- Registry: `{ email: EmailProvider, push: PushProvider, sms: SmsProvider }` — thêm kênh mới = thêm 1 adapter + 1 dòng registry.

## 4. Data model (SQLite)

```sql
CREATE TABLE IF NOT EXISTS notifications (
  id           TEXT PRIMARY KEY,        -- uuid
  channel      TEXT NOT NULL,           -- 'email' | 'push' | 'sms'
  recipient    TEXT NOT NULL,
  subject      TEXT,
  body         TEXT NOT NULL,
  status       TEXT NOT NULL,           -- xem status flow
  scheduled_at TEXT,                    -- ISO, NULL nếu gửi ngay
  created_at   TEXT NOT NULL            -- ISO
);

CREATE TABLE IF NOT EXISTS delivery_events (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  notification_id TEXT NOT NULL REFERENCES notifications(id),
  event           TEXT NOT NULL,        -- xem bảng event
  detail          TEXT,                 -- vd: attempt số mấy, lỗi gì
  created_at      TEXT NOT NULL         -- ISO
);
```

### Status flow

```
scheduled → queued → processing → sent
                        │
                        ├─(retry, còn attempt)→ processing …
                        └─(hết attempt)──────→ failed (dead)
scheduled ──DELETE──→ cancelled
```

### Delivery events

| event | Ý nghĩa |
|---|---|
| `enqueued` | Job vào queue (ghi khi API nhận yêu cầu) |
| `processing` | Worker bắt đầu xử lý (kèm số attempt) |
| `retry_scheduled` | Provider fail, sẽ retry (kèm lý do + attempt) |
| `sent` | Gửi thành công |
| `dead` | Hết attempts, bỏ cuộc |
| `cancelled` | Job scheduled bị hủy |

## 5. Retry & xử lý lỗi

- BullMQ job opts: `attempts: 3`, `backoff: { type: 'exponential', delay: 1000 }` (1s → 2s → 4s).
- Provider throw → BullMQ tự re-queue → mỗi lần fail worker ghi event `retry_scheduled`.
- Hết attempts → BullMQ event `failed` (với `job.attemptsMade >= attempts`) → ghi `dead`, status `failed`.
- Validate lỗi ở API (zod) → trả `400` trước khi vào queue.

## 6. API

| Method | Path | Mô tả |
|---|---|---|
| POST | `/notifications` | Gửi notification. Body: `{ channel, recipient, subject?, body, sendAt? }`. Có `sendAt` (ISO) → scheduled. Trả `202` + `{ id, status }` |
| GET | `/notifications` | Danh sách, filter `?status=&channel=`, mới nhất trước |
| GET | `/notifications/:id` | Chi tiết + mảng delivery_events (timeline) |
| DELETE | `/notifications/:id` | Hủy job scheduled: `job.remove()`. Chỉ khi status `scheduled`, nếu không trả `409` |
| GET | `/admin/queues` | Bull Board UI |

Validation rules (zod): `channel` ∈ enum; `recipient` bắt buộc (email/phone/device-token đều là string — mock); `body` bắt buộc; `sendAt` phải ISO hợp lệ.

## 7. Cấu trúc thư mục & dependencies

```
project/
├── docker-compose.yml      # 1 service: redis
├── package.json
├── tsconfig.json
├── src/
│   ├── index.ts            # bootstrap
│   ├── config.ts
│   ├── db.ts
│   ├── api/routes.ts
│   ├── queue/queue.ts
│   ├── queue/worker.ts
│   ├── providers/types.ts  # interface NotificationProvider
│   ├── providers/email.ts
│   ├── providers/push.ts
│   ├── providers/sms.ts
│   ├── providers/index.ts  # registry
│   └── demo.ts
└── README.md               # cách chạy + curl examples
```

Dependencies: `fastify`, `bullmq`, `better-sqlite3`, `@bull-board/fastify` + `@bull-board/api`, `zod`. Dev: `typescript`, `tsx`, `@types/*`.

Chạy: `docker compose up -d redis` → `npm run dev` (API + worker + UI cùng process) → `npm run demo` (kịch bản kiểm chứng).

## 8. Demo script (`src/demo.ts`) — kiểm chứng end-to-end

1. Gửi 3 notification (email, push, sms) ngay → in id + status.
2. Schedule 1 email sau 30s → in id, GET timeline thấy `enqueued` + `scheduled_at`.
3. Đợi vài giây → GET từng notification: thấy `processing`, có cái `retry_scheduled` (do FAIL_RATE), cuối cùng `sent` hoặc `failed(dead)`.
4. In URL Bull Board để xem trực quan queue + delayed + retry.

Demo chạy được trọn vẹn = hệ thống hoạt động đúng (thay test suite).

## 9. Quyết định đã chốt

| Quyết định | Chọn | Lý do |
|---|---|---|
| Queue | BullMQ + Redis | Giải sẵn retry/scheduling/events; pattern chuẩn Node; RabbitMQ nặng hơn 3-4x code |
| DB | SQLite (better-sqlite3) | Zero-config, queryable, đủ cho demo tracking |
| Provider | Mock + FAIL_RATE env | Mục tiêu học; retry phải thấy được bằng mắt |
| Process model | API + worker 1 process | Đơn giản cho demo; tách process khi scale (adapter không đổi) |
| Kiểm chứng | Demo script thay test suite | Đúng mục đích học tập, thấy luồng end-to-end |
