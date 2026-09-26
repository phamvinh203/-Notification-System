import type { Channel, Status } from '../api';

const STATUS_META: Record<Status, { label: string; cls: string; dot: string }> = {
  sent: { label: 'Đã gửi', cls: 'border-accent/30 bg-accent/10 text-accent', dot: 'bg-accent' },
  failed: { label: 'Thất bại', cls: 'border-danger/30 bg-danger/10 text-danger', dot: 'bg-danger' },
  processing: { label: 'Đang gửi', cls: 'border-info/30 bg-info/10 text-info', dot: 'bg-info' },
  queued: { label: 'Trong hàng đợi', cls: 'border-line bg-muted text-fg', dot: 'bg-muted-fg' },
  scheduled: { label: 'Hẹn giờ', cls: 'border-warning/30 bg-warning/10 text-warning', dot: 'bg-warning' },
  cancelled: { label: 'Đã hủy', cls: 'border-line bg-muted text-muted-fg', dot: 'bg-muted-fg' },
  recurring: { label: 'Lịch lặp', cls: 'border-info/30 bg-info/10 text-info', dot: 'bg-info' },
  blocked: { label: 'Bị chặn', cls: 'border-warning/30 bg-warning/10 text-warning', dot: 'bg-warning' },
};

export function StatusBadge({ status }: { status: Status }) {
  const meta = STATUS_META[status] ?? STATUS_META.queued;
  return (
    <span
      className={`inline-flex items-center gap-1.5 rounded-full border px-2.5 py-0.5 text-xs font-medium whitespace-nowrap ${meta.cls}`}
    >
      <span aria-hidden="true" className={`h-1.5 w-1.5 rounded-full ${meta.dot}`} />
      {meta.label}
    </span>
  );
}

const CHANNEL_META: Record<Channel, { label: string }> = {
  email: { label: 'Email' },
  sms: { label: 'SMS' },
  push: { label: 'Push' },
  webhook: { label: 'Webhook' },
};

export function ChannelBadge({ channel }: { channel: Channel }) {
  return (
    <span className="inline-flex items-center gap-1 rounded-md bg-muted px-2 py-0.5 font-mono text-xs text-fg">
      {CHANNEL_META[channel]?.label ?? channel}
    </span>
  );
}
