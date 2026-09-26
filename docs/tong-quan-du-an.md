# Tổng quan dự án — Notification System

> Tài liệu này giải thích dự án **đang làm được những gì** ở thời điểm hiện tại — kiến trúc, tính năng đã hoàn thành, luồng vận hành và những giới hạn còn lại. Cách chạy dự án xem [README.md](../README.md).

---

## 1. Dự án này là gì?

Một hệ thống gửi thông báo (notification) viết cho mục đích **học kiến trúc event-driven với hàng đợi**. Toàn bộ các thành phần đều "thật" trừ phần gửi đi cuối cùng (provider là mock), nên có thể demo đầy đủ vòng đời của một thông báo: nhận yêu cầu → đẩy vào queue → worker xử lý → retry khi lỗi → lưu lịch sử → tra cứu lại.

**Stack:** Node ≥ 22.5 (dùng `node:sqlite` built-in) · TypeScript · Fastify 5 · BullMQ 5 + Redis (chạy bằng Docker) · SQLite · Zod.

---

## 2. Kiến trúc tổng quan

```
                          ┌──────────────────────────── 1 process (src/index.ts) ───────────────────────────┐
                          │                                                                                 │
Client ── HTTP ──▶  Fastify API ── 1 TRANSACTION: notification + outbox  ──▶            SQLite DB            │
                    (src/api/routes.ts)                                                     (src/db.ts)
                          │                                                                     ▲          │
                          │  Bull Board UI (/admin/queues)                          đọc outbox pending      │
                          ▼                                                            │          │
                          └──▶ BullMQ Queue (Redis) ◀── push job ── Dispatcher (poll 500ms) ────┘          │
                                          ▲                                                                │
                                          └── consume ── Worker (concurrency 5) ── Mock Providers           │
                                                                                    email/push/sms/webhook │
                                             trạng thái + delivery events ────────────────────────────────┘

Gửi ngay: dispatcher đẩy job liền (poll 500ms). Hẹn giờ: payload chứa delay, BullMQ chờ đến hạn.
```

**API và Worker tách thành 2 entry riêng** (`src/index.ts` và `src/start-worker.ts`): local `npm run dev` chạy cả hai bằng `concurrently`, còn Docker compose chạy 3 container độc lập (`redis` + `api` + `worker`). API nhận request **không cần đụng Redis** — chỉ ghi SQLite; worker process vừa chạy outbox dispatcher vừa consume job.

---

## 3. Những gì đã làm được

### 3.1 REST API (Fastify + Zod)

| Method | Path | Chức năng | Ghi chú |
|---|---|---|---|
| `GET` | `/health` | Health check | Luôn mở, không cần API key — dùng cho docker healthcheck |
| `POST` | `/notifications` | Tạo yêu cầu gửi thông báo | Body: `{channel, recipient, subject?, body \| template, params?, sendAt?, priority?, recurrence?}`. Trả `202 {id, status}`. Có `recurrence` (cron 5 trường) → thành **lịch lặp**, trả `202 {id, status: "recurring"}` |
| `GET` | `/notifications` | Danh sách, có **phân trang** | Lọc theo `status`, `channel`, `broadcast` (broadcast id); `limit` (1–100, default 20), `offset`. Trả `{items, total, limit, offset}` |
| `GET` | `/notifications/:id` | Chi tiết | Trả notification + **timeline delivery events** |
| `DELETE` | `/notifications/:id` | Hủy notification | Hủy được khi `scheduled` **hoặc `recurring`** (gỡ job scheduler khỏi BullMQ), ngược lại trả `409` |
| `POST` | `/notifications/:id/replay` | Đẩy lại job dead | Chỉ khi status `failed`; ngược lại `409` |
| `GET` | `/templates` | Danh sách template | Tên các template `.hbs` khả dụng |
| `POST` | `/topics/:topic/subscribers` | Đăng ký người nhận vào topic | Body `{recipient, channel}`; idempotent — đăng ký lại trả `200` (lần đầu `201`) |
| `GET` | `/topics` | Danh sách topic + số subscriber | |
| `GET` | `/topics/:topic/subscribers` | Danh sách subscriber của topic | |
| `DELETE` | `/topics/:topic/subscribers` | Hủy đăng ký | Body `{recipient, channel}`; không tồn tại → `404` |
| `POST` | `/topics/:topic/send` | **Broadcast** tới cả topic | Body `{subject?, body \| template, params?}`. Fan-out chạy trong worker; trả `202 {broadcastId, topic, subscribers}`. Topic rỗng → `404` |
| `GET` | `/broadcasts` | Danh sách broadcast | Kèm counts `created/sent/failed/pending` |
| `GET` | `/broadcasts/:id` | Chi tiết broadcast | |
| `GET` | `/preferences/:recipient` | Xem preference người nhận | |
| `PUT` | `/preferences/:recipient` | Bật/tắt kênh cho người nhận | Body `{channel, enabled}`; worker chặn gửi kênh bị tắt |
| `GET` | `/metrics` | Prometheus metrics | Format `text/plain`; cùng chính sách auth như `/notifications*` |
| `GET` | `/admin/queues` | Bull Board UI | Xem queue/retry/delayed job trực quan trên trình duyệt |

