// dev (vite): '/api' qua proxy; build same-origin (Fastify serve dist): '' — gọi thẳng gốc
const BASE = import.meta.env.VITE_API_BASE ?? (import.meta.env.DEV ? '/api' : '');
export const apiBase = BASE;

export type Channel = 'email' | 'push' | 'sms' | 'webhook';
export type Status =
  | 'scheduled' | 'queued' | 'processing' | 'sent' | 'failed' | 'cancelled'
  // recurring: lịch lặp cron (row là lịch); blocked: worker bỏ gửi do preference tắt kênh
  | 'recurring' | 'blocked';

export interface NotificationRow {
  id: string;
  channel: Channel;
  recipient: string;
  subject: string | null;
  body: string;
  status: Status;
  scheduled_at: string | null;
  created_at: string;
  broadcast_id: string | null;
  recurrence: string | null;
}

export interface DeliveryEvent {
  id: number;
  notification_id: string;
  event: string;
  detail: string | null;
  created_at: string;
}

export interface ListResponse {
  items: NotificationRow[];
  total: number;
  limit: number;
  offset: number;
}

export interface Broadcast {
  id: string;
  topic: string;
  subject: string | null;
  body: string;
  status: string; // pending → dispatched
  total: number;
  created_at: string;
  created: number;
  sent: number;
  failed: number;
  pending: number;
}

export interface TopicInfo {
  topic: string;
  subscribers: number;
}

export interface Subscriber {
  recipient: string;
  channel: Channel;
}

export interface PreferenceRow {
  channel: Channel;
  enabled: boolean;
  updated_at: string;
}

export class ApiError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

function keyHeader(): Record<string, string> {
  const key = localStorage.getItem('apiKey');
  return key ? { 'x-api-key': key } : {};
}

async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  const res = await fetch(`${BASE}${path}`, {
    ...init,
    headers: {
      ...(init.body ? { 'content-type': 'application/json' } : {}),
      ...keyHeader(),
      ...init.headers,
    },
  });
  if (!res.ok) {
    let message = `Lỗi ${res.status}`;
    try {
      const body = (await res.json()) as { error?: unknown };
      if (body.error) message = typeof body.error === 'string' ? body.error : JSON.stringify(body.error);
    } catch {
      /* giữ message mặc định */
    }
    throw new ApiError(res.status, message);
  }
  return res.json() as Promise<T>;
}

export const api = {
  list: (params: { status?: string; channel?: string; broadcast?: string; limit: number; offset: number }) => {
    const q = new URLSearchParams(
      Object.entries(params).filter(([, v]) => v !== '' && v !== undefined) as [string, string][],
    ).toString();
    return request<ListResponse>(`/notifications?${q}`);
  },
  detail: (id: string) =>
    request<{ notification: NotificationRow; events: DeliveryEvent[] }>(`/notifications/${id}`),
  create: (payload: Record<string, unknown>, idempotencyKey?: string) =>
    request<{ id: string; status: string; deduplicated?: true }>('/notifications', {
      method: 'POST',
      headers: idempotencyKey ? { 'idempotency-key': idempotencyKey } : {},
      body: JSON.stringify(payload),
    }),
  cancel: (id: string) => request<{ id: string; status: string }>(`/notifications/${id}`, { method: 'DELETE' }),
  replay: (id: string) =>
    request<{ id: string; status: string }>(`/notifications/${id}/replay`, { method: 'POST' }),
  templates: () => request<{ templates: string[] }>('/templates'),
  // ===== topics + broadcast =====
  topics: () => request<{ topics: TopicInfo[] }>('/topics'),
  subscribers: (topic: string) =>
    request<{ topic: string; subscribers: Subscriber[] }>(`/topics/${encodeURIComponent(topic)}/subscribers`),
  subscribe: (topic: string, recipient: string, channel: Channel) =>
    request<{ topic: string; recipient: string; channel: Channel; created: boolean }>(
      `/topics/${encodeURIComponent(topic)}/subscribers`,
      { method: 'POST', body: JSON.stringify({ recipient, channel }) },
    ),
  unsubscribe: (topic: string, recipient: string, channel: Channel) =>
    request<{ topic: string; recipient: string; channel: Channel; removed: boolean }>(
      `/topics/${encodeURIComponent(topic)}/subscribers`,
      { method: 'DELETE', body: JSON.stringify({ recipient, channel }) },
    ),
  sendBroadcast: (topic: string, payload: { subject?: string; body?: string; template?: string; params?: Record<string, unknown> }) =>
    request<{ broadcastId: string; topic: string; subscribers: number }>(`/topics/${encodeURIComponent(topic)}/send`, {
      method: 'POST',
      body: JSON.stringify(payload),
    }),
  broadcasts: () => request<{ broadcasts: Broadcast[] }>('/broadcasts'),
  broadcast: (id: string) => request<Broadcast>(`/broadcasts/${id}`),
  // ===== preferences =====
  preferences: (recipient: string) =>
    request<{ recipient: string; preferences: PreferenceRow[] }>(`/preferences/${encodeURIComponent(recipient)}`),
  setPreference: (recipient: string, channel: Channel, enabled: boolean) =>
    request<{ recipient: string; channel: Channel; enabled: boolean }>(
      `/preferences/${encodeURIComponent(recipient)}`,
      { method: 'PUT', body: JSON.stringify({ channel, enabled }) },
    ),
  // /metrics trả Prometheus text — KHÔNG phải JSON, phải đọc raw text
  metrics: async () => {
    const res = await fetch(`${BASE}/metrics`);
    if (!res.ok) throw new ApiError(res.status, `Lỗi ${res.status}`);
    return res.text();
  },
};
