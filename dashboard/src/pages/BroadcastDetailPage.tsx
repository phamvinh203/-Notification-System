import { useCallback, useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { ArrowLeft, ArrowsClockwise } from '@phosphor-icons/react';
import { api, type Broadcast, type NotificationRow, type Status } from '../api';
import { ChannelBadge, StatusBadge } from '../components/badges';
import { Alert } from '../components/ui';
import { fmtDateTime, timeAgo } from '../utils';

function Progress({ b }: { b: Broadcast }) {
  const pct = (n: number) => (b.created > 0 ? (n / b.created) * 100 : 0);
  return (
    <div className="max-w-md">
      <div
        className="flex h-2.5 w-full overflow-hidden rounded-full bg-muted"
        role="progressbar"
        aria-valuenow={b.sent}
        aria-valuemin={0}
        aria-valuemax={Math.max(b.created, 1)}
        aria-label={`Đã gửi ${b.sent}/${b.created}`}
      >
        <span className="bg-accent" style={{ width: `${pct(b.sent)}%` }} />
        <span className="bg-danger" style={{ width: `${pct(b.failed)}%` }} />
      </div>
      <div className="tabular mt-2 flex gap-4 text-xs text-muted-fg">
        <span><strong className="text-fg">{b.created}</strong> đã tạo</span>
        <span><strong className="text-accent">{b.sent}</strong> đã gửi</span>
        <span><strong className={b.failed > 0 ? 'text-danger' : 'text-fg'}>{b.failed}</strong> lỗi</span>
        <span><strong className="text-fg">{b.pending}</strong> đang chờ</span>
      </div>
    </div>
  );
}

export default function BroadcastDetailPage() {
  const { id } = useParams<{ id: string }>();
  const [b, setB] = useState<Broadcast | null>(null);
  const [items, setItems] = useState<NotificationRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [autoRefresh, setAutoRefresh] = useState(true);

  const load = useCallback(async () => {
    if (!id) return;
    try {
      const broadcast = await api.broadcast(id);
      setB(broadcast);
      const list = await api.list({ broadcast: id, limit: 100, offset: 0 });
      setItems(list.items);
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Không tải được broadcast');
    } finally {
      setLoading(false);
    }
  }, [id]);

  useEffect(() => {
    setLoading(true);
    load();
  }, [load]);

  // poll 3s khi broadcast còn đang chạy (chưa dispatched hoặc còn notification pending)
  const inFlight = !b || b.status !== 'dispatched' || b.pending > 0;
  useEffect(() => {
    if (!autoRefresh || !inFlight) return;
    const t = setInterval(() => void load(), 3000);
    return () => clearInterval(t);
  }, [autoRefresh, inFlight, load]);

  if (error) {
    return (
      <div className="space-y-4">
        <Link to="/broadcasts" className="inline-flex items-center gap-1.5 text-sm text-info underline underline-offset-2">
          <ArrowLeft size={14} aria-hidden="true" /> Về danh sách broadcast
        </Link>
        <Alert variant="error">{error}</Alert>
      </div>
    );
  }

  if (loading || !b) {
    return <p className="py-20 text-center text-sm text-muted-fg">Đang tải…</p>;
  }

  return (
    <div className="space-y-4">
      <Link to="/broadcasts" className="inline-flex items-center gap-1.5 text-sm text-info underline underline-offset-2">
        <ArrowLeft size={14} aria-hidden="true" /> Danh sách broadcast
      </Link>

      <div className="flex flex-wrap items-center gap-3">
        <div>
          <h1 className="text-xl font-semibold">Broadcast tới topic “{b.topic}”</h1>
          <p className="font-mono text-xs text-muted-fg">{b.id}</p>
        </div>
        <label className="ml-auto flex cursor-pointer items-center gap-2 text-sm text-muted-fg">
          <input
            type="checkbox"
            checked={autoRefresh}
            onChange={(e) => setAutoRefresh(e.target.checked)}
            className="h-4 w-4 accent-[var(--accent)]"
          />
          Tự động làm mới (3s, khi còn chạy)
        </label>
        <button
          type="button"
          onClick={() => void load()}
          className="inline-flex h-10 cursor-pointer items-center gap-2 rounded-lg border border-line bg-card px-3 text-sm font-medium hover:bg-muted"
        >
          <ArrowsClockwise size={15} aria-hidden="true" />
          Làm mới
        </button>
      </div>

      <section aria-label="Thông tin broadcast" className="space-y-3 rounded-xl border border-line bg-card p-4">
        <div className="grid gap-x-6 gap-y-2 sm:grid-cols-[160px_1fr]">
          <dt className="text-sm text-muted-fg">Thời điểm tạo</dt>
          <dd className="tabular text-sm">{fmtDateTime(b.created_at)} <span className="text-xs text-muted-fg">({timeAgo(b.created_at)})</span></dd>
          <dt className="text-sm text-muted-fg">Tiêu đề</dt>
          <dd className="text-sm">{b.subject ?? <span className="text-muted-fg">(không có)</span>}</dd>
          <dt className="text-sm text-muted-fg">Nội dung</dt>
          <dd className="text-sm">{b.body}</dd>
          <dt className="text-sm text-muted-fg">Trạng thái</dt>
          <dd className="text-sm">
            {b.status === 'dispatched' ? 'Đã fan-out trong worker' : 'Đang chờ worker fan-out…'}
          </dd>
        </div>
        <Progress b={b} />
      </section>

      <section aria-label="Danh sách notification của broadcast" className="overflow-x-auto rounded-xl border border-line bg-card">
        <table className="w-full min-w-[560px] text-left text-sm">
          <caption className="sr-only">Notification được fan-out từ broadcast này</caption>
          <thead>
            <tr className="border-b border-line text-xs text-muted-fg uppercase">
              <th scope="col" className="px-3 py-2.5 font-medium">Kênh</th>
              <th scope="col" className="px-3 py-2.5 font-medium">Người nhận</th>
              <th scope="col" className="px-3 py-2.5 font-medium">Trạng thái</th>
              <th scope="col" className="px-3 py-2.5 font-medium text-right">Hành động</th>
            </tr>
          </thead>
          <tbody>
            {items.length === 0 ? (
              <tr>
                <td colSpan={4} className="px-3 py-10 text-center text-sm text-muted-fg">
                  {b.status === 'pending'
                    ? 'Worker chưa fan-out — đợi vài giây rồi làm mới.'
                    : 'Không có notification nào (mọi subscriber đã tắt kênh này).'}
                </td>
              </tr>
            ) : (
              items.map((n) => (
                <tr key={n.id} className="border-t border-line first:border-t-0 hover:bg-muted/40">
                  <td className="px-3 py-2.5"><ChannelBadge channel={n.channel} /></td>
                  <td className="max-w-44 truncate px-3 py-2.5 font-mono text-xs" title={n.recipient}>{n.recipient}</td>
                  <td className="px-3 py-2.5"><StatusBadge status={n.status as Status} /></td>
                  <td className="px-3 py-2.5 text-right">
                    <Link
                      to={`/notifications/${n.id}`}
                      className="inline-flex h-8 cursor-pointer items-center rounded-md border border-line px-2.5 text-xs font-medium hover:bg-muted"
                    >
                      Chi tiết
                    </Link>
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </section>
    </div>
  );
}
