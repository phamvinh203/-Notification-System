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

### Cách 2 — Docker (sản phẩm hoàn chỉnh: 1 lệnh có cả UI + monitoring)

```bash
docker compose up --build
# → redis (queue), api (REST + dashboard UI + Bull Board), worker,
#   prometheus (:9090), grafana (:3001 — user admin / pass admin)
```

Mở **http://localhost:3000** — dashboard UI chạy same-origin với API (browser gõ trực tiếp URL con như `/notifications` cũng vào được UI nhờ SPA fallback theo Accept header; curl/fetch vẫn nhận JSON). Grafana tại **http://localhost:3001** với dashboard "Notification System" provision sẵn.

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
| `RATE_LIMIT_PER_MINUTE` | `10` | Số notification tối đa / recipient / phút. `0` = tắt. Vượt → `429` |

## Auth (API key)

Set biến `API_KEY` → bật auth với chính sách **reads-open**:

- **Đọc mở (không cần key)**: mọi `GET` — danh sách, chi tiết, `/templates`, `/metrics`. Browser mở trực tiếp URL được.
- **Cần key** (header `x-api-key` **hoặc** `Authorization: Bearer <key>` — Prometheus scrape dùng Bearer): mọi thao tác ghi — `POST` tạo/replay, `DELETE` hủy — và **Bull Board** `/admin/queues`.
- `GET /health` luôn mở (dùng cho docker healthcheck).
- Không set `API_KEY` → tắt auth hoàn toàn (tiện dev local).

```bash
curl -X POST http://localhost:3000/notifications -H "x-api-key: dev-secret-123" ...
```

## Dashboard (frontend)

Dashboard React (Vite + TS + Tailwind v4) ở thư mục `dashboard/` — dark glassmorphism, có light mode.

**Chạy bằng Docker**: có sẵn trong image, mở `http://localhost:3000` luôn.

**Chạy dev (hot reload)**:

```bash
# terminal 3 (sau khi npm run dev backend đang chạy):
cd dashboard
npm install
npm run dev        # http://localhost:5173 — proxy /api về :3000
```

4 trang: **Tổng quan** (metrics realtime 3s, có pause), **Thông báo** (bảng lọc/phân trang, hủy/replay), **Chi tiết** (timeline delivery events tự live khi job đang chạy), **Tạo mới** (chọn kênh, template + params, preview payload, idempotency key). API key cho thao tác ghi nhập ở thanh trên cùng (lưu localStorage).

## Gửi thật (email & SMS)

Provider mặc định là **mock** (random fail theo `FAIL_RATE` để demo retry). Đổi env của **worker** để gửi thật:

### Email — 3 chế độ (`EMAIL_MODE`)

| Chế độ | Cần gì | Kết quả |
|---|---|---|
| `mock` (default) | — | giả lập, không gửi đi đâu |
| `smtp` + `SMTP_PRESET=ethereal` | không cần gì | **SMTP thật zero-config** — email xem được online qua link trong timeline (`sent` event), không vào inbox cá nhân |
| `smtp` + SMTP host riêng | SMTP credentials | email vào **hộp thư thật** (Gmail: `smtp.gmail.com`, port 465, secure, app password 16 ký tự) |
| `resend` | `RESEND_API_KEY` (miễn phí tại resend.com) | email vào hộp thư thật qua HTTP API |

```yaml
# docker-compose.yml (service worker) — ví dụ Ethereal:
environment:
  EMAIL_MODE: smtp
  SMTP_PRESET: ethereal
# ví dụ Gmail app password (inbox thật):
#   EMAIL_MODE: smtp
#   SMTP_HOST: smtp.gmail.com
#   SMTP_SECURE: "true"
#   SMTP_PORT: "465"
#   SMTP_USER: you@gmail.com
#   SMTP_PASS: xxxx xxxx xxxx xxxx
#   EMAIL_FROM: "Notification <you@gmail.com>"
```

### SMS — Twilio (`SMS_MODE=twilio`)

Cần `TWILIO_ACCOUNT_SID` + `TWILIO_AUTH_TOKEN` + `TWILIO_FROM`. Twilio **trial** chỉ gửi được tới số đã verify. Gửi qua REST API, Basic auth.

> Sau khi gửi thật, thông tin xác thực (link xem thư Ethereal, message id Resend, sid Twilio) được ghi vào **event `sent` trong timeline** — xem ngay trên dashboard.

**Push (FCM)**: cần Firebase project + service account — chưa làm, provider vẫn là mock.

## Gửi thật (demo nhanh không cần đăng ký)

```bash
docker compose stop worker
docker compose run --rm -e EMAIL_MODE=smtp -e SMTP_PRESET=ethereal -e FAIL_RATE=0 worker npx tsx src/start-worker.ts
# terminal khác: POST /notifications (channel email) → timeline event sent chứa link xem thư
docker compose start worker   # trả lại worker mock
```

## Monitoring (Prometheus + Grafana)

`docker compose up` kèm sẵn:

- **Prometheus** `http://localhost:9090` — scrape `/metrics` của api mỗi 15s (auth bằng `Authorization: Bearer`, cấu hình trong `ops/prometheus/prometheus.yml`)
- **Grafana** `http://localhost:3001` — login `admin` / `admin`, dashboard **"Notification System"** provision tự động (stat theo trạng thái, timeseries queue BullMQ, bar theo kênh, outbox pending)

