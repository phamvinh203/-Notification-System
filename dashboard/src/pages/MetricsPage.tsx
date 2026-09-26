import { useCallback, useEffect, useRef, useState } from 'react';
import { ArrowSquareOut, Pause, Play } from '@phosphor-icons/react';
import { api, apiBase } from '../api';
import { Alert } from '../components/ui';

// parse text exposition của Prometheus: name{labels} value | name value
function parseMetrics(text: string): Map<string, Array<{ labels: Record<string, string>; value: number }>> {
  const out = new Map<string, Array<{ labels: Record<string, string>; value: number }>>();
  for (const line of text.split('\n')) {
    if (!line || line.startsWith('#')) continue;
    const m = line.match(/^([a-zA-Z_][\w]*)(?:\{([^}]*)\})?\s+([0-9.eE+-]+|NaN)$/);
    if (!m) continue;
    const [, name, rawLabels, rawValue] = m;
    const labels: Record<string, string> = {};
    if (rawLabels) {
      for (const pair of rawLabels.matchAll(/(\w+)="([^"]*)"/g)) {
        labels[pair[1]] = pair[2];
      }
    }
    const value = Number(rawValue);
    if (!out.has(name)) out.set(name, []);
    out.get(name)!.push({ labels, value });
  }
  return out;
}

const STATUS_LABELS: Record<string, string> = {
  sent: 'Đã gửi',
  failed: 'Thất bại',
  processing: 'Đang gửi',
  queued: 'Hàng đợi',
  scheduled: 'Hẹn giờ',
  cancelled: 'Đã hủy',
};
const QUEUE_STATES = ['waiting', 'active', 'delayed', 'completed', 'failed'] as const;
const CHANNELS = ['email', 'sms', 'push', 'webhook'] as const;

function labelOf(map: Map<string, Array<{ labels: Record<string, string>; value: number }>>, name: string, labelKey: string, want: string): number {
  return map.get(name)?.find((s) => s.labels[labelKey] === want)?.value ?? 0;
}

function StatTile({ label, value, tone = 'default' }: { label: string; value: number; tone?: 'default' | 'accent' | 'danger' | 'info' | 'warning' }) {
  const toneCls = {
    default: 'text-fg',
    accent: 'text-accent',
    danger: 'text-danger',
    info: 'text-info',
    warning: 'text-warning',
  }[tone];
  return (
    <div className="rounded-xl border border-line bg-card px-4 py-3">
      <p className={`tabular font-mono text-2xl font-semibold ${toneCls}`}>{value}</p>
      <p className="mt-0.5 text-xs text-muted-fg">{label}</p>
    </div>
  );
}

function BarRow({ label, value, max }: { label: string; value: number; max: number }) {
  const pct = max === 0 ? 0 : Math.round((value / max) * 100);
  return (
    <div className="flex items-center gap-3">
      <span className="w-24 shrink-0 text-xs text-muted-fg">{label}</span>
      <div
        role="meter"
        aria-valuenow={value}
        aria-valuemin={0}
        aria-valuemax={max}
        aria-label={`${label}: ${value}`}
        className="h-2.5 flex-1 overflow-hidden rounded-full bg-muted"
      >
        <div className="h-full rounded-full bg-accent transition-[width] duration-300" style={{ width: `${pct}%` }} />
      </div>
      <span className="tabular w-10 shrink-0 text-right font-mono text-sm">{value}</span>
    </div>
  );
}