- Body đầu vào được **validate bằng Zod** (`src/api/routes.ts`): `channel` chỉ nhận `email | push | sms`, sai format trả `400` kèm chi tiết lỗi. Query params phân trang cũng validate bằng Zod (`limit=0` → 400).
- `id` là UUID do hệ thống tự sinh.
- Có trường `sendAt` (ISO datetime) → thông báo chuyển thành **hẹn giờ**: job được delay đến đúng mốc thời gian đó, trạng thái ban đầu là `scheduled` (nếu `sendAt` ở quá khứ thì coi như gửi ngay, nhưng vẫn lưu lại mốc client yêu cầu).

### 3.2 Hàng đợi BullMQ + Redis + Outbox pattern (`src/queue/queue.ts`)

- Queue tên `notifications`, connection ioredis pin v5 khớp với BullMQ.
- **Gửi ngay hoặc hẹn giờ**: `sendAt` trong tương lai → `delay` = hiệu thời gian; quá khứ → coi như gửi ngay (vẫn lưu mốc client yêu cầu).
- Cấu hình job: `jobId` = id notification, `attempts: 3`, backoff exponential 1s → 2s → 4s, giữ tối đa 1000 job complete/fail mỗi loại.
- **Outbox pattern** (mục 3.9): API KHÔNG add job lúc nhận request — chỉ ghi notification + outbox intent trong 1 transaction. Job được dispatcher trong worker process đẩy lên BullMQ sau đó (poll 500ms).

### 3.3 Worker xử lý job (`src/queue/worker.ts`)

- **Concurrency 5** — xử lý 5 job song song.
- Mỗi job: đánh dấu DB `processing` → gọi provider tương ứng kênh.
- **Retry tự động khi provider fail**: BullMQ tự retry tối đa 3 lần với backoff 1s/2s/4s. Hết lượt → DB chuyển `failed`.
- Worker lắng nghe event `completed` / `failed` để cập nhật trạng thái và **ghi delivery event** sau mỗi bước (thấy rõ từng lần retry trong timeline).

### 3.4 Providers — mock + thật (`src/providers/`)

