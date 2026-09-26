# Notification System — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Notification system demo: gửi đa kênh (email/push/sms mock) qua BullMQ + Redis, có retry, scheduling, delivery tracking, REST API.

**Architecture:** Fastify API chỉ enqueue job rồi trả 202; Worker consume job → gọi mock provider → ghi delivery events vào SQLite. BullMQ đảm nhận retry (backoff) + delayed jobs (scheduling). Bull Board UI xem queue tại `/admin/queues`.

**Tech Stack:** Node.js ≥ 20, TypeScript (ESM, nodenext), Fastify 5, BullMQ 5, better-sqlite3, zod 3, @bull-board 6, Redis (docker), tsx.

**Spec:** `docs/superpowers/specs/2026-09-26-notification-system-design.md`

## Global Constraints

- ESM: `"type": "module"` — mọi relative import trong `src/` phải có đuôi `.js`.
- `tsconfig`: `module: nodenext`, `strict: true`. Sau mỗi task chạy `npx tsc --noEmit` phải sạch.
- Worker/Queue connection phải có `maxRetriesPerRequest: null` (BullMQ bắt buộc cho Worker).
- Retry: `attempts: 3`, `backoff: { type: 'exponential', delay: 1000 }` — đúng spec, không đổi.
- Mock providers dùng `config.failRate` (env `FAIL_RATE`, default `0.3`) — KHÔNG hardcode.
- Trạng thái hợp lệ: `scheduled | queued | processing | sent | failed | cancelled`. Events: `enqueued | processing | retry_scheduled | sent | dead | cancelled`.
- Kiểm chứng bằng script chạy được + curl (spec đã chốt: không viết vitest suite).
- Commit sau mỗi task, message dạng `feat: ...` / `chore: ...`.

## Review Focus

Các đầu vào spec không nêu tường minh — mỗi dòng gắn với task kiểm nó:

1. **`sendAt` trong quá khứ** → kỳ vọng: gửi ngay (delay = 0), KHÔNG lỗi. — Task 4.
2. **FAIL_RATE=1 kéo dài (hết 3 attempts)** → kỳ vọng: status `failed` + event `dead`, dừng retry, không treo vô hạn. — Task 5.
3. **DELETE notification đã gửi/không phải scheduled** → kỳ vọng: `409`, job không bị đụng. — Task 6.
4. **GET/DELETE id không tồn tại** → kỳ vọng: `404` JSON gọn, không crash server. — Task 6.
5. **Body sai (channel lạ, thiếu body, sendAt không phải ISO)** → kỳ vọng: `400` + error map từ zod, KHÔNG tạo row trong DB. — Task 6.

---

### Task 1: Scaffold + tooling + Redis

**Files:**
- Create: `package.json`, `tsconfig.json`, `docker-compose.yml`, `.gitignore`, `src/config.ts`

**Interfaces:**
- Produces: `config` object — `{ port: number, redisUrl: string, failRate: number, dbPath: string }` — mọi task sau import từ `./config.js`.

- [ ] **Step 1: git init + .gitignore**

```bash
git init
```

`.gitignore`:

```
node_modules/
dist/
*.db
*.db-wal
*.db-shm
```

- [ ] **Step 2: package.json**

```json
{
  "name": "notification-system",
  "version": "0.1.0",
  "type": "module",
  "scripts": {
    "dev": "tsx watch src/index.ts",
    "demo": "tsx src/demo.ts",
    "typecheck": "tsc --noEmit"
  },
  "dependencies": {
    "@bull-board/api": "^6.11.0",
    "@bull-board/fastify": "^6.11.0",
    "better-sqlite3": "^11.10.0",
    "bullmq": "^5.52.0",
    "fastify": "^5.3.0",
    "zod": "^3.25.0"
  },
  "devDependencies": {
    "@types/better-sqlite3": "^7.6.13",
    "@types/node": "^22.15.0",
    "tsx": "^4.20.0",
    "typescript": "^5.8.0"
  }
}
```

- [ ] **Step 3: tsconfig.json**

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "nodenext",
    "moduleResolution": "nodenext",
    "strict": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "outDir": "dist",
    "types": ["node"]
  },
  "include": ["src"]
}
```

- [ ] **Step 4: docker-compose.yml (chỉ Redis)**

```yaml
services:
  redis:
    image: redis:7-alpine
    ports:
      - "6379:6379"
