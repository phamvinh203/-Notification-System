import Fastify, { type FastifyInstance } from 'fastify';
import fastifyStatic from '@fastify/static';
import { createBullBoard } from '@bull-board/api';
import { BullMQAdapter } from '@bull-board/api/bullMQAdapter';
import { FastifyAdapter } from '@bull-board/fastify';
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { registerRoutes } from './api/routes.js';
import { notificationQueue } from './queue/queue.js';
import { registry, updateMetrics } from './metrics.js';
import { config } from './config.js';

export interface BuildAppOptions {
  /** Set = bắt buộc key (x-api-key hoặc Authorization: Bearer) cho thao tác ghi + /admin/queues. null/undefined = tắt auth (dev local). */
  apiKey?: string | null;
  logger?: boolean;
}

export async function buildApp(opts: BuildAppOptions = {}): Promise<FastifyInstance> {
  const app = Fastify({ logger: opts.logger ?? true });

  // health check — luôn mở, không cần key (dùng cho docker healthcheck)
  app.get('/health', async () => ({ ok: true }));

  // Prometheus metrics — cùng chính sách auth như /notifications*
  app.get('/metrics', async (_req, reply) => {
    await updateMetrics();
    return reply.type(registry.contentType).send(await registry.metrics());
  });

  // API key auth: preHandler chạy cho mọi route đăng ký sau nó, kể cả route của Bull Board plugin.
  // Chính sách reads-open: GET đọc mở (browser/dashboard), thao tác ghi + /admin/queues cần key.
  // Nhận cả x-api-key header lẫn Authorization: Bearer (Prometheus scrape dùng Bearer).
  app.addHook('preHandler', async (req, reply) => {
    const apiKey = opts.apiKey;
    if (!apiKey) return;
    const path = (req.url ?? '').split('?')[0];
    if (path === '/health') return;
    const isProtected = path.startsWith('/admin/queues') ||
      ((path.startsWith('/notifications') || path === '/metrics') && req.method !== 'GET');
    if (!isProtected) return;
    const authHeader = req.headers.authorization;
    const bearer = authHeader?.startsWith('Bearer ') ? authHeader.slice('Bearer '.length) : undefined;
    const provided = (req.headers['x-api-key'] as string | undefined) ?? bearer;
    if (provided !== apiKey) {
      return reply.code(401).send({ error: 'thiếu hoặc sai header x-api-key' });
    }
  });

  await app.register(registerRoutes);

  const boardAdapter = new FastifyAdapter();
  boardAdapter.setBasePath('/admin/queues');
  createBullBoard({ queues: [new BullMQAdapter(notificationQueue)], serverAdapter: boardAdapter });
  await app.register(boardAdapter.registerPlugin(), { prefix: '/admin/queues' });

  // Serve dashboard build (nếu có) — production chạy 1 container: UI + API cùng origin.
  // SPA fallback theo Accept header: browser navigate (Accept: text/html) tới bất kỳ route nào
  // của UI đều nhận index.html; fetch/curl/Prometheus (Accept khác) đi thẳng API.
  const distDir = config.dashboardDist ?? join(dirname(fileURLToPath(import.meta.url)), '..', 'dashboard', 'dist');
  if (existsSync(join(distDir, 'index.html'))) {
    const indexHtml = await readFile(join(distDir, 'index.html'), 'utf8');
    await app.register(fastifyStatic, { root: distDir, wildcard: false });
    app.addHook('onRequest', async (req, reply) => {
      if (req.method !== 'GET' && req.method !== 'HEAD') return;
      const accept = req.headers.accept ?? '';
      if (!accept.includes('text/html')) return;
      const path = (req.url ?? '').split('?')[0];
      // Bull Board và /metrics phục vụ UI/text riêng, không nhảy vào SPA
      if (path === '/health' || path === '/metrics' || path.startsWith('/admin/queues')) return;
      return reply.type('text/html; charset=utf-8').send(indexHtml);
    });
  }

  return app;
}
