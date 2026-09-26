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
Client ── HTTP ──▶  Fastify API ── enqueue ──▶  BullMQ Queue (Redis)  ◀── consume ──  Worker (concurrency 5)
                    (src/api/routes.ts)        (src/queue/queue.ts)                (src/queue/worker.ts)
                          │                              │                                      │
                          │                              └── Bull Board UI (/admin/queues)      ▼
                          ▼                                                            Mock Providers
                     SQLite DB  ◀────────── ghi trạng thái + delivery events ────────  email / push / sms
                     (src/db.ts)                                                      (src/providers/)

Gửi ngay: job vào queue chạy liền.
Hẹn giờ:  client truyền sendAt → job được delay tới đúng thời điểm.
```

Hiện tại **API và Worker chạy chung 1 process** (`npm run dev` khởi động cả hai, kèm Bull Board).

---

## 3. Những gì đã làm được

### 3.1 REST API (Fastify + Zod)

| Method | Path | Chức năng | Ghi chú |
|---|---|---|---|
| `POST` | `/notifications` | Tạo yêu cầu gửi thông báo | Body: `{channel, recipient, subject?, body, sendAt?}`. Trả `202 {id, status}` |
| `GET` | `/notifications` | Danh sách | Lọc được theo `status`, `channel`; sắp xếp mới nhất trước |
| `GET` | `/notifications/:id` | Chi tiết | Trả notification + **timeline delivery events** |
| `DELETE` | `/notifications/:id` | Hủy notification | Chỉ hủy được khi đang `scheduled`, ngược lại trả `409` |
| `GET` | `/admin/queues` | Bull Board UI | Xem queue/retry/delayed job trực quan trên trình duyệt |

- Body đầu vào được **validate bằng Zod** (`src/api/routes.ts`): `channel` chỉ nhận `email | push | sms`, sai format trả `400` kèm chi tiết lỗi.
- `id` là UUID do hệ thống tự sinh.
- Có trường `sendAt` (ISO datetime) → thông báo chuyển thành **hẹn giờ**: job được delay đến đúng mốc thời gian đó, trạng thái ban đầu là `scheduled`.

### 3.2 Hàng đợi BullMQ + Redis (`src/queue/queue.ts`)

- Queue tên `notifications`, connection ioredis pin v5 khớp với BullMQ.
- **Gửi ngay hoặc hẹn giờ**: `sendAt` trong tương lai → `delay` = hiệu thời gian; quá khứ → coi như gửi ngay.
- Cấu hình job mỗi lần đẩy vào queue:
  - `jobId` = id của notification (tiện tra cứu, hủy).
  - `attempts: 3`, backoff exponential 1s → 2s → 4s.
  - `removeOnComplete` / `removeOnFail`: giữ tối đa 1000 job gần nhất mỗi loại.
- **Nguyên tắc "ghi DB trước, đẩy queue sau"**: một notification luôn có row trong SQLite trước khi job được add — nếu process chết giữa chừng, dữ liệu vẫn còn.

### 3.3 Worker xử lý job (`src/queue/worker.ts`)

- **Concurrency 5** — xử lý 5 job song song.
- Mỗi job: đánh dấu DB `processing` → gọi provider tương ứng kênh.
- **Retry tự động khi provider fail**: BullMQ tự retry tối đa 3 lần với backoff 1s/2s/4s. Hết lượt → DB chuyển `failed`.
- Worker lắng nghe event `completed` / `failed` để cập nhật trạng thái và **ghi delivery event** sau mỗi bước (thấy rõ từng lần retry trong timeline).

### 3.4 Mock providers cho 3 kênh (`src/providers/`)

- Ba provider `email`, `push`, `sms` cùng implements một interface `NotificationProvider` duy nhất (`send()`).
- Mô phỏng thật: trễ ngẫu nhiên **300–800ms**, fail ngẫu nhiên theo xác suất **`FAIL_RATE`** (mặc định `0.3`).
- Muốn thay provider thật (Nodemailer/Resend/Twilio/FCM...) chỉ cần đổi body của `send()` — kiến trúc đã tách sẵn.

### 3.5 Delivery tracking bằng SQLite (`src/db.ts`)

- 2 bảng: `notifications` (nội dung + trạng thái) và `delivery_events` (lịch sử từng bước, `AUTOINCREMENT` theo thứ tự thời gian).
- Bật `PRAGMA journal_mode = WAL` cho đọc ghi song song tốt hơn.
- **Trạng thái** của một notification: `scheduled → queued → processing → sent | failed | cancelled`.
- **Timeline events** được ghi lại: `enqueued → processing → (retry_scheduled)* → sent | dead`, và `cancelled` nếu bị hủy.
  - Chi tiết thú vị: khi hết 3 lượt retry, DB status là `failed` nhưng event ghi là `dead` — tra cứu trạng thái nhìn `status`, xem lịch sử nhìn `events`.
- File DB mặc định `notifications.db` ở thư mục gốc, đổi được qua biến `DB_PATH`.

### 3.6 Hủy job hẹn giờ + xử lý race condition

- `DELETE /notifications/:id` chỉ cho hủy khi trạng thái là `scheduled` (trạng thái khác → `409`).
- **Đã xử lý race**: nếu giữa lúc API kiểm tra trạng thái và lúc gọi `job.remove()`, worker vừa nhặt job lên gửi (job bị lock) → bắt lỗi và trả `409 "notification đã bắt đầu gửi, không hủy được"` thay vì crash `500`. Đây là fix của commit mới nhất (`66840a7`).

### 3.7 Quan sát hệ thống

- **Bull Board UI** tại `http://localhost:3000/admin/queues` — xem job đang chờ, đang chạy, delayed, đã retry, đã fail ngay trên trình duyệt.
- Demo script end-to-end (`npm run demo`, chạy song song với server): gửi thông báo cả 3 kênh + 1 job hẹn giờ sau 30s, chờ worker xử lý rồi in timeline từng job ra terminal.
- Fastify bật logger mặc định (JSON log ra terminal).