```

- [ ] **Step 5: src/config.ts**

```ts
export const config = {
  port: Number(process.env.PORT ?? 3000),
  redisUrl: process.env.REDIS_URL ?? 'redis://localhost:6379',
  failRate: Number(process.env.FAIL_RATE ?? 0.3),
  dbPath: process.env.DB_PATH ?? 'notifications.db',
};
```

- [ ] **Step 6: cài deps + chạy Redis + typecheck**

```bash
npm install
docker compose up -d redis
docker compose ps        # kỳ vọng: redis trạng thái Up
npx tsc --noEmit         # kỳ vọng: không lỗi (src/config.ts sạch)
```

Lưu ý: nếu `@bull-board/fastify` báo conflict peer dep với fastify 5 → `npm install -D` không giải được thì hạ `fastify` về `^4.28.0` (bull-board 6 hỗ trợ cả 4 và 5; chọn 4 nếu cài lỗi).

- [ ] **Step 7: Commit**

```bash
git add -A
git commit -m "chore: scaffold project (tsconfig, docker redis, config)"
```

---

### Task 2: DB layer (SQLite)

**Files:**
- Create: `src/db.ts`

**Interfaces:**
- Consumes: `config.dbPath` từ Task 1.
- Produces:
  - `type Channel = 'email' | 'push' | 'sms'`
  - `type Status = 'scheduled' | 'queued' | 'processing' | 'sent' | 'failed' | 'cancelled'`
  - `interface NotificationRow { id: string; channel: string; recipient: string; subject: string | null; body: string; status: string; scheduled_at: string | null; created_at: string }`
  - `createNotification(n: { id: string; channel: Channel; recipient: string; subject?: string; body: string; status: Status; scheduled_at: string | null }): void`
  - `setStatus(id: string, status: Status): void`
  - `recordEvent(notificationId: string, event: string, detail?: string): void`
  - `getNotification(id: string): { notification: NotificationRow; events: DeliveryEventRow[] } | undefined`
  - `listNotifications(filter: { status?: string; channel?: string }): NotificationRow[]`

- [ ] **Step 1: src/db.ts**

```ts
import Database from 'better-sqlite3';
import { config } from './config.js';

export type Channel = 'email' | 'push' | 'sms';
export type Status = 'scheduled' | 'queued' | 'processing' | 'sent' | 'failed' | 'cancelled';

export interface NotificationRow {
  id: string;
  channel: string;
  recipient: string;
  subject: string | null;
  body: string;
  status: string;
  scheduled_at: string | null;
  created_at: string;
}

export interface DeliveryEventRow {
  id: number;
  notification_id: string;
  event: string;
  detail: string | null;
  created_at: string;
}

const db = new Database(config.dbPath);
db.pragma('journal_mode = WAL');

db.exec(`
  CREATE TABLE IF NOT EXISTS notifications (
    id           TEXT PRIMARY KEY,
    channel      TEXT NOT NULL,
    recipient    TEXT NOT NULL,
    subject      TEXT,
    body         TEXT NOT NULL,
    status       TEXT NOT NULL,
    scheduled_at TEXT,
    created_at   TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS delivery_events (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    notification_id TEXT NOT NULL REFERENCES notifications(id),
    event           TEXT NOT NULL,
    detail          TEXT,
    created_at      TEXT NOT NULL
  );
`);

