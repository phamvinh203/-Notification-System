import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { ArrowsClockwise, Megaphone, PlusCircle, Prohibit } from '@phosphor-icons/react';
import { api, type Broadcast } from '../api';
import { Alert, SkeletonRows } from '../components/ui';
import { timeAgo } from '../utils';

/** Thanh tiến độ gửi: sent / created, phần failed tô đỏ, pending còn trống */
function Progress({ b }: { b: Broadcast }) {
  const pct = (n: number) => (b.created > 0 ? (n / b.created) * 100 : 0);
  return (
    <div className="min-w-40">
      <div
        className="flex h-2 w-full overflow-hidden rounded-full bg-muted"
        role="progressbar"
        aria-valuenow={b.sent}
        aria-valuemin={0}
        aria-valuemax={Math.max(b.created, 1)}
        aria-label={`Đã gửi ${b.sent}/${b.created}`}
      >
        <span className="bg-accent" style={{ width: `${pct(b.sent)}%` }} />
        <span className="bg-danger" style={{ width: `${pct(b.failed)}%` }} />
      </div>
      <p className="tabular mt-1 text-xs text-muted-fg">
        {b.sent}/{b.created} đã gửi
        {b.failed > 0 && <span className="text-danger"> · {b.failed} lỗi</span>}
        {b.pending > 0 && <span> · {b.pending} đang chờ</span>}
      </p>
    </div>
  );
}

const BROADCAST_STATUS: Record<string, { label: string; cls: string }> = {
  pending: { label: 'Đang fan-out', cls: 'border-info/30 bg-info/10 text-info' },
  dispatched: { label: 'Đã fan-out', cls: 'border-line bg-muted text-muted-fg' },
};

export default function BroadcastsPage() {
  const [items, setItems] = useState<Broadcast[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [autoRefresh, setAutoRefresh] = useState(true);

  const load = useCallback(async () => {
    try {
      const res = await api.broadcasts();
      setItems(res.broadcasts);
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Không tải được danh sách broadcast');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    setLoading(true);
    load();
  }, [load]);

  useEffect(() => {
    if (!autoRefresh) return;
    const t = setInterval(() => void load(), 5000);
    return () => clearInterval(t);
  }, [autoRefresh, load]);

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-3">
        <div>
          <h1 className="text-xl font-semibold">Broadcasts</h1>
          <p className="text-sm text-muted-fg">1 request → fan-out tới mọi subscriber của topic (chạy trong worker)</p>
        </div>
        <Link
          to="/audience"
          className="ml-auto inline-flex h-10 cursor-pointer items-center gap-2 rounded-lg bg-accent px-4 text-sm font-semibold text-accent-fg hover:opacity-90"
        >
          <PlusCircle size={17} weight="bold" aria-hidden="true" />
          Gửi broadcast
        </Link>
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <label className="flex cursor-pointer items-center gap-2 text-sm text-muted-fg">
          <input
            type="checkbox"
            checked={autoRefresh}
            onChange={(e) => setAutoRefresh(e.target.checked)}
            className="h-4 w-4 accent-[var(--accent)]"
          />
          Tự động làm mới (5s)
        </label>
        <button
          type="button"
          onClick={() => void load()}
          className="ml-auto inline-flex h-10 cursor-pointer items-center gap-2 rounded-lg border border-line bg-card px-3 text-sm font-medium hover:bg-muted"
        >
          <ArrowsClockwise size={15} aria-hidden="true" />
          Làm mới
        </button>
      </div>

      {error && <Alert variant="error">{error}</Alert>}

      <div className="overflow-x-auto rounded-xl border border-line bg-card">
        <table className="w-full min-w-[720px] text-left text-sm">
          <caption className="sr-only">Danh sách broadcast</caption>
          <thead>
            <tr className="border-b border-line text-xs text-muted-fg uppercase">
              <th scope="col" className="px-3 py-2.5 font-medium">Thời điểm</th>
              <th scope="col" className="px-3 py-2.5 font-medium">Topic</th>
              <th scope="col" className="px-3 py-2.5 font-medium">Nội dung</th>
              <th scope="col" className="px-3 py-2.5 font-medium">Trạng thái</th>
              <th scope="col" className="px-3 py-2.5 font-medium">Tiến độ</th>
              <th scope="col" className="px-3 py-2.5 font-medium text-right">Hành động</th>
            </tr>
          </thead>
          <tbody>
            {loading ? (
              <SkeletonRows rows={5} cols={6} />
            ) : items.length === 0 ? (
              <tr>
                <td colSpan={6} className="px-3 py-14 text-center">
                  <Prohibit aria-hidden="true" size={28} className="mx-auto text-muted-fg" />
                  <p className="mt-2 text-sm text-muted-fg">Chưa có broadcast nào.</p>
                  <Link to="/audience" className="mt-3 inline-block text-sm font-medium text-info underline underline-offset-2">
                    Đăng ký subscriber rồi gửi thử
                  </Link>
                </td>
              </tr>
            ) : (
              items.map((b) => {
                const st = BROADCAST_STATUS[b.status] ?? { label: b.status, cls: 'border-line bg-muted text-muted-fg' };
                return (
                  <tr key={b.id} className="border-t border-line first:border-t-0 hover:bg-muted/40">
                    <td className="px-3 py-2.5 whitespace-nowrap">
                      <time dateTime={b.created_at} className="tabular text-xs text-muted-fg">
                        {timeAgo(b.created_at)}
                      </time>
                    </td>
                    <td className="px-3 py-2.5">
                      <span className="inline-flex items-center gap-1 rounded-md bg-muted px-2 py-0.5 font-mono text-xs text-fg">
                        <Megaphone size={11} aria-hidden="true" />
                        {b.topic}
                      </span>
                    </td>
                    <td className="max-w-56 truncate px-3 py-2.5" title={b.subject ?? b.body}>
                      {b.subject ?? b.body}
                    </td>
                    <td className="px-3 py-2.5">
                      <span className={`inline-flex items-center gap-1.5 rounded-full border px-2.5 py-0.5 text-xs font-medium whitespace-nowrap ${st.cls}`}>
                        {st.label}
                      </span>
                    </td>
                    <td className="px-3 py-2.5"><Progress b={b} /></td>
                    <td className="px-3 py-2.5 text-right">
                      <Link
                        to={`/broadcasts/${b.id}`}
                        className="inline-flex h-8 cursor-pointer items-center rounded-md border border-line px-2.5 text-xs font-medium hover:bg-muted"
                      >
                        Chi tiết
                      </Link>
                    </td>
                  </tr>
                );
              })
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