---

## 4. Biến môi trường

| Biến | Mặc định | Ý nghĩa |
|---|---|---|
| `PORT` | `3000` | Cổng API |
| `REDIS_URL` | `redis://localhost:6379` | Địa chỉ Redis |
| `FAIL_RATE` | `0.3` | Xác suất mock provider fail (0–1). Đặt `0.5`+ để thấy retry rõ |
| `DB_PATH` | `notifications.db` | Đường dẫn file SQLite |

---

## 5. Cấu trúc mã nguồn

```
src/
├── index.ts              # Bootstrap: Fastify + routes + Bull Board + worker (1 process)
├── config.ts             # Đọc biến môi trường
├── db.ts                 # SQLite: schema, CRUD notification + delivery events
├── demo.ts               # Script demo end-to-end
├── api/
│   └── routes.ts         # 4 REST endpoints + Zod validation
├── queue/
│   ├── queue.ts          # BullMQ Queue + logic enqueue (delay, retry, jobId)
│   └── worker.ts         # Worker consume + retry + ghi events
└── providers/
    ├── types.ts          # Interface NotificationProvider
    ├── email.ts / sms.ts / push.ts   # 3 mock providers
    └── index.ts          # Registry: channel → provider
```

---

## 6. Giới hạn hiện tại (chưa làm)

Đây là những điểm **cố ý chưa làm** — là hướng phát triển tiếp theo của dự án:

1. **Chưa có test tự động** — không có unit/integration test nào.
2. **Chưa có auth** — API mở hoàn toàn, ai gọi cũng được (kể cả DELETE và `/admin/queues`).
3. **Chưa có pagination** cho `GET /notifications` — trả toàn bộ kết quả.
4. **API và Worker chung 1 process** — chưa tách riêng để scale worker độc lập.
5. **Provider vẫn là mock** — chưa gửi ra ngoài thế giới thật.
6. **SQLite thay cho DB production** — phù hợp demo, chưa phù hợp nhiều instance ghi đồng thời.
7. **Chưa có Dockerfile cho app** — `docker-compose.yml` mới chỉ chứa Redis.
8. **Chưa có idempotency key** — client gửi lại 2 lần sẽ tạo 2 notification.
9. **Job `failed` chưa có cơ chế đẩy lại** (replay dead job).
10. **Chưa có CI/CD**, chưa có health check endpoint, chưa có OpenAPI docs.

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