## API

| Method | Path | Mô tả |
|---|---|---|
| GET | `/health` | Health check — luôn mở, không cần key |
| POST | `/notifications` | Gửi: `{channel, recipient, subject?, body \| template, params?, sendAt?, priority?}`. Có `sendAt` → scheduled. Trả `202 {id, status}` |
| GET | `/notifications?status=&channel=&limit=&offset=` | Danh sách, **phân trang**: trả `{items, total, limit, offset}`. `limit` 1–100 (default 20), `offset` ≥ 0 |
| GET | `/notifications/:id` | Chi tiết + timeline delivery events |
| DELETE | `/notifications/:id` | Hủy job scheduled (409 nếu không phải scheduled) |
| POST | `/notifications/:id/replay` | Đẩy lại job đã **dead** (chỉ khi status `failed`) — chạy lại với cấu hình retry như mới |
| GET | `/templates` | Danh sách template khả dụng |
| GET | `/metrics` | **Prometheus metrics** — status/channel/outbox/queue gauges (format text/plain) |
| GET | `/admin/queues` | Bull Board UI — xem queue/retry/delayed trực quan |

## Tính năng

- **Idempotency**: gửi header `Idempotency-Key` — client retry cùng key sẽ nhận lại notification cũ (`200 {id, status, deduplicated: true}`) thay vì tạo mới. Key lưu unique index trong SQLite, an toàn cả khi 2 request chạy song song.
- **Template** (Handlebars): thay `body` bằng `template` + `params` — body được render lúc enqueue. Template là file `.hbs` trong `templates/` (`otp`, `welcome` sẵn có). Đúng một trong hai: `body` hoặc `template`.
- **Channel `webhook`**: provider "thật" đầu tiên — `recipient` là URL http(s), hệ thống POST JSON `{subject, body}` tới đó (timeout 5s). Thử với https://webhook.site.
- **Priority**: `priority: "high" \| "normal" \| "low"` (mặc định normal) — job ưu tiên cao được xử lý trước.
- **Rate limit**: theo recipient, mặc định 10/phút (đếm từ DB nên đúng cả khi chạy nhiều instance API). Vượt → `429`.
- **Replay dead job**: job fail hết 3 lượt bị đánh dấu `failed` — đẩy lại bằng endpoint replay khi sự cố bên dưới đã hết.

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

# Gửi OTP bằng template + idempotency key (retry an toàn)
curl -X POST http://localhost:3000/notifications -H 'content-type: application/json' \
  -H 'idempotency-key: otp-user-42' \
  -d '{"channel":"sms","recipient":"+84901234567","template":"otp","params":{"code":"246810","minutes":5}}'

# Webhook — POST JSON tới URL của bạn
curl -X POST http://localhost:3000/notifications -H 'content-type: application/json' \
  -d '{"channel":"webhook","recipient":"https://webhook.site/xxx","body":"ping"}'
```

## Test

```bash
npm test          # chạy 1 lần
npm run test:watch
```

- **54 test**: db layer (unit), REST API + auth + phân trang + idempotency + template + webhook + rate limit + metrics (integration), queue scheduling + priority, **outbox pattern**, worker + retry + replay + cancelled-guard (integration).
- Test cần Redis sẽ **tự skip** nếu Redis không chạy — local không bật Docker vẫn được bộ unit test; **CI luôn chạy đủ** (GitHub Actions cấp service Redis).
- Chạy từng process riêng khi debug: `npm run dev:api` / `npm run dev:worker`.

## CI

GitHub Actions (`.github/workflows/ci.yml`): mỗi push/PR chạy `npm run typecheck` + `npm test` với service Redis 7.

## Luồng

```
POST /notifications → 1 TRANSACTION SQLite: row notification + row outbox (intent)
  (API không đụng Redis lúc nhận request — không còn dual-write problem)
Worker process:
  Outbox dispatcher (poll 500ms) → đọc outbox pending → push job lên BullMQ → đánh dấu dispatched
  Worker: processing → provider (mock 300-800ms fail theo FAIL_RATE, webhook là fetch thật)
    thành công → sent
    fail      → BullMQ retry (3 lần, backoff 1s/2s/4s) → hết → failed (dead)
GET /notifications/:id → timeline: enqueued → processing → (retry_scheduled)* → sent | dead
```

- Hủy scheduled an toàn với outbox: notification bị hủy trước kịp dispatch → dispatcher bỏ qua; bị hủy sau khi job lên queue → worker guard `cancelled`, không gọi provider và không đè status.
- Metrics xem realtime: `curl -H "x-api-key: ..." localhost:3000/metrics | grep notification`.

## Kiến trúc process

```
src/index.ts        → API (Fastify + Bull Board + /metrics)
src/start-worker.ts → Worker (concurrency 5) + Outbox dispatcher (poll 500ms)
```

Hai entry tách riêng nên API và worker scale độc lập — local `npm run dev` vẫn chạy cả hai bằng `concurrently`, Docker compose chạy 3 container: `redis` + `api` + `worker`.
