import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { CronExpressionParser } from 'cron-parser';
import {
  enqueueNotification, enqueueBroadcast, notificationQueue, replayNotification, removeRecurringJob,
  type PriorityName,
} from '../queue/queue.js';
import {
  countNotifications, countRecentByRecipient, findByIdempotencyKey, getNotification, listNotifications,
  recordEvent, setStatus,
  listTopics, listTopicSubscribers, subscribeTopic, unsubscribeTopic,
  getBroadcast, getPreference, listBroadcasts,
  listPreferences, setPreference,
} from '../db.js';
import { listTemplates, renderBody, renderTemplate } from '../templates.js';
import { buildUnsubscribeUrl, verifyUnsubscribeToken } from '../unsubscribe.js';
import { config } from '../config.js';

const createSchema = z.object({
  channel: z.enum(['email', 'push', 'sms', 'webhook']),
  recipient: z.string().min(1),
  subject: z.string().optional(),
  // body HOẶC template — đúng một trong hai
  body: z.string().min(1).optional(),
  template: z.string().optional(),
  params: z.record(z.unknown()).optional(),
  sendAt: z.string().datetime().optional(),
  priority: z.enum(['high', 'normal', 'low']).optional(),
  // cron 5 trường (VD "0 8 * * *") — có thì thành lịch lặp
  recurrence: z.string().optional(),
}).superRefine((d, ctx) => {
  if (Boolean(d.body) === Boolean(d.template)) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['body'], message: 'cần đúng một trong hai: body hoặc template' });
  }
  if (d.channel === 'webhook' && !/^https?:\/\/.+/.test(d.recipient)) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['recipient'], message: 'channel webhook cần recipient là URL http(s)' });
  }
});

const listQuerySchema = z.object({
  status: z.string().optional(),
  channel: z.string().optional(),
  broadcast: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(100).default(20),
  offset: z.coerce.number().int().min(0).default(0),
});

const subscribeSchema = z.object({
  recipient: z.string().min(1),
  channel: z.enum(['email', 'push', 'sms', 'webhook']),
});

const broadcastSendSchema = z.object({
  subject: z.string().optional(),
  body: z.string().min(1).optional(),
  template: z.string().optional(),
  params: z.record(z.unknown()).optional(),
  priority: z.enum(['high', 'normal', 'low']).optional(),
}).superRefine((d, ctx) => {
  if (Boolean(d.body) === Boolean(d.template)) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['body'], message: 'cần đúng một trong hai: body hoặc template' });
  }
});

const preferenceSchema = z.object({
  channel: z.enum(['email', 'push', 'sms', 'webhook']),
  enabled: z.boolean(),
});

function cronValidationError(expr: string): string | null {
  try {
    CronExpressionParser.parse(expr);
    return null;
  } catch (e) {
    return e instanceof Error ? e.message : 'cron không hợp lệ';
  }
}

