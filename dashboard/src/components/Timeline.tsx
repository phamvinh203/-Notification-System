import { useEffect, useRef } from 'react';
import {
  ArrowClockwise,
  ArrowCounterClockwise,
  CheckCircle,
  Gear,
  PaperPlaneRight,
  Prohibit,
  XCircle,
} from '@phosphor-icons/react';
import type { DeliveryEvent } from '../api';

const EVENT_META: Record<string, { label: string; icon: typeof Gear; cls: string }> = {
  enqueued: { label: 'Vào hàng đợi', icon: PaperPlaneRight, cls: 'text-muted-fg' },
  processing: { label: 'Đang xử lý', icon: Gear, cls: 'text-info' },
  retry_scheduled: { label: 'Hẹn thử lại', icon: ArrowClockwise, cls: 'text-warning' },
  sent: { label: 'Đã gửi', icon: CheckCircle, cls: 'text-accent' },
  dead: { label: 'Hết lượt thử (dead)', icon: XCircle, cls: 'text-danger' },
  cancelled: { label: 'Đã hủy', icon: Prohibit, cls: 'text-muted-fg' },
  replayed: { label: 'Đẩy lại từ dead', icon: ArrowCounterClockwise, cls: 'text-info' },
  skipped_cancelled: { label: 'Bỏ qua — đã bị hủy', icon: Prohibit, cls: 'text-muted-fg' },
};

function fmtTime(iso: string): string {
  return new Date(iso).toLocaleString('vi-VN', { hour12: false });
}

export function Timeline({ events }: { events: DeliveryEvent[] }) {
  const lastRef = useRef<HTMLLIElement>(null);

  // mỗi khi có event mới (timeline chạy live), nhấc mắt người dùng tới mốc cuối
  useEffect(() => {
    lastRef.current?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  }, [events.length]);

  if (events.length === 0) {
    return <p className="text-sm text-muted-fg">Chưa có delivery event nào.</p>;
  }

  return (
    <ol className="relative space-y-0" aria-label="Timeline delivery events">
      {events.map((e, i) => {
        const meta = EVENT_META[e.event] ?? { label: e.event, icon: Gear, cls: 'text-muted-fg' };
        const Icon = meta.icon;
        const isLast = i === events.length - 1;
        return (
          <li
            key={e.id}
            ref={isLast ? lastRef : undefined}
            className="relative flex gap-3 pb-5 last:pb-0"
          >
            {/* đường nối */}
            {!isLast && <span aria-hidden="true" className="absolute top-7 left-[13px] h-full w-px bg-line" />}
            <span className={`relative z-10 mt-0.5 shrink-0 rounded-full border border-line bg-card p-1.5 ${meta.cls}`}>
              <Icon size={16} weight="bold" aria-hidden="true" />
            </span>
            <div className="min-w-0">
              <p className={`text-sm font-medium ${isLast ? 'text-fg' : 'text-fg/80'}`}>{meta.label}</p>
              {e.detail && (
                <p className="mt-0.5 text-xs break-words text-muted-fg" style={{ overflowWrap: 'anywhere' }}>
                  {e.detail}
                </p>
              )}
              <time className="tabular mt-0.5 block font-mono text-[11px] text-muted-fg" dateTime={e.created_at}>
                {fmtTime(e.created_at)}
              </time>
            </div>
          </li>
        );
      })}
    </ol>
  );
}