- Bốn kênh `email`, `push`, `sms`, `webhook` cùng implements interface `NotificationProvider` (`send()` trả `SendResult | void` — info được worker ghi vào event `sent`).
- **Mock** (email/push/sms khi không cấu hình): trễ ngẫu nhiên **300–800ms**, fail ngẫu nhiên theo **`FAIL_RATE`** (mặc định `0.3`) — để demo retry.
- **Webhook (thật)**: `recipient` là URL http(s) — POST JSON `{subject, body}` (timeout 5s).
- **Email thật** (`EMAIL_MODE`):
  - `smtp` + `SMTP_PRESET=ethereal` — **SMTP thật zero-config** qua [Ethereal](https://ethereal.email): tự tạo tài khoản test, email gửi qua SMTP thật và xem được online qua **link preview ghi vào timeline event `sent`** (không delivery vào inbox cá nhân).
  - `smtp` + `SMTP_HOST/PORT/SECURE/USER/PASS` (Nodemailer) — vào **hộp thư thật** (Gmail app password, Mailtrap...).
  - `resend` + `RESEND_API_KEY/RESEND_FROM` — HTTP API Resend, inbox thật.
- **SMS thật** (`SMS_MODE=twilio`): REST API Twilio + Basic auth (`TWILIO_ACCOUNT_SID/AUTH_TOKEN/FROM`); trial chỉ gửi tới số đã verify.
- **Push**: vẫn mock — FCM cần Firebase project (bước sau).
- Thêm provider mới: implement `send()` rồi đăng ký trong `index.ts` — kiến trúc đã tách sẵn.

### 3.4b Tính năng notification "thật" hơn

- **Idempotency key**: header `Idempotency-Key` — gửi trùng key nhận lại notification cũ (`200 {id, status, deduplicated: true}`) thay vì tạo mới. Key lưu cột `idempotency_key` với **partial unique index** trong SQLite; khi 2 request cùng key chạy song song, unique index chặn và request thua trả về row của request thắng. Check dedupe diễn ra **trước** rate limit để client retry không bị 429.
- **Template engine** (Handlebars, `src/templates.ts`): thay `body` bằng `template` + `params`. Template là file `.hbs` trong `templates/` (`otp`, `welcome` có sẵn), nạp lúc khởi động, compile với `noEscape` (plain text). Body được render **tại thời điểm enqueue** — job trên queue chỉ mang body thuần. `GET /templates` liệt kê template khả dụng. Validate: phải có đúng một trong hai `body` hoặc `template`.
- **Replay dead job**: `POST /notifications/:id/replay` — chỉ nhận notification status `failed` (ngược lại 409). Remove job cũ khỏi failed set rồi add lại với `jobId` cũ, status về `queued`, timeline ghi event `replayed`.
- **Rate limit theo recipient**: `RATE_LIMIT_PER_MINUTE` (mặc định 10, `0` = tắt) — đếm notification của recipient trong 60s qua **trực tiếp từ DB** nên vẫn đúng khi chạy nhiều instance API. Vượt → `429`.
- **Priority queue**: `priority: high | normal | low` map sang số BullMQ (1/5/9 — số nhỏ ưu tiên cao). Chỉ áp lúc enqueue; job replay chạy lại với priority mặc định.

### 3.5 Delivery tracking bằng SQLite (`src/db.ts`)

- 5 bảng: `notifications`, `delivery_events`, `outbox`, `broadcasts`, `topic_subscribers`, `preferences` (nội dung + trạng thái + lịch sử + nền tảng topic/preference).
- Bật `PRAGMA journal_mode = WAL` cho đọc ghi song song tốt hơn.
- **Trạng thái** của một notification: `scheduled → queued → processing → sent | failed | cancelled`, cùng 2 trạng thái đặc biệt: `recurring` (lịch lặp cron — row là lịch, không đổi trạng thái theo từng lần bắn) và `blocked` (worker bỏ gửi vì người nhận đã tắt kênh).
- **Timeline events** được ghi lại: `enqueued → processing → (retry_scheduled)* → sent | dead`, và `cancelled` nếu bị hủy.
  - Chi tiết thú vị: khi hết 3 lượt retry, DB status là `failed` nhưng event ghi là `dead` — tra cứu trạng thái nhìn `status`, xem lịch sử nhìn `events`.
- File DB mặc định `notifications.db` ở thư mục gốc, đổi được qua biến `DB_PATH`.

### 3.6 Hủy job hẹn giờ + xử lý race condition

- `DELETE /notifications/:id` chỉ cho hủy khi trạng thái là `scheduled` (trạng thái khác → `409`).
- **Đã xử lý race**: nếu giữa lúc API kiểm tra trạng thái và lúc gọi `job.remove()`, worker vừa nhặt job lên gửi (job bị lock) → bắt lỗi và trả `409 "notification đã bắt đầu gửi, không hủy được"` thay vì crash `500`. Đây là fix của commit mới nhất (`66840a7`).

### 3.7 Quan sát hệ thống

- **Bull Board UI** tại `http://localhost:3000/admin/queues` — xem job đang chờ, đang chạy, delayed, đã retry, đã fail ngay trên trình duyệt.
- Demo script end-to-end (`npm run demo`, chạy song song với server): gửi thông báo cả 3 kênh + 1 job hẹn giờ sau 30s, chờ worker xử lý rồi in timeline từng job ra terminal. Tự gửi header `x-api-key` khi set biến `API_KEY`.
- Fastify bật logger mặc định (JSON log ra terminal).

### 3.8 Nền tảng chất lượng

- **Auth API key** với chính sách **reads-open**: set `API_KEY` → mọi `GET` (danh sách, chi tiết, templates, metrics) mở cho browser đọc; thao tác ghi (`POST`/`DELETE`/replay) và Bull Board `/admin/queues` yêu cầu header `x-api-key`, sai/thiếu trả `401`. `/health` luôn mở. Không set biến → tắt auth (dev local). Hiện thực qua preHandler hook trong `src/app.ts`.
- **Phân trang** cho danh sách: `{items, total, limit, offset}` thay vì trả toàn bộ mảng.
- **76 test tự động** (vitest): db layer (unit), REST API + auth + phân trang + idempotency + template + webhook + rate limit + metrics (integration qua Fastify `inject`), queue scheduling + priority, outbox pattern, worker + retry + replay + cancelled-guard, topics/broadcast/preferences/recurring. Test cần Redis **tự skip** khi Redis không chạy — local không bật Docker vẫn chạy được bộ unit.
- **Docker hóa**: `Dockerfile` (node:22-alpine, chạy TS trực tiếp bằng tsx) + `docker-compose.yml` với 3 service `redis` / `api` / `worker`, có healthcheck (`127.0.0.1` tường minh — `localhost` trong container resolve sang `::1` sẽ refused vì Node listen IPv4), SQLite persist qua volume `./data`.
- **CI**: GitHub Actions chạy `typecheck` + `test` trên mỗi push/PR, cấp service Redis 7.
- **Tách entry API / Worker**: `src/index.ts` (API) và `src/start-worker.ts` (worker + outbox dispatcher, graceful shutdown SIGINT/SIGTERM).

### 3.9 Kiến trúc nâng cao: Outbox pattern + Observability

**Outbox pattern** — giải quyết *dual-write problem* của kiến trúc cũ: API ghi SQLite xong mà process chết trước khi đẩy job lên Redis → notification kẹt `queued` mãi, không ai đẩy lại. Cách hiện thực:

1. `POST /notifications` ghi **notification + outbox intent trong CÙNG transaction** SQLite (`BEGIN IMMEDIATE` ... `COMMIT`, hàm `createNotificationWithOutbox`). Commit thành công = intent chắc chắn còn đó.
2. **Outbox dispatcher** (chạy trong worker process, poll 500ms): đọc outbox `pending` → push job lên BullMQ → đánh dấu `dispatched`. Push trùng (crash giữa add và mark) không tạo job đôi vì BullMQ `jobId` = notificationId là idempotent.
3. **Cancel an toàn 2 chiều**: notification bị hủy trước kịp dispatch → dispatcher bỏ qua, không tạo job; bị hủy sau khi job đã lên queue → worker có guard `cancelled` (không gọi provider, event `skipped_cancelled`, completed handler không đè status về `sent`).
4. Đánh đổi: scheduled job trễ thêm ~500ms (khoảng poll) — chấp nhận được, ghi rõ trong docs.

**Observability**:

- `GET /metrics` (prom-client, format Prometheus): gauges `notifications_by_status`, `notifications_by_channel`, `outbox_pending`, `bullmq_jobs{state}` + default process metrics. Gauges tính **trực tiếp từ SQLite + Redis lúc scrape** — realtime và đúng cho dù api/worker là 2 process riêng (không cần counter in-memory).
- Timeline `delivery_events` trong DB + Bull Board UI + JSON logger của Fastify.
- Docker healthcheck `/health` cho container api.

### 3.10 Dashboard frontend (mục 4)

Dashboard React ở `dashboard/` (Vite + TS + Tailwind v4 + Phosphor icons, react-router) — design system sinh từ skill ui-ux-pro-max: **glassmorphism dark tech** (nền `#0F172A`, accent xanh trạng thái `#22C55E`), font Fira Code/Fira Sans, density 8, dark mặc định + light mode, tôn trọng `prefers-reduced-motion`.

- **Tổng quan**: stat tiles trạng thái + queue BullMQ + bar theo kênh, poll `/metrics` mỗi 3s có nút pause, nhãn "Cập nhật lúc …" và cảnh báo stale.
- **Thông báo**: bảng lọc status/channel + phân trang, hành động hủy (confirm dialog) và replay, auto-refresh 5s tùy chọn.
- **Chi tiết**: thông tin + nội dung + **timeline delivery events** màu theo loại event; tự poll 2s khi notification đang chạy (scheduled/queued/processing).
- **Tạo mới**: form chọn kênh (radio card), recipient helper theo kênh, body HOẶC template + params JSON (validate), priority, hẹn giờ, Idempotency-Key, **preview payload live**, báo lỗi server rõ nguyên nhân + cách khắc phục (401 → gợi ý đặt API key).
- API key thao tác ghi nhập ở topbar, lưu `localStorage`. Dev proxy `/api` → `:3000` (prefix riêng tránh đụng SPA route `/notifications`).

---

## 4. Biến môi trường

| Biến | Mặc định | Ý nghĩa |
|---|---|---|
| `PORT` | `3000` | Cổng API |
| `REDIS_URL` | `redis://localhost:6379` | Địa chỉ Redis |
| `FAIL_RATE` | `0.3` | Xác suất mock provider fail (0–1). Đặt `0.5`+ để thấy retry rõ |
| `DB_PATH` | `notifications.db` | Đường dẫn file SQLite |
| `API_KEY` | *(không set — tắt auth)* | Set thì yêu cầu header `x-api-key` cho `/notifications*` và `/admin/queues` |
| `RATE_LIMIT_PER_MINUTE` | `10` | Notification tối đa / recipient / phút. `0` = tắt. Vượt → `429` |

---

## 5. Cấu trúc mã nguồn

```
src/
├── index.ts              # Entry API: bootstrap app, listen
├── start-worker.ts       # Entry Worker: chạy worker + graceful shutdown
├── app.ts                # buildApp(): Fastify + /health + auth hook + routes + Bull Board
├── config.ts             # Đọc biến môi trường
├── db.ts                 # SQLite: schema + migration nhẹ, CRUD + phân trang + delivery events
├── templates.ts          # Registry Handlebars: nạp templates/*.hbs, render theo tên
├── metrics.ts            # Prometheus registry + gauges (tính từ SQLite + Redis lúc scrape)
├── demo.ts               # Script demo end-to-end
├── api/
│   └── routes.ts         # REST endpoints + Zod validation + idempotency + rate limit + replay
├── queue/
│   ├── queue.ts          # BullMQ Queue + enqueue (delay, retry, priority, idempotency) + replay
│   └── worker.ts         # Worker consume + retry + ghi events
└── providers/
    ├── types.ts          # Interface NotificationProvider
    ├── email.ts / sms.ts / push.ts   # 3 mock providers
    ├── webhook.ts        # Provider thật: POST JSON tới URL
    └── index.ts          # Registry: channel → provider

templates/                # Template Handlebars (otp.hbs, welcome.hbs)
tests/                    # vitest: db (unit), api/queue/worker (integration, tự skip khi không có Redis)
Dockerfile                # node:22-alpine, chạy TS bằng tsx
docker-compose.yml        # 3 service: redis / api / worker
.github/workflows/ci.yml  # CI: typecheck + test (service Redis)
```

---

## 6. Giới hạn hiện tại (chưa làm)

Đây là những điểm **cố ý chưa làm** — là hướng phát triển tiếp theo của dự án:

1. **Provider email/push/sms vẫn là mock** — chỉ webhook là thật; cắm Resend/Twilio/FCM cần tài khoản dịch vụ.
2. **SQLite thay cho DB production** — phù hợp demo, chưa phù hợp nhiều instance ghi đồng thời (lên Postgres + Drizzle là bước tiếp).
3. **Quản lý template qua API/DB** — template hiện là file `.hbs` cố định, sửa là phải deploy lại.
4. **Rate limit mới đếm lúc tạo** — chưa throttle ở worker (xả job đều tay).
5. **Chưa có OpenAPI docs** tự sinh từ zod schema.
6. **Auth mới ở mức API key tĩnh** — chưa có multi-tenant, hết hạn, thu hồi key.
7. **Metrics mới là gauges trạng thái** — chưa có histogram latency, chưa gắn Prometheus/Grafana service vào compose.

> Đã hoàn thành: nền tảng chất lượng (test, Docker, CI, phân trang, auth, tách process) — 2026-09-26; tính năng notification "thật" hơn (idempotency, template, webhook, replay, rate limit, priority) — 2026-09-26; kiến trúc nâng cao (outbox pattern, Prometheus metrics) — 2026-09-26; dashboard frontend — 2026-09-26; ship v1.0: Fastify serve dashboard same-origin (SPA fallback theo Accept header) + Prometheus & Grafana vào compose + Dockerfile multi-stage build UI — 2026-09-26; provider thật (SMTP Ethereal/Gmail, Resend, Twilio) — 2026-09-26; **nền tảng notification: topic/broadcast, preference theo recipient, lịch lặp cron** — 2026-09-27.

### 3.11 Ship v1.0 — một lệnh có cả sản phẩm + monitoring

- **Fastify serve dashboard**: khi có `dashboard/dist` (biến `DASHBOARD_DIST`, Dockerfile multi-stage build sẵn trong image), api container phục vụ UI same-origin tại `/`.
- **SPA fallback theo Accept header**: browser navigate (Accept chứa `text/html`) tới bất kỳ route nào cũng nhận `index.html` — gõ trực tiếp `localhost:3000/notifications/<id>` vẫn vào UI; curl/fetch/Prometheus (Accept khác) đi thẳng API; `/admin/queues`, `/metrics`, `/health` được miễn để Bull Board/raw metrics phục vụ riêng.
- **Dockerfile 2 stage**: stage `ui-build` chạy `npm ci && npm run build` cho dashboard; stage runtime copy `dist` vào `/app/dashboard-dist`.
- **Prometheus** (`ops/prometheus/prometheus.yml`): scrape `api:3000/metrics` mỗi 15s bằng `Authorization: Bearer <API_KEY>` — lý do auth hook nhận thêm Bearer.
- **Grafana** (`ops/grafana/`): datasource Prometheus + dashboard "Notification System" provision tự động (stat trạng thái, timeseries `bullmq_jobs`/`outbox_pending`, barchart theo kênh). Port 3001, login admin/admin (demo).

### 3.12 Nền tảng notification: topic/broadcast, preference, lịch lặp cron

**Topic + Broadcast** — gửi 1 lần cho cả nhóm người nhận:

1. Đăng ký subscriber: `POST /topics/:topic/subscribers` `{recipient, channel}` — idempotent (unique `topic+recipient+channel`).
2. Broadcast: `POST /topics/:topic/send` — API chỉ ghi 1 row `broadcasts` + đẩy 1 job `broadcast` lên BullMQ. **Fan-out chạy trong worker**: đọc subscribers → tạo 1 notification cho mỗi người (qua outbox — giữ đúng kiến trúc) → API trả ngay `202`, không chặn.
3. **Idempotent khi retry**: mỗi notification fan-out có id deterministic `sha256(broadcastId:recipient:channel)` — job broadcast retry lại (crash giữa chừng) không tạo notification trùng, hàm `enqueueSafe` trả về row đã có thay vì lỗi.
4. Counts realtime: `GET /broadcasts/:id` tính `created/sent/failed/pending` bằng SUM trực tiếp từ bảng notifications.

**Preference theo recipient** — người nhận quyền kiểm soát kênh:

- `PUT /preferences/:recipient` `{channel, enabled}` — upsert vào bảng `preferences`.
- Worker kiểm tra trước khi gọi provider: kênh bị tắt → status `blocked`, event `blocked_preference`, **không tốn lượt gửi provider**. Guard `completed` không đè status `blocked` về `sent`.
- Broadcast lọc sẵn ngay từ khâu fan-out — subscriber tắt kênh không tạo notification.

**Lịch lặp cron** (`recurrence` trên `POST /notifications`):

- Cron 5 trường (validate bằng `cron-parser` trước khi enqueue, sai → `400`), ví dụ `"0 8 * * *"` = 8h sáng mỗi ngày.
- Row notification có status `recurring` — là **LỊCH**, không phải lần gửi cụ thể: worker không đổi status mỗi lần bắn, lần bắn fail chỉ ghi event `fire_failed` (không rơi `failed` vĩnh viễn — cron tự bắn lần sau), mỗi lần gửi xong ghi event `sent` như thường.
- Job repeatable BullMQ với `repeat: { pattern, key: id }` — key = notification id để tìm/gỡ được (BullMQ v5: job scheduler, `removeJobScheduler(id)`; API cũ `getRepeatableJobs()` không trả job id).
- Hủy lịch: `DELETE /notifications/:id` khi status `recurring` → gỡ job scheduler khỏi BullMQ + đánh dấu `cancelled`.
- Đánh đổi đã ghi nhận: lịch lặp KHÔNG đi qua outbox (outbox là cơ chế one-shot) — job scheduler nằm sẵn trên BullMQ, crash Redis là mất schedule (tương đương mức độ mất mát của chính BullMQ).

---

## 7. Lịch sử phát triển (8 commits)

| Commit | Nội dung |
|---|---|
| `3c3796b` | Scaffold project: tsconfig, docker-compose Redis, config |
| `7c30897` | DB layer SQLite: 2 bảng notifications + delivery_events |
| `75f0048` | Mock providers email/push/sms với FAIL_RATE |
| `3dd95a5` | BullMQ queue + producer, hỗ trợ hẹn giờ (delay) |
| `f12a6ff` | Worker consume job, retry backoff, ghi delivery events |
| `6b2f7a2` | REST API + Bull Board UI + bootstrap |
| `c13dd29` | Demo script end-to-end + README |
| `66840a7` | Fix: khai báo ioredis trực tiếp (pin v5 khớp BullMQ) + chặn race DELETE-vs-worker (500 → 409) |
| `58588b6`…`6f2ff7f` | Nền tảng chất lượng (buildApp, tách entry, /health, phân trang, auth, 30 test, Docker, CI) + tính năng notification "thật" hơn (idempotency, template, webhook, replay, rate limit, priority) |
| `cbed309` | Kiến trúc nâng cao: outbox pattern (transaction DB+outbox, dispatcher, guard cancelled) + Prometheus /metrics + fix healthcheck IPv6 |
| `9065480` | Dashboard frontend: 4 trang (Tổng quan/Danh sách/Chi tiết/Tạo mới) + đổi chính sách auth reads-open + GUI test bằng browser |
| `d072be1` | Ship v1.0: Fastify serve dashboard (SPA fallback Accept header), Dockerfile multi-stage build UI, Prometheus + Grafana vào compose, auth nhận thêm Bearer |
| *(chưa commit)* | Provider thật: email qua SMTP thật (preset Ethereal zero-config + host riêng qua Nodemailer) / Resend API, SMS qua Twilio REST API; send() trả info ghi vào event sent |
| *(chưa commit)* | Secrets qua file .env (gitignored), compose không còn plaintext password |
| *(chưa commit)* | Nền tảng notification: topic/broadcast (fan-out trong worker, id deterministic), preference recipient (status blocked), lịch lặp cron (job scheduler BullMQ v5, status recurring) — 76 test |