export async function registerRoutes(app: FastifyInstance): Promise<void> {
  app.post('/notifications', async (req, reply) => {
    const parsed = createSchema.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: parsed.error.flatten() });
    }
    const data = parsed.data;

    if (data.recurrence) {
      const cronError = cronValidationError(data.recurrence);
      if (cronError) return reply.code(400).send({ error: `recurrence không hợp lệ: ${cronError}` });
    }

    // idempotency: header Idempotency-Key — client retry an toàn.
    // check sớm TRƯỚC rate limit để retry idempotent không bị 429 (enqueue bên dưới vẫn check lại phòng race)
    const idempotencyKey = (req.headers['idempotency-key'] as string | undefined) || undefined;
    if (idempotencyKey) {
      const existing = findByIdempotencyKey(idempotencyKey);
      if (existing) {
        return reply.code(200).send({ id: existing.id, status: existing.status, deduplicated: true });
      }
    }

    // rate limit theo recipient: đếm notification tạo trong 60s vừa qua
    if (config.rateLimitPerMinute > 0) {
      const since = new Date(Date.now() - 60_000).toISOString();
      const recent = countRecentByRecipient(data.recipient, since);
      if (recent >= config.rateLimitPerMinute) {
        return reply.code(429).send({
          error: `recipient "${data.recipient}" đã vượt giới hạn ${config.rateLimitPerMinute} notification/phút — thử lại sau`,
        });
      }
    }

    // template → render thành body tại thời điểm enqueue (job chỉ mang body thuần).
    // Biến hệ thống (recipient, unsubscribe_url) merge sau params người gọi — không bị ghi đè.
    const systemParams = {
      recipient: data.recipient,
      channel: data.channel,
      unsubscribe_url: buildUnsubscribeUrl(data.recipient, data.channel),
    };
    let body: string | null | undefined = data.body;
    if (data.template) {
      body = renderTemplate(data.template, { ...data.params, ...systemParams });
      if (body === null) {
        return reply.code(400).send({ error: `template "${data.template}" không tồn tại` });
      }
    } else {
      body = renderBody(body!, systemParams);
    }

    try {
      const result = await enqueueNotification({
        channel: data.channel,
        recipient: data.recipient,
        subject: data.subject,
        body: body!,
        sendAt: data.sendAt,
        idempotencyKey,
        priority: data.priority as PriorityName | undefined,
        recurrence: data.recurrence,
      });
      return reply.code(result.deduplicated ? 200 : 202).send(result);
    } catch (e) {
      return reply.code(400).send({ error: e instanceof Error ? e.message : 'enqueue thất bại' });
    }
  });

  app.get('/notifications', async (req, reply) => {
    const parsed = listQuerySchema.safeParse(req.query);
    if (!parsed.success) {
      return reply.code(400).send({ error: parsed.error.flatten() });
    }
    const { status, channel, broadcast, limit, offset } = parsed.data;
    const filter = { status, channel, broadcastId: broadcast };
    return {
      items: listNotifications(filter, { limit, offset }),
      total: countNotifications(filter),
      limit,
      offset,
    };
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
    const status = row.notification.status;

    // recurring: gỡ repeatable job khỏi BullMQ rồi đánh dấu cancelled
    if (status === 'recurring') {
      const removed = await removeRecurringJob(id);
      if (!removed) {
        return reply.code(409).send({ error: 'không tìm thấy lịch lặp tương ứng trong queue' });
      }
      setStatus(id, 'cancelled');
      recordEvent(id, 'cancelled', 'đã gỡ lịch lặp');
      return { id, status: 'cancelled' };
    }

    if (status !== 'scheduled') {
      return reply.code(409).send({ error: `chỉ hủy được notification ở trạng thái scheduled hoặc recurring (hiện: ${status})` });
    }
    const job = await notificationQueue.getJob(id);
    try {
      await job?.remove();
    } catch {
      // job vừa bị worker lock (bắt đầu gửi) — không hủy được nữa
      return reply.code(409).send({ error: 'notification đã bắt đầu gửi, không hủy được' });
    }
    setStatus(id, 'cancelled');
    recordEvent(id, 'cancelled');
    return { id, status: 'cancelled' };
  });

  // replay: đẩy lại job đã dead — mọi cấu hình retry mới bắt đầu từ đầu
  app.post('/notifications/:id/replay', async (req, reply) => {
    const { id } = req.params as { id: string };
    const result = await replayNotification(id);
    if (result === 'not_found') return reply.code(404).send({ error: 'notification not found' });
    if (result === 'not_failed') {
      return reply.code(409).send({ error: 'chỉ replay được notification ở trạng thái failed' });
    }
    return reply.code(202).send(result);
  });

  // danh sách template khả dụng — tiện khám phá API
  app.get('/templates', async () => ({ templates: listTemplates() }));

  // ===== TOPICS + BROADCAST =====

  // đăng ký người nhận vào topic (idempotent — đăng ký lại không lỗi)
  app.post('/topics/:topic/subscribers', async (req, reply) => {
    const { topic } = req.params as { topic: string };
    const parsed = subscribeSchema.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: parsed.error.flatten() });
    const { recipient, channel } = parsed.data;
    const created = subscribeTopic(topic, recipient, channel);
    return reply.code(created ? 201 : 200).send({ topic, recipient, channel, created });
  });

  app.get('/topics', async () => ({ topics: listTopics() }));

  app.get('/topics/:topic/subscribers', async (req) => {
    const { topic } = req.params as { topic: string };
    return { topic, subscribers: listTopicSubscribers(topic) };
  });

  app.delete('/topics/:topic/subscribers', async (req, reply) => {
    const { topic } = req.params as { topic: string };
    const parsed = subscribeSchema.safeParse(req.body ?? {});
    if (!parsed.success) return reply.code(400).send({ error: parsed.error.flatten() });
    const removed = unsubscribeTopic(topic, parsed.data.recipient, parsed.data.channel);
    if (!removed) return reply.code(404).send({ error: 'subscriber không tồn tại trong topic' });
    return { topic, ...parsed.data, removed: true };
  });

  // broadcast: 1 request → fan-out tới mọi subscriber của topic (trong worker)
  app.post('/topics/:topic/send', async (req, reply) => {
    const { topic } = req.params as { topic: string };
    const subscribers = listTopicSubscribers(topic);
    if (subscribers.length === 0) {
      return reply.code(404).send({ error: `topic "${topic}" chưa có subscriber nào` });
    }
    const parsed = broadcastSendSchema.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: parsed.error.flatten() });

    let body: string | null | undefined = parsed.data.body;
    if (parsed.data.template) {
      body = renderTemplate(parsed.data.template, parsed.data.params);
      if (body === null) return reply.code(400).send({ error: `template "${parsed.data.template}" không tồn tại` });
    }

    const { id } = await enqueueBroadcast(topic, { subject: parsed.data.subject, body: body! });
    return reply.code(202).send({ broadcastId: id, topic, subscribers: subscribers.length });
  });

  app.get('/broadcasts', async () => ({ broadcasts: listBroadcasts() }));

  app.get('/broadcasts/:id', async (req, reply) => {
    const { id } = req.params as { id: string };
    const broadcast = getBroadcast(id);
    if (!broadcast) return reply.code(404).send({ error: 'broadcast not found' });
    return broadcast;
  });

  // ===== PREFERENCES theo recipient =====

  app.get('/preferences/:recipient', async (req) => {
    const { recipient } = req.params as { recipient: string };
    return { recipient, preferences: listPreferences(recipient) };
  });

  // tắt/bật kênh cho 1 người nhận — worker sẽ chặn gửi khi disabled
  app.put('/preferences/:recipient', async (req, reply) => {
    const { recipient } = req.params as { recipient: string };
    const parsed = preferenceSchema.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: parsed.error.flatten() });
    setPreference(recipient, parsed.data.channel, parsed.data.enabled);
    return { recipient, ...parsed.data };
  });

  // ===== ONE-CLICK UNSUBSCRIBE (link trong nội dung notification) =====

  // GET có side-effect — đây là chuẩn của link unsubscribe trong email (RFC 8058 một-click)
  // và link này mở trực tiếp trên trình duyệt nên không thể yêu cầu header API key.
  // An toàn: token tự ký HMAC (không forge được) và chỉ tắt kênh của đúng recipient trong token.
  app.get('/unsubscribe', async (req, reply) => {
    const { token } = req.query as { token?: string };
    const payload = token ? verifyUnsubscribeToken(token) : null;
    if (!payload) {
      return reply.code(400).type('text/html; charset=utf-8').send(unsubscribePage(
        'Liên kết không hợp lệ hoặc đã hết hạn',
        'Token sai, bị sửa hoặc quá hạn dùng (365 ngày). Vui lòng liên hệ người gửi nếu bạn vẫn muốn hủy nhận tin.',
        false,
      ));
    }
    // topic → hủy đăng ký khỏi topic; không → tắt cả kênh (preference)
    let scope: boolean;
    if (payload.topic) {
      scope = unsubscribeTopic(payload.topic, payload.recipient, payload.channel);
    } else {
      const wasEnabled = getPreference(payload.recipient, payload.channel)?.enabled ?? true;
      setPreference(payload.recipient, payload.channel, false);
      scope = wasEnabled;
    }
    const what = payload.topic ? `topic "${payload.topic}"` : `kênh ${payload.channel}`;
    return reply.type('text/html; charset=utf-8').send(unsubscribePage(
      scope ? 'Đã hủy nhận tin thành công' : 'Bạn đã hủy nhận tin từ trước',
      `${payload.recipient} sẽ không còn nhận thông báo qua ${what}${payload.topic ? ' của topic này' : ''}.`,
    ));
  });
}

/** Trang HTML tối giản trả về khi bấm link unsubscribe — không thuộc dashboard SPA */
function unsubscribePage(title: string, message: string, ok = true): string {
  return `<!doctype html>
<html lang="vi">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${title}</title>
<style>
  body { margin: 0; min-height: 100dvh; display: grid; place-items: center;
         background: #0f172a; color: #e2e8f0; font-family: system-ui, sans-serif; }
  .card { max-width: 26rem; margin: 1rem; padding: 2rem; text-align: center;
          border: 1px solid #1e293b; border-radius: 16px; background: #16223a; }
  .icon { font-size: 2.2rem; }
  h1 { font-size: 1.15rem; margin: 0.75rem 0 0.5rem; color: ${ok ? '#22c55e' : '#f59e0b'}; }
  p { font-size: 0.9rem; line-height: 1.55; color: #94a3b8; margin: 0; }
</style>
</head>
<body>
  <main class="card" role="status">
    <div class="icon" aria-hidden="true">${ok ? '✅' : '⚠️'}</div>
    <h1>${title}</h1>
    <p>${message}</p>
  </main>
</body>
</html>`;
}