export default function MetricsPage() {
  const [data, setData] = useState<Map<string, Array<{ labels: Record<string, string>; value: number }>> | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [paused, setPaused] = useState(false);
  const [updatedAt, setUpdatedAt] = useState<Date | null>(null);
  const timer = useRef<ReturnType<typeof setInterval> | null>(null);

  const load = useCallback(async () => {
    try {
      const text = await api.metrics();
      setData(parseMetrics(text));
      setUpdatedAt(new Date());
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Không tải được metrics');
    }
  }, []);

  useEffect(() => {
    if (paused) {
      if (timer.current) clearInterval(timer.current);
      return;
    }
    load();
    timer.current = setInterval(load, 3000);
    return () => {
      if (timer.current) clearInterval(timer.current);
    };
  }, [paused, load]);

  const channelMax = Math.max(
    1,
    ...(data ? CHANNELS.map((c) => labelOf(data, 'notifications_by_channel', 'channel', c)) : [1]),
  );
  const stale = updatedAt !== null && Date.now() - updatedAt.getTime() > 10_000;

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center gap-3">
        <div>
          <h1 className="text-xl font-semibold">Tổng quan</h1>
          <p className="text-sm text-muted-fg">Số liệu realtime từ /metrics của hệ thống</p>
        </div>
        <div className="ml-auto flex items-center gap-2">
          <span aria-live="polite" className={`text-xs ${stale ? 'text-warning' : 'text-muted-fg'}`}>
            {paused
              ? 'Tạm dừng — bấm play để cập nhật tiếp'
              : updatedAt
                ? `Cập nhật lúc ${updatedAt.toLocaleTimeString('vi-VN', { hour12: false })}${stale ? ' (cũ)' : ''}`
                : 'Đang tải…'}
          </span>
          <button
            type="button"
            onClick={() => setPaused(!paused)}
            aria-label={paused ? 'Tiếp tục cập nhật realtime' : 'Tạm dừng cập nhật realtime'}
            className="flex h-9 w-9 cursor-pointer items-center justify-center rounded-lg border border-line bg-card text-muted-fg hover:text-fg"
          >
            {paused ? <Play size={15} aria-hidden="true" /> : <Pause size={15} aria-hidden="true" />}
          </button>
        </div>
      </div>

      {error && <Alert variant="error">{error}</Alert>}

      {data && (
        <>
          <section aria-labelledby="h-status">
            <h2 id="h-status" className="mb-2 text-sm font-semibold text-muted-fg uppercase">Notifications theo trạng thái</h2>
            <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">
              <StatTile label={STATUS_LABELS.sent} value={labelOf(data, 'notifications_by_status', 'status', 'sent')} tone="accent" />
              <StatTile label={STATUS_LABELS.failed} value={labelOf(data, 'notifications_by_status', 'status', 'failed')} tone="danger" />
              <StatTile label={STATUS_LABELS.processing} value={labelOf(data, 'notifications_by_status', 'status', 'processing')} tone="info" />
              <StatTile label={STATUS_LABELS.queued} value={labelOf(data, 'notifications_by_status', 'status', 'queued')} />
              <StatTile label={STATUS_LABELS.scheduled} value={labelOf(data, 'notifications_by_status', 'status', 'scheduled')} tone="warning" />
              <StatTile label={STATUS_LABELS.cancelled} value={labelOf(data, 'notifications_by_status', 'status', 'cancelled')} />
            </div>
          </section>

          <section aria-labelledby="h-queue">
            <h2 id="h-queue" className="mb-2 text-sm font-semibold text-muted-fg uppercase">Queue BullMQ</h2>
            <div className="grid grid-cols-2 gap-3 sm:grid-cols-5">
              {QUEUE_STATES.map((state) => (
                <StatTile key={state} label={`jobs ${state}`} value={labelOf(data, 'bullmq_jobs', 'state', state)} />
              ))}
            </div>
            <p className="mt-2 flex items-center gap-1 text-xs text-muted-fg">
              Outbox chưa dispatch: <strong className="tabular font-mono">{data.get('outbox_pending')?.[0]?.value ?? 0}</strong>
            </p>
          </section>

          <section aria-labelledby="h-channel" className="rounded-xl border border-line bg-card p-4">
            <h2 id="h-channel" className="mb-3 text-sm font-semibold text-muted-fg uppercase">Theo kênh</h2>
            <div className="space-y-2.5">
              {CHANNELS.map((c) => (
                <BarRow key={c} label={c} value={labelOf(data, 'notifications_by_channel', 'channel', c)} max={channelMax} />
              ))}
            </div>
          </section>
        </>
      )}

      <p className="text-xs text-muted-fg">
        Dữ liệu thô: <a className="inline-flex items-center gap-1 text-info underline underline-offset-2" href={`${apiBase}/metrics`} target="_blank" rel="noreferrer">/metrics <ArrowSquareOut size={12} aria-hidden="true" /></a>
      </p>
    </div>
  );
}
