import { DatabaseSync } from 'node:sqlite';
import { config } from './config.js';

export type Channel = 'email' | 'push' | 'sms' | 'webhook';
export type Status =
  | 'scheduled' | 'queued' | 'processing' | 'sent' | 'failed' | 'cancelled'
  // recurring: lịch lặp cron (job repeatable); blocked: worker bỏ gửi do preference tắt kênh
  | 'recurring' | 'blocked';

export interface NotificationRow {
  id: string;
  channel: string;
  recipient: string;
  subject: string | null;
  body: string;
  status: string;
  scheduled_at: string | null;
  created_at: string;
  idempotency_key: string | null;
  broadcast_id: string | null;
  recurrence: string | null;
}

export interface DeliveryEventRow {
  id: number;
  notification_id: string;
  event: string;
  detail: string | null;
  created_at: string;
}

const db = new DatabaseSync(config.dbPath);
db.exec('PRAGMA journal_mode = WAL;');

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

// migration nhẹ: thêm cột khi DB cũ chưa có (node:sqlite không có "ADD COLUMN IF NOT EXISTS")
const cols = db.prepare(`SELECT name FROM pragma_table_info('notifications')`).all() as Array<{ name: string }>;
if (!cols.some((c) => c.name === 'idempotency_key')) {
  db.exec('ALTER TABLE notifications ADD COLUMN idempotency_key TEXT;');
}
if (!cols.some((c) => c.name === 'broadcast_id')) {
  db.exec('ALTER TABLE notifications ADD COLUMN broadcast_id TEXT;');
}
if (!cols.some((c) => c.name === 'recurrence')) {
  db.exec('ALTER TABLE notifications ADD COLUMN recurrence TEXT;');
}
db.exec('CREATE UNIQUE INDEX IF NOT EXISTS idx_idempotency_key ON notifications(idempotency_key) WHERE idempotency_key IS NOT NULL;');
db.exec('CREATE INDEX IF NOT EXISTS idx_notifications_broadcast ON notifications(broadcast_id);');

// outbox pattern: intent đẩy job ghi CÙNG transaction với notification
db.exec(`
  CREATE TABLE IF NOT EXISTS outbox (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    notification_id TEXT NOT NULL REFERENCES notifications(id),
    payload         TEXT NOT NULL,
    status          TEXT NOT NULL DEFAULT 'pending',
    created_at      TEXT NOT NULL,
    dispatched_at   TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_outbox_status ON outbox(status);
`);

// nền tảng notification: broadcast theo topic, preference theo recipient
db.exec(`
  CREATE TABLE IF NOT EXISTS broadcasts (
    id           TEXT PRIMARY KEY,
    topic        TEXT NOT NULL,
    subject      TEXT,
    body         TEXT NOT NULL,
    status       TEXT NOT NULL DEFAULT 'pending',
    total        INTEGER NOT NULL DEFAULT 0,
    created_at   TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS topic_subscribers (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    topic      TEXT NOT NULL,
    recipient  TEXT NOT NULL,
    channel    TEXT NOT NULL,
    created_at TEXT NOT NULL,
    UNIQUE(topic, recipient, channel)
  );
  CREATE TABLE IF NOT EXISTS preferences (
    recipient  TEXT NOT NULL,
    channel    TEXT NOT NULL,
    enabled    INTEGER NOT NULL DEFAULT 1,
    updated_at TEXT NOT NULL,
    PRIMARY KEY (recipient, channel)
  );
`);

