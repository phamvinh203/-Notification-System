import { DatabaseSync } from 'node:sqlite';
import { config } from './config.js';

export type Channel = 'email' | 'push' | 'sms' | 'webhook';
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
  idempotency_key: string | null;
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
db.exec('CREATE UNIQUE INDEX IF NOT EXISTS idx_idempotency_key ON notifications(idempotency_key) WHERE idempotency_key IS NOT NULL;');

export function createNotification(n: {
  id: string; channel: Channel; recipient: string; subject?: string;
  body: string; status: Status; scheduled_at: string | null; idempotency_key?: string | null;
}): void {
  db.prepare(
    `INSERT INTO notifications (id, channel, recipient, subject, body, status, scheduled_at, created_at, idempotency_key)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(n.id, n.channel, n.recipient, n.subject ?? null, n.body, n.status, n.scheduled_at, new Date().toISOString(), n.idempotency_key ?? null);
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
  filter: { status?: string; channel?: string },
  page: { limit: number; offset: number },
): NotificationRow[] {
  const clauses: string[] = [];
  const params: string[] = [];
  if (filter.status) { clauses.push('status = ?'); params.push(filter.status); }
  if (filter.channel) { clauses.push('channel = ?'); params.push(filter.channel); }
  const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
  return db.prepare(
    `SELECT * FROM notifications ${where} ORDER BY created_at DESC LIMIT ? OFFSET ?`
  ).all(...params, page.limit, page.offset) as unknown as NotificationRow[];
}

export function countNotifications(filter: { status?: string; channel?: string }): number {
  const clauses: string[] = [];
  const params: string[] = [];
  if (filter.status) { clauses.push('status = ?'); params.push(filter.status); }
  if (filter.channel) { clauses.push('channel = ?'); params.push(filter.channel); }
  const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
  const row = db.prepare(`SELECT COUNT(*) AS total FROM notifications ${where}`).get(...params) as { total: number };
  return row.total;
}

export function findByIdempotencyKey(key: string): NotificationRow | undefined {
  return db.prepare('SELECT * FROM notifications WHERE idempotency_key = ?').get(key) as NotificationRow | undefined;
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
  db.exec('DELETE FROM delivery_events; DELETE FROM notifications;');
}
