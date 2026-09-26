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
