import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { enqueueNotification, notificationQueue, replayNotification, type PriorityName } from '../queue/queue.js';
import { countNotifications, countRecentByRecipient, findByIdempotencyKey, getNotification, listNotifications, recordEvent, setStatus } from '../db.js';
import { listTemplates, renderTemplate } from '../templates.js';
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
  limit: z.coerce.number().int().min(1).max(100).default(20),
  offset: z.coerce.number().int().min(0).default(0),
});

export async function registerRoutes(app: FastifyInstance): Promise<void> {
  app.post('/notifications', async (req, reply) => {
    const parsed = createSchema.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: parsed.error.flatten() });
    }
    const data = parsed.data;

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

    // template → render thành body tại thời điểm enqueue (job chỉ mang body thuần)
    let body: string | null | undefined = data.body;
    if (data.template) {
      body = renderTemplate(data.template, data.params);
      if (body === null) {
        return reply.code(400).send({ error: `template "${data.template}" không tồn tại` });
      }
    }

    const result = await enqueueNotification({
      channel: data.channel,
      recipient: data.recipient,
      subject: data.subject,
      body: body!,
      sendAt: data.sendAt,
      idempotencyKey,
      priority: data.priority as PriorityName | undefined,
    });
    return reply.code(result.deduplicated ? 200 : 202).send(result);
  });

  app.get('/notifications', async (req, reply) => {
    const parsed = listQuerySchema.safeParse(req.query);
    if (!parsed.success) {
      return reply.code(400).send({ error: parsed.error.flatten() });
    }
    const { status, channel, limit, offset } = parsed.data;
    const filter = { status, channel };
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
    if (row.notification.status !== 'scheduled') {
      return reply.code(409).send({ error: `chỉ hủy được notification ở trạng thái scheduled (hiện: ${row.notification.status})` });
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
}
