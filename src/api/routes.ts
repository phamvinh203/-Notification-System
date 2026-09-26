import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { enqueueNotification, notificationQueue } from '../queue/queue.js';
import { countNotifications, getNotification, listNotifications, recordEvent, setStatus } from '../db.js';

const createSchema = z.object({
  channel: z.enum(['email', 'push', 'sms']),
  recipient: z.string().min(1),
  subject: z.string().optional(),
  body: z.string().min(1),
  sendAt: z.string().datetime().optional(),
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
    const result = await enqueueNotification(parsed.data);
    return reply.code(202).send(result);
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
}