export function createNotification(n: {
  id: string; channel: Channel; recipient: string; subject?: string;
  body: string; status: Status; scheduled_at: string | null; idempotency_key?: string | null;
  broadcast_id?: string | null; recurrence?: string | null;
}): void {
  db.prepare(
    `INSERT INTO notifications (id, channel, recipient, subject, body, status, scheduled_at, created_at, idempotency_key, broadcast_id, recurrence)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(n.id, n.channel, n.recipient, n.subject ?? null, n.body, n.status, n.scheduled_at, new Date().toISOString(),
    n.idempotency_key ?? null, n.broadcast_id ?? null, n.recurrence ?? null);
}

export function deleteNotification(id: string): void {
  db.prepare('DELETE FROM delivery_events WHERE notification_id = ?').run(id);
  db.prepare('DELETE FROM outbox WHERE notification_id = ?').run(id);
  db.prepare('DELETE FROM notifications WHERE id = ?').run(id);
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
  const events = db.prepare('SELECT * FROM delivery_events WHERE notification_id = ? ORDER BY id').all(id) as unknown as DeliveryEventRow[];
  return { notification, events };
}

export function listNotifications(
  filter: { status?: string; channel?: string; broadcastId?: string },
  page: { limit: number; offset: number },
): NotificationRow[] {
  const clauses: string[] = [];
  const params: string[] = [];
  if (filter.status) { clauses.push('status = ?'); params.push(filter.status); }
  if (filter.channel) { clauses.push('channel = ?'); params.push(filter.channel); }
  if (filter.broadcastId) { clauses.push('broadcast_id = ?'); params.push(filter.broadcastId); }
  const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
  return db.prepare(
    `SELECT * FROM notifications ${where} ORDER BY created_at DESC LIMIT ? OFFSET ?`
  ).all(...params, page.limit, page.offset) as unknown as NotificationRow[];
}

export function countNotifications(filter: { status?: string; channel?: string; broadcastId?: string }): number {
  const clauses: string[] = [];
  const params: string[] = [];
  if (filter.status) { clauses.push('status = ?'); params.push(filter.status); }
  if (filter.channel) { clauses.push('channel = ?'); params.push(filter.channel); }
  if (filter.broadcastId) { clauses.push('broadcast_id = ?'); params.push(filter.broadcastId); }
  const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
  const row = db.prepare(`SELECT COUNT(*) AS total FROM notifications ${where}`).get(...params) as { total: number };
  return row.total;
}

export function countByStatus(): Record<string, number> {
  const rows = db.prepare('SELECT status, COUNT(*) AS total FROM notifications GROUP BY status').all() as unknown as Array<{ status: string; total: number }>;
  return Object.fromEntries(rows.map((r) => [r.status, r.total]));
}

export function countByChannel(): Record<string, number> {
  const rows = db.prepare('SELECT channel, COUNT(*) AS total FROM notifications GROUP BY channel').all() as unknown as Array<{ channel: string; total: number }>;
  return Object.fromEntries(rows.map((r) => [r.channel, r.total]));
}

export function findByIdempotencyKey(key: string): NotificationRow | undefined {
  return db.prepare('SELECT * FROM notifications WHERE idempotency_key = ?').get(key) as NotificationRow | undefined;
}

// atomic dual-write: notification + outbox intent trong CÙNG transaction.
// DB commit thành công = intent đẩy job chắc chắn còn đó, dispatcher sẽ nhặt được.
export function createNotificationWithOutbox(n: {
  id: string; channel: Channel; recipient: string; subject?: string;
  body: string; status: Status; scheduled_at: string | null; idempotency_key?: string | null;
  broadcast_id?: string | null;
}, payload: string): void {
  db.exec('BEGIN IMMEDIATE;');
  try {
    createNotification(n);
    db.prepare(
      'INSERT INTO outbox (notification_id, payload, status, created_at) VALUES (?, ?, ?, ?)'
    ).run(n.id, payload, 'pending', new Date().toISOString());
    db.exec('COMMIT;');
  } catch (e) {
    db.exec('ROLLBACK;');
    throw e;
  }
}

export function getPendingOutbox(limit = 100): Array<{ id: number; notification_id: string; payload: string }> {
  return db.prepare(
    `SELECT id, notification_id, payload FROM outbox WHERE status = 'pending' ORDER BY id LIMIT ?`
  ).all(limit) as unknown as Array<{ id: number; notification_id: string; payload: string }>;
}

export function markOutboxDispatched(id: number): void {
  db.prepare(`UPDATE outbox SET status = 'dispatched', dispatched_at = ? WHERE id = ?`)
    .run(new Date().toISOString(), id);
}

export function countOutbox(status: 'pending' | 'dispatched'): number {
  const row = db.prepare('SELECT COUNT(*) AS total FROM outbox WHERE status = ?').get(status) as { total: number };
  return row.total;
}

// đếm notification của 1 recipient trong khoảng thời gian (dùng cho rate limit)
export function countRecentByRecipient(recipient: string, sinceIso: string): number {
  const row = db.prepare(
    'SELECT COUNT(*) AS total FROM notifications WHERE recipient = ? AND created_at >= ?'
  ).get(recipient, sinceIso) as { total: number };
  return row.total;
}

// helper cho test — xoá sạch dữ liệu giữa các test case
export function clearTables(): void {
  db.exec(`DELETE FROM delivery_events; DELETE FROM outbox; DELETE FROM notifications;
           DELETE FROM broadcasts; DELETE FROM topic_subscribers; DELETE FROM preferences;`);
}

// ===== broadcast theo topic =====

export interface BroadcastRow {
  id: string;
  topic: string;
  subject: string | null;
  body: string;
  status: string;
  total: number;
  created_at: string;
  created: number;
  sent: number;
  failed: number;
  pending: number;
}

export function createBroadcast(b: { id: string; topic: string; subject?: string; body: string }): void {
  db.prepare(
    'INSERT INTO broadcasts (id, topic, subject, body, status, total, created_at) VALUES (?, ?, ?, ?, ?, 0, ?)'
  ).run(b.id, b.topic, b.subject ?? null, b.body, 'pending', new Date().toISOString());
}

export function setBroadcastDispatched(id: string, total: number): void {
  db.prepare(`UPDATE broadcasts SET status = 'dispatched', total = ? WHERE id = ?`).run(total, id);
}

export function getBroadcast(id: string): BroadcastRow | undefined {
  const b = db.prepare('SELECT id, topic, subject, body, status, total, created_at FROM broadcasts WHERE id = ?')
    .get(id) as Omit<BroadcastRow, 'created' | 'sent' | 'failed' | 'pending'> | undefined;
  if (!b) return undefined;
  return { ...b, ...broadcastCounts(id) };
}

export function listBroadcasts(limit = 50): BroadcastRow[] {
  const rows = db.prepare('SELECT id, topic, subject, body, status, total, created_at FROM broadcasts ORDER BY created_at DESC LIMIT ?')
    .all(limit) as Array<Omit<BroadcastRow, 'created' | 'sent' | 'failed' | 'pending'>>;
  return rows.map((b) => ({ ...b, ...broadcastCounts(b.id) }));
}

function broadcastCounts(id: string): { created: number; sent: number; failed: number; pending: number } {
  const row = db.prepare(`
    SELECT
      COUNT(*) AS created,
      SUM(CASE WHEN status = 'sent' THEN 1 ELSE 0 END) AS sent,
      SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END) AS failed,
      SUM(CASE WHEN status IN ('queued','scheduled','processing') THEN 1 ELSE 0 END) AS pending
    FROM notifications WHERE broadcast_id = ?
  `).get(id) as { created: number; sent: number | null; failed: number | null; pending: number | null };
  return { created: row.created, sent: row.sent ?? 0, failed: row.failed ?? 0, pending: row.pending ?? 0 };
}

// ===== topic subscribers =====

export function subscribeTopic(topic: string, recipient: string, channel: Channel): boolean {
  const res = db.prepare(
    'INSERT OR IGNORE INTO topic_subscribers (topic, recipient, channel, created_at) VALUES (?, ?, ?, ?)'
  ).run(topic, recipient, channel, new Date().toISOString());
  return Number(res.changes) > 0;
}

export function unsubscribeTopic(topic: string, recipient: string, channel: Channel): boolean {
  const res = db.prepare(
    'DELETE FROM topic_subscribers WHERE topic = ? AND recipient = ? AND channel = ?'
  ).run(topic, recipient, channel);
  return Number(res.changes) > 0;
}

export function listTopicSubscribers(topic: string): Array<{ recipient: string; channel: Channel }> {
  return db.prepare('SELECT recipient, channel FROM topic_subscribers WHERE topic = ? ORDER BY id')
    .all(topic) as unknown as Array<{ recipient: string; channel: Channel }>;
}

export function listTopics(): Array<{ topic: string; subscribers: number }> {
  return db.prepare(
    'SELECT topic, COUNT(*) AS subscribers FROM topic_subscribers GROUP BY topic ORDER BY topic'
  ).all() as unknown as Array<{ topic: string; subscribers: number }>;
}

// ===== preference theo recipient =====

export function setPreference(recipient: string, channel: Channel, enabled: boolean): void {
  db.prepare(`
    INSERT INTO preferences (recipient, channel, enabled, updated_at) VALUES (?, ?, ?, ?)
    ON CONFLICT(recipient, channel) DO UPDATE SET enabled = excluded.enabled, updated_at = excluded.updated_at
  `).run(recipient, channel, enabled ? 1 : 0, new Date().toISOString());
}

export function getPreference(recipient: string, channel: Channel): { enabled: boolean } | undefined {
  const row = db.prepare('SELECT enabled FROM preferences WHERE recipient = ? AND channel = ?')
    .get(recipient, channel) as { enabled: number } | undefined;
  return row ? { enabled: row.enabled === 1 } : undefined;
}

export function listPreferences(recipient: string): Array<{ channel: Channel; enabled: boolean; updated_at: string }> {
  const rows = db.prepare('SELECT channel, enabled, updated_at FROM preferences WHERE recipient = ? ORDER BY channel')
    .all(recipient) as unknown as Array<{ channel: Channel; enabled: number; updated_at: string }>;
  // SQLite lưu INTEGER 0/1 — trả về boolean cho JSON
  return rows.map((r) => ({ ...r, enabled: r.enabled === 1 }));
}