export function createNotification(n: {
  id: string; channel: Channel; recipient: string; subject?: string;
  body: string; status: Status; scheduled_at: string | null;
}): void {
  db.prepare(
    `INSERT INTO notifications (id, channel, recipient, subject, body, status, scheduled_at, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(n.id, n.channel, n.recipient, n.subject ?? null, n.body, n.status, n.scheduled_at, new Date().toISOString());
}

export function setStatus(id: string, status: Status): void {
  db.prepare('UPDATE notifications SET status = ? WHERE id = ?').run(status, id);
}

export function recordEvent(notificationId: string, event: string, detail?: string): void {
  db.prepare(
    'INSERT INTO delivery_events (notification_id, event, detail, created_at) VALUES (?, ?, ?, ?)'
  ).run(notificationId, event, detail ?? null, new Date().toISOString());
}

export function getNotification(id: string): { notification: NotificationRow; events: DeliveryEventRow[] } | undefined {
  const notification = db.prepare('SELECT * FROM notifications WHERE id = ?').get(id) as NotificationRow | undefined;
  if (!notification) return undefined;
  const events = db.prepare('SELECT * FROM delivery_events WHERE notification_id = ? ORDER BY id').all(id) as DeliveryEventRow[];
  return { notification, events };
}

export function listNotifications(filter: { status?: string; channel?: string }): NotificationRow[] {
  const clauses: string[] = [];
  const params: string[] = [];
  if (filter.status) { clauses.push('status = ?'); params.push(filter.status); }
  if (filter.channel) { clauses.push('channel = ?'); params.push(filter.channel); }
  const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
  return db.prepare(`SELECT * FROM notifications ${where} ORDER BY created_at DESC`).all(...params) as NotificationRow[];
}
```

- [ ] **Step 2: Chạy check inline (tạo → đọc → list → event)**

```bash
npx tsx -e "
import { createNotification, setStatus, recordEvent, getNotification, listNotifications } from './src/db.js';
const id = 'test-1';
createNotification({ id, channel: 'email', recipient: 'a@b.c', subject: 's', body: 'b', status: 'queued', scheduled_at: null });
recordEvent(id, 'enqueued', 'immediate');
setStatus(id, 'processing');
const got = getNotification(id);
console.log(JSON.stringify(got, null, 2));
console.log('list:', listNotifications({ status: 'processing' }).length);
if (got?.notification.status !== 'processing' || got.events.length !== 1) { throw new Error('DB check FAILED'); }
console.log('DB check OK');
"
```

Kỳ vọng: in ra row `status: "processing"`, `events` có 1 phần tử `enqueued`, `list: 1`, `DB check OK`.

- [ ] **Step 3: Typecheck + commit**

```bash
npx tsc --noEmit
git add -A && git commit -m "feat: sqlite db layer (notifications + delivery_events)"
```

---

### Task 3: Mock providers (email / push / sms)

**Files:**
- Create: `src/providers/types.ts`, `src/providers/email.ts`, `src/providers/push.ts`, `src/providers/sms.ts`, `src/providers/index.ts`

**Interfaces:**
- Consumes: `config.failRate` từ Task 1; `Channel` từ Task 2.
- Produces:
  - `interface SendRequest { to: string; subject?: string; body: string }`
  - `interface NotificationProvider { send(req: SendRequest): Promise<void> }` — throw khi fail.
  - `providers: Record<Channel, NotificationProvider>` — key `email | push | sms`.

- [ ] **Step 1: src/providers/types.ts**

```ts
export interface SendRequest {
  to: string;
  subject?: string;
  body: string;
}

export interface NotificationProvider {
  send(req: SendRequest): Promise<void>;
}
```

- [ ] **Step 2: src/providers/email.ts**

```ts
import { config } from '../config.js';
import type { NotificationProvider, SendRequest } from './types.js';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// ponytail: mock — thay provider thật (nodemailer/SendGrid) bằng cách đổi body send()
export const emailProvider: NotificationProvider = {
  async send(req: SendRequest): Promise<void> {
    await sleep(300 + Math.random() * 500);
    if (Math.random() < config.failRate) {
      throw new Error(`[mock:email] delivery failed to ${req.to}`);
    }
    console.log(`[mock:email] sent to ${req.to}: ${req.subject ?? '(no subject)'}`);
  },
};
```

- [ ] **Step 3: src/providers/push.ts**

```ts
import { config } from '../config.js';
import type { NotificationProvider, SendRequest } from './types.js';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// ponytail: mock — thay bằng FCM/APNs adapter khi cần
export const pushProvider: NotificationProvider = {
  async send(req: SendRequest): Promise<void> {
    await sleep(300 + Math.random() * 500);
    if (Math.random() < config.failRate) {
      throw new Error(`[mock:push] delivery failed to device ${req.to}`);
    }
    console.log(`[mock:push] sent to device ${req.to}`);
  },
};
```

- [ ] **Step 4: src/providers/sms.ts**

```ts
import { config } from '../config.js';
import type { NotificationProvider, SendRequest } from './types.js';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// ponytail: mock — thay bằng Twilio/eSMS adapter khi cần
export const smsProvider: NotificationProvider = {
  async send(req: SendRequest): Promise<void> {
    await sleep(300 + Math.random() * 500);
    if (Math.random() < config.failRate) {
      throw new Error(`[mock:sms] delivery failed to ${req.to}`);
    }
    console.log(`[mock:sms] sent to ${req.to}: ${req.body.slice(0, 40)}`);
  },
};
```

- [ ] **Step 5: src/providers/index.ts (registry)**

```ts
import type { Channel } from '../db.js';
import { emailProvider } from './email.js';
import { pushProvider } from './push.js';
import { smsProvider } from './sms.js';
import type { NotificationProvider } from './types.js';

export const providers: Record<Channel, NotificationProvider> = {
  email: emailProvider,
  push: pushProvider,
  sms: smsProvider,
};
```

- [ ] **Step 6: Check — FAIL_RATE=0 thì resolve, FAIL_RATE=1 thì throw**

```bash
npx tsx -e "
import { providers } from './src/providers/index.js';
await providers.email.send({ to: 'a@b.c', subject: 's', body: 'b' });
await providers.push.send({ to: 'tok', body: 'b' });
await providers.sms.send({ to: '+849', body: 'b' });
console.log('FAIL_RATE=0 OK');
" ; npx tsx -e "
process.env.FAIL_RATE = '1';
const { config } = await import('./src/config.js');
console.assert(config.failRate === 1, 'failRate phải là 1');
try {
  await (await import('./src/providers/index.js')).providers.sms.send({ to: '+849', body: 'b' });
  console.error('FAILED: phải throw');
  process.exit(1);
} catch (e) { console.log('FAIL_RATE=1 throw OK:', (e as Error).message); }
"
```

Kỳ vọng: dòng `[mock:*] sent` ×3 + `FAIL_RATE=0 OK`; lần 2 in `FAIL_RATE=1 throw OK: [mock:sms]...`. Lưu ý: biến `FAIL_RATE` phải set TRƯỚC khi import config (env được đọc lúc import) — script thứ 2 dùng dynamic import sau khi set env.

- [ ] **Step 7: Typecheck + commit**

```bash
npx tsc --noEmit
git add -A && git commit -m "feat: mock providers (email/push/sms) với failRate"
```

---

### Task 4: Queue + producer (enqueue, scheduling)

**Files:**
- Create: `src/queue/queue.ts`

**Interfaces:**
- Consumes: `config.redisUrl`; `createNotification`, `recordEvent`, `Channel` từ Task 2.
- Produces:
  - `connection: IORedis` (dùng chung, `maxRetriesPerRequest: null`)
  - `notificationQueue: Queue<JobData>` (name `'notifications'`)
  - `interface JobData { notificationId: string; channel: Channel; recipient: string; subject?: string; body: string }`
  - `interface EnqueueInput { channel: Channel; recipient: string; subject?: string; body: string; sendAt?: string }`
  - `enqueueNotification(input: EnqueueInput): Promise<{ id: string; status: Status }>` — tạo DB row + event `enqueued` + add job với `jobId: id`, `attempts: 3`, backoff exp 1000, `delay` = `sendAt - now` (min 0).

- [ ] **Step 1: src/queue/queue.ts**

```ts
import { randomUUID } from 'node:crypto';
import IORedis from 'ioredis';
import { Queue } from 'bullmq';
import { config } from '../config.js';
import { createNotification, recordEvent, type Channel, type Status } from '../db.js';

export const connection = new IORedis(config.redisUrl, { maxRetriesPerRequest: null });

export interface JobData {
  notificationId: string;
  channel: Channel;
  recipient: string;
  subject?: string;
  body: string;
}

export interface EnqueueInput {
  channel: Channel;
  recipient: string;
  subject?: string;
  body: string;
  sendAt?: string; // ISO — có thì thành scheduled
}

export const notificationQueue = new Queue<JobData>('notifications', { connection });

export async function enqueueNotification(input: EnqueueInput): Promise<{ id: string; status: Status }> {
  const id = randomUUID();
  const scheduledAt = input.sendAt ? new Date(input.sendAt) : undefined;
  const delay = scheduledAt ? Math.max(0, scheduledAt.getTime() - Date.now()) : undefined;
  const status: Status = scheduledAt ? 'scheduled' : 'queued';

  createNotification({
    id, channel: input.channel, recipient: input.recipient, subject: input.subject,
    body: input.body, status, scheduled_at: scheduledAt?.toISOString() ?? null,
  });
  recordEvent(id, 'enqueued', scheduledAt ? `scheduled at ${scheduledAt.toISOString()}` : 'immediate');

  await notificationQueue.add(
    'send',
    { notificationId: id, channel: input.channel, recipient: input.recipient, subject: input.subject, body: input.body },
    {
      jobId: id,
      delay,
      attempts: 3,
      backoff: { type: 'exponential', delay: 1000 },
      removeOnComplete: { count: 1000 },
      removeOnFail: { count: 1000 },
    },
  );
  return { id, status };
}
```

- [ ] **Step 2: Check — 3 case enqueue (ngay / tương lai / quá khứ)**

```bash
npx tsx -e "
import { enqueueNotification, notificationQueue, connection } from './src/queue/queue.js';
const a = await enqueueNotification({ channel: 'email', recipient: 'a@b.c', body: 'now' });
const b = await enqueueNotification({ channel: 'sms', recipient: '+849', body: 'later', sendAt: new Date(Date.now() + 60_000).toISOString() });
const c = await enqueueNotification({ channel: 'push', recipient: 'tok', body: 'past', sendAt: new Date(Date.now() - 60_000).toISOString() }); // quá khứ → gửi ngay
console.log({ a, b, c });
const jobs = await notificationQueue.getJobs(['waiting', 'delayed']);
const jc = jobs.find((j) => j.id === c.id);
console.log('past-sendAt delay:', jc?.opts.delay);
if (a.status !== 'queued' || b.status !== 'scheduled' || c.status !== 'queued') throw new Error('status sai');
if (jc && (jc.opts.delay ?? 0) !== 0) throw new Error('sendAt quá khứ phải có delay 0');
console.log('enqueue check OK');
await connection.quit();
"
```

Kỳ vọng: `a.status = queued`, `b.status = scheduled`, `c.status = queued` (quá khứ → gửi ngay, Review Focus #1), `past-sendAt delay: 0`, `enqueue check OK`.

- [ ] **Step 3: Typecheck + commit**

```bash
npx tsc --noEmit
git add -A && git commit -m "feat: bullmq queue + producer với scheduling (delay)"
```

---

### Task 5: Worker (consume, retry, ghi delivery events)

**Files:**
- Create: `src/queue/worker.ts`

**Interfaces:**
- Consumes: `connection`, `JobData` từ Task 4; `providers` từ Task 3; `setStatus`, `recordEvent` từ Task 2.
- Produces: `worker: Worker<JobData>` — import vào `src/index.ts` (Task 6).

- [ ] **Step 1: src/queue/worker.ts**

```ts
import { Worker, type Job } from 'bullmq';
import { connection, type JobData } from './queue.js';
import { providers } from '../providers/index.js';
import { recordEvent, setStatus } from '../db.js';

async function process(job: Job<JobData>): Promise<void> {
  const id = job.data.notificationId;
  setStatus(id, 'processing');
  recordEvent(id, 'processing', `attempt ${job.attemptsMade + 1}`);
  await providers[job.data.channel].send({
    to: job.data.recipient,
    subject: job.data.subject,
    body: job.data.body,
  });
}

export const worker = new Worker<JobData>('notifications', process, {
  connection,
  concurrency: 5,
});

worker.on('completed', (job) => {
  setStatus(job.data.notificationId, 'sent');
  recordEvent(job.data.notificationId, 'sent');
});

worker.on('failed', (job, err) => {
  if (!job) return;
  const id = job.data.notificationId;
  const isFinal = job.attemptsMade >= (job.opts.attempts ?? 1);
  if (isFinal) {
    setStatus(id, 'failed');
    recordEvent(id, 'dead', err.message);
  } else {
    recordEvent(id, 'retry_scheduled', `attempt ${job.attemptsMade} failed: ${err.message}`);
  }
});
```

- [ ] **Step 2: Check — luồng sent (FAIL_RATE=0)**

```bash
npx tsx -e "
import { enqueueNotification, connection } from './src/queue/queue.js';
import { worker } from './src/queue/worker.js';
import { getNotification } from './src/db.js';
const { id } = await enqueueNotification({ channel: 'email', recipient: 'a@b.c', body: 'hello' });
for (let i = 0; i < 20; i++) {
  await new Promise((r) => setTimeout(r, 500));
  const got = getNotification(id);
  if (got?.notification.status === 'sent') {
    console.log('events:', got.events.map((e) => e.event).join(' -> '));
    if (!got.events.some((e) => e.event === 'processing')) throw new Error('thiếu event processing');
    console.log('sent flow OK');
    await worker.close(); await connection.quit();
    process.exit(0);
  }
}
throw new Error('TIMEOUT: chưa sent sau 10s');
"
```

Kỳ vọng: `events: enqueued -> processing -> sent`, `sent flow OK`.

- [ ] **Step 3: Check — luồng dead sau khi hết retries (FAIL_RATE=1)**

```bash
FAIL_RATE=1 npx tsx -e "
import { enqueueNotification, connection } from './src/queue/queue.js';
import { worker } from './src/queue/worker.js';
import { getNotification } from './src/db.js';
const { id } = await enqueueNotification({ channel: 'sms', recipient: '+849', body: 'will fail' });
for (let i = 0; i < 40; i++) {
  await new Promise((r) => setTimeout(r, 500));
  const got = getNotification(id);
  if (got?.notification.status === 'failed') {
    console.log('events:', got.events.map((e) => e.event).join(' -> '));
    const retries = got.events.filter((e) => e.event === 'retry_scheduled').length;
    if (retries !== 2 || !got.events.some((e) => e.event === 'dead')) throw new Error('sai số retry/dead');
    console.log('dead flow OK (3 attempts, 2 retry, dừng đúng chỗ)');
    await worker.close(); await connection.quit();
    process.exit(0);
  }
}
throw new Error('TIMEOUT: chưa failed sau 20s');
"
```

Kỳ vọng: `events: enqueued -> processing -> retry_scheduled -> processing -> retry_scheduled -> processing -> dead`, `dead flow OK` (Review Focus #2: đúng 3 attempts, 2 lần retry backoff 1s/2s rồi dừng).

- [ ] **Step 4: Typecheck + commit**

```bash
npx tsc --noEmit
git add -A && git commit -m "feat: worker consume job, retry backoff, ghi delivery events"
```

---

### Task 6: REST API + Bull Board + bootstrap

**Files:**
- Create: `src/api/routes.ts`, `src/index.ts`

**Interfaces:**
- Consumes: `enqueueNotification`, `notificationQueue` từ Task 4; `worker` từ Task 5; `getNotification`, `listNotifications`, `setStatus`, `recordEvent` từ Task 2; `config.port` từ Task 1.
- Produces: server chạy tại `config.port` với 5 endpoints (spec mục 6).

- [ ] **Step 1: src/api/routes.ts**

```ts
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { enqueueNotification, notificationQueue } from '../queue/queue.js';
import { getNotification, listNotifications, recordEvent, setStatus } from '../db.js';

const createSchema = z.object({
  channel: z.enum(['email', 'push', 'sms']),
  recipient: z.string().min(1),
  subject: z.string().optional(),
  body: z.string().min(1),
  sendAt: z.string().datetime().optional(),
});

export async function registerRoutes(app: FastifyInstance): Promise<void> {
  app.post('/notifications', async (req, reply) => {
    const parsed = createSchema.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: parsed.error.flatten() });
    }
    const result = await enqueueNotification(parsed.data);
    return reply.code(202).send(result);
  });

  app.get('/notifications', async (req) => {
    const { status, channel } = req.query as { status?: string; channel?: string };
    return listNotifications({ status, channel });
  });

  app.get('/notifications/:id', async (req, reply) => {
    const { id } = req.params as { id: string };
    const row = getNotification(id);
    if (!row) return reply.code(404).send({ error: 'notification not found' });
    return row;
  });

  app.delete('/notifications/:id', async (req, reply) => {
    const { id } = req.params as { id: string };
    const row = getNotification(id);
    if (!row) return reply.code(404).send({ error: 'notification not found' });
    if (row.notification.status !== 'scheduled') {
      return reply.code(409).send({ error: `chỉ hủy được notification ở trạng thái scheduled (hiện: ${row.notification.status})` });
    }
    const job = await notificationQueue.getJob(id);
    await job?.remove();
    setStatus(id, 'cancelled');
    recordEvent(id, 'cancelled');
    return { id, status: 'cancelled' };
  });
}
```

- [ ] **Step 2: src/index.ts (bootstrap API + worker + Bull Board)**

```ts
import Fastify from 'fastify';
import { createBullBoard } from '@bull-board/api';
import { BullMQAdapter } from '@bull-board/api/bullMQAdapter';
import { FastifyAdapter } from '@bull-board/fastify';
import { config } from './config.js';
import { registerRoutes } from './api/routes.js';
import { notificationQueue } from './queue/queue.js';
import { worker } from './queue/worker.js';

const app = Fastify({ logger: true });

await app.register(registerRoutes);

const boardAdapter = new FastifyAdapter();
boardAdapter.setBasePath('/admin/queues');
createBullBoard({ queues: [new BullMQAdapter(notificationQueue)], serverAdapter: boardAdapter });
await app.register(boardAdapter.registerPlugin(), { prefix: '/admin/queues' });

await app.listen({ port: config.port, host: '0.0.0.0' });
console.log(`API + worker chạy tại http://localhost:${config.port} — Bull Board: /admin/queues`);
console.log(`Worker đang chạy: ${worker.isRunning()}`);
```

- [ ] **Step 3: Check — curl matrix**

Chạy server ở terminal riêng (hoặc background):

```bash
npm run dev
```

Terminal khác:

```bash
# 1. POST hợp lệ → 202 + { id, status: "queued" }
curl -s -X POST http://localhost:3000/notifications -H 'content-type: application/json' \
  -d '{"channel":"email","recipient":"a@b.c","subject":"hi","body":"test"}'

# 2. POST sai body (channel lạ + thiếu body) → 400 + error map (Review Focus #5)
curl -s -X POST http://localhost:3000/notifications -H 'content-type: application/json' \
  -d '{"channel":"fax","recipient":"x"}'

# 3. POST sendAt quá khứ → 202 (sẽ gửi ngay)
curl -s -X POST http://localhost:3000/notifications -H 'content-type: application/json' \
  -d '{"channel":"push","recipient":"tok","body":"x","sendAt":"2020-01-01T00:00:00.000Z"}'

# 4. GET list → mảng ≥ 2
curl -s http://localhost:3000/notifications

# 5. GET id lạ → 404 (Review Focus #4)
curl -s http://localhost:3000/notifications/khong-ton-tai

# 6. POST scheduled rồi DELETE → { status: "cancelled" }
SID=$(curl -s -X POST http://localhost:3000/notifications -H 'content-type: application/json' \
  -d '{"channel":"sms","recipient":"+849","body":"later","sendAt":"2030-01-01T00:00:00.000Z"}' | grep -o '"id":"[^"]*"' | cut -d'"' -f4)
curl -s -X DELETE http://localhost:3000/notifications/$SID

# 7. DELETE lại notification đã sent (lấy id từ GET list, cái bước 1) → 409 (Review Focus #3)
```

Kỳ vọng tuần tự: `202`/`400`/`202`/mảng/`404`/`cancelled`/`409`. Mở `http://localhost:3000/admin/queues` — thấy queue `notifications`, job completed/canceled xuất hiện. Dừng server (Ctrl+C).

- [ ] **Step 4: Typecheck + commit**

```bash
npx tsc --noEmit
git add -A && git commit -m "feat: REST API + Bull Board UI + bootstrap"
```

---

### Task 7: Demo script + README

**Files:**
- Create: `src/demo.ts`, `README.md`

**Interfaces:**
- Consumes: REST API của Task 6 qua `fetch` (không import trực tiếp — demo chạy khi server đang chạy).

- [ ] **Step 1: src/demo.ts**

```ts
// Demo end-to-end (spec mục 8). Chạy khi server đang chạy: npm run dev (terminal 1) → npm run demo (terminal 2).
const BASE = process.env.API_URL ?? 'http://localhost:3000';

interface EnqueueRes { id: string; status: string }

async function send(payload: Record<string, unknown>): Promise<EnqueueRes> {
  const res = await fetch(`${BASE}/notifications`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload),
  });
  if (!res.ok) throw new Error(`POST fail ${res.status}: ${await res.text()}`);
  return res.json() as Promise<EnqueueRes>;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function main(): Promise<void> {
  console.log(`Demo gọi API tại ${BASE} — gợi ý: đặt FAIL_RATE=0.5 khi chạy server để thấy retry rõ hơn\n`);

  // 1. Gửi ngay 3 kênh
  const ids: string[] = [];
  const targets = [
    { channel: 'email', recipient: 'student@example.com', subject: 'Demo email', body: 'Xin chào từ demo script' },
    { channel: 'push', recipient: 'device-token-abc-123', body: 'Bạn có 1 thông báo mới' },
    { channel: 'sms', recipient: '+84901234567', body: 'Ma xac minh: 246810' },
  ] as const;
  for (const t of targets) {
    const r = await send(t);
    ids.push(r.id);
    console.log(`[${t.channel}] id=${r.id} status=${r.status}`);
  }

  // 2. Schedule 1 email sau 30s
  const sendAt = new Date(Date.now() + 30_000).toISOString();
  const sched = await send({ channel: 'email', recipient: 'scheduled@example.com', subject: 'Demo scheduled', body: 'Gửi sau 30s', sendAt });
  console.log(`[email scheduled] id=${sched.id} status=${sched.status} (sẽ chạy lúc ${sendAt})`);

  // 3. Đợi worker xử lý rồi in timeline
  console.log('\nĐợi 12s cho worker xử lý 3 job đầu...');
  await sleep(12_000);
  for (const id of ids) {
    const res = await fetch(`${BASE}/notifications/${id}`);
    const { notification, events } = await res.json() as { notification: { status: string }; events: { event: string; detail: string | null }[] };
    console.log(`\n--- ${id} → ${notification.status}`);
    for (const e of events) console.log(`  ${e.event}${e.detail ? ` (${e.detail})` : ''}`);
  }

  // 4. Hướng xem trực quan
  console.log(`\nJob scheduled còn lại — xem trên Bull Board: ${BASE}/admin/queues`);
  console.log('Xem timeline job scheduled sau khi nó chạy: curl ' + `${BASE}/notifications/${sched.id}`);
}

main().catch((e) => { console.error(e); process.exit(1); });
```

- [ ] **Step 2: README.md**

````markdown
# Notification System (demo)

Hệ thống notification học kiến trúc event-driven: Fastify API → BullMQ (Redis) → Worker → mock providers → SQLite delivery tracking.

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
````

- [ ] **Step 3: Check — chạy demo theo README**

Terminal 1: `npm run dev`. Terminal 2: `npm run demo`.

Kỳ vọng in ra: 3 dòng `[kênh] id=... status=queued`, 1 dòng `[email scheduled] status=scheduled`, sau 12s: 3 block timeline (thấy `processing`, có thể có `retry_scheduled` tùy FAIL_RATE), cuối in URL Bull Board. Mở `/admin/queues` thấy 1 job delayed. Đợi hết 30s, `curl http://localhost:3000/notifications/{sched-id}` → timeline có `sent`.

- [ ] **Step 4: Commit cuối**

```bash
npx tsc --noEmit
git add -A && git commit -m "feat: demo script end-to-end + README"
```

---

## Self-review (đã chạy khi viết plan)

- **Spec coverage:** 6 yêu cầu spec → Task 4 (queue+scheduling), Task 5 (retry+tracking events), Task 3 (đa kênh), Task 6 (API+Bull Board), Task 7 (demo). Data model Task 2. Status flow phủ đủ qua các check sent/dead/cancelled. ✓
- **Placeholder scan:** không có TBD/TODO; mọi step có code lệnh cụ thể. ✓
- **Type consistency:** `JobData.notificationId` dùng thống nhất Task 4→5; `enqueueNotification` trả `{id, status}` khớp routes Task 6; `providers: Record<Channel, NotificationProvider>` khớp giữa Task 3 và 5; `getNotification` trả `{notification, events}` khớp demo Task 7. ✓
- **Review Focus:** #1 → Task 4 Step 2 (case `c`); #2 → Task 5 Step 3; #3/#4/#5 → Task 6 Step 3 (curl 6, 5, 2). ✓
