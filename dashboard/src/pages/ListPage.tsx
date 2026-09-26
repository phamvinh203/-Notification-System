import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { ArrowsClockwise, PlusCircle, Prohibit } from '@phosphor-icons/react';
import { api, ApiError, type NotificationRow, type Status } from '../api';
import { ChannelBadge, StatusBadge } from '../components/badges';
import { Alert, Pagination, SkeletonRows } from '../components/ui';
import { ConfirmDialog } from '../components/ConfirmDialog';
import { fmtDateTime, timeAgo } from '../utils';

const STATUS_OPTIONS: Array<{ value: string; label: string }> = [
  { value: '', label: 'Mọi trạng thái' },
  { value: 'scheduled', label: 'Hẹn giờ' },
  { value: 'recurring', label: 'Lịch lặp' },
  { value: 'queued', label: 'Hàng đợi' },
  { value: 'processing', label: 'Đang gửi' },
  { value: 'sent', label: 'Đã gửi' },
  { value: 'failed', label: 'Thất bại' },
  { value: 'blocked', label: 'Bị chặn' },
  { value: 'cancelled', label: 'Đã hủy' },
];
const CHANNEL_OPTIONS = ['', 'email', 'sms', 'push', 'webhook'];
const LIMIT_OPTIONS = [10, 20, 50, 100];

export default function ListPage() {
  const [items, setItems] = useState<NotificationRow[]>([]);
  const [total, setTotal] = useState(0);
  const [status, setStatus] = useState('');
  const [channel, setChannel] = useState('');
  const [limit, setLimit] = useState(20);
  const [offset, setOffset] = useState(0);
  const [autoRefresh, setAutoRefresh] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [flash, setFlash] = useState<string | null>(null);

  const [cancelTarget, setCancelTarget] = useState<NotificationRow | null>(null);
  const [cancelling, setCancelling] = useState(false);
  const [replayingId, setReplayingId] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const res = await api.list({ status, channel, limit, offset });
      setItems(res.items);
      setTotal(res.total);
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Không tải được danh sách');
    } finally {
      setLoading(false);
    }
  }, [status, channel, limit, offset]);

  useEffect(() => {
    setLoading(true);
    load();
  }, [load]);

  useEffect(() => {
    if (!autoRefresh) return;
    const t = setInterval(() => void load(), 5000);
    return () => clearInterval(t);
  }, [autoRefresh, load]);

  const requestCancel = async () => {
    if (!cancelTarget) return;
    setCancelling(true);
    try {
      await api.cancel(cancelTarget.id);
      setFlash(`Đã hủy notification ${cancelTarget.id.slice(0, 8)}…`);
      setCancelTarget(null);
      await load();
    } catch (e) {
      const hint = e instanceof ApiError && e.status === 401 ? ' — kiểm tra API key ở thanh trên' : '';
      setError(`Hủy thất bại: ${e instanceof Error ? e.message : 'lỗi không rõ'}${hint}`);
    } finally {
      setCancelling(false);
    }
  };

  const requestReplay = async (row: NotificationRow) => {
    setReplayingId(row.id);
    setError(null);
    try {
      await api.replay(row.id);
      setFlash(`Đã đẩy lại job ${row.id.slice(0, 8)}… vào hàng đợi`);
      await load();
    } catch (e) {
      const hint = e instanceof ApiError && e.status === 401 ? ' — kiểm tra API key ở thanh trên' : '';
      setError(`Replay thất bại: ${e instanceof Error ? e.message : 'lỗi không rõ'}${hint}`);
    } finally {
      setReplayingId(null);
    }
  };

  const iconBtn =
    'cursor-pointer rounded-md p-1.5 text-muted-fg hover:bg-muted hover:text-fg disabled:cursor-not-allowed disabled:opacity-40';

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-3">
        <div>
          <h1 className="text-xl font-semibold">Thông báo</h1>
          <p className="text-sm text-muted-fg">Toàn bộ notification trong hệ thống</p>
        </div>
        <Link
          to="/create"
          className="ml-auto inline-flex h-10 cursor-pointer items-center gap-2 rounded-lg bg-accent px-4 text-sm font-semibold text-accent-fg hover:opacity-90"
        >
          <PlusCircle size={17} weight="bold" aria-hidden="true" />
          Tạo mới
        </Link>
      </div>

      {/* bộ lọc — state nằm trên URL để share/deep-link được */}
      <div className="flex flex-wrap items-center gap-2">
        <select
          aria-label="Lọc theo trạng thái"
          value={status}
          onChange={(e) => {
            setStatus(e.target.value);
            setOffset(0);
          }}
          className="h-10 cursor-pointer rounded-lg border border-line bg-card px-3 text-sm"
        >
          {STATUS_OPTIONS.map((o) => (
            <option key={o.value} value={o.value}>{o.label}</option>
          ))}
        </select>
        <select
          aria-label="Lọc theo kênh"
          value={channel}
          onChange={(e) => {
            setChannel(e.target.value);
            setOffset(0);
          }}
          className="h-10 cursor-pointer rounded-lg border border-line bg-card px-3 text-sm"
        >
          {CHANNEL_OPTIONS.map((c) => (
            <option key={c} value={c}>{c === '' ? 'Mọi kênh' : c}</option>
          ))}
        </select>
        <select
          aria-label="Số dòng mỗi trang"
          value={limit}
          onChange={(e) => {
            setLimit(Number(e.target.value));
            setOffset(0);
          }}
          className="tabular h-10 cursor-pointer rounded-lg border border-line bg-card px-3 text-sm"
        >
          {LIMIT_OPTIONS.map((n) => (
            <option key={n} value={n}>{n} / trang</option>
          ))}
        </select>
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

      {flash && <Alert variant="success">{flash}</Alert>}
      {error && <Alert variant="error">{error}</Alert>}

      <div className="overflow-x-auto rounded-xl border border-line bg-card">
        <table className="w-full min-w-[720px] text-left text-sm">
          <caption className="sr-only">Danh sách notification</caption>
          <thead>
            <tr className="border-b border-line text-xs text-muted-fg uppercase">
              <th scope="col" className="px-3 py-2.5 font-medium">Thời điểm</th>
              <th scope="col" className="px-3 py-2.5 font-medium">Kênh</th>
              <th scope="col" className="px-3 py-2.5 font-medium">Người nhận</th>
              <th scope="col" className="px-3 py-2.5 font-medium">Nội dung</th>
              <th scope="col" className="px-3 py-2.5 font-medium">Trạng thái</th>
              <th scope="col" className="px-3 py-2.5 font-medium text-right">Hành động</th>
            </tr>
          </thead>
          <tbody>
            {loading ? (
              <SkeletonRows rows={6} cols={6} />
            ) : items.length === 0 ? (
              <tr>
                <td colSpan={6} className="px-3 py-14 text-center">
                  <Prohibit aria-hidden="true" size={28} className="mx-auto text-muted-fg" />
                  <p className="mt-2 text-sm text-muted-fg">Chưa có notification nào khớp bộ lọc.</p>
                  <Link to="/create" className="mt-3 inline-block text-sm font-medium text-info underline underline-offset-2">
                    Tạo notification đầu tiên
                  </Link>
                </td>
              </tr>
            ) : (
              items.map((n) => (
                <tr key={n.id} className="border-t border-line first:border-t-0 hover:bg-muted/40">
                  <td className="px-3 py-2.5 whitespace-nowrap">
                    <time dateTime={n.created_at} title={fmtDateTime(n.created_at)} className="tabular text-xs text-muted-fg">
                      {timeAgo(n.created_at)}
                    </time>
                  </td>
                  <td className="px-3 py-2.5"><ChannelBadge channel={n.channel} /></td>
                  <td className="max-w-44 truncate px-3 py-2.5 font-mono text-xs" title={n.recipient}>
                    {n.recipient}
                  </td>
                  <td className="max-w-56 truncate px-3 py-2.5" title={n.subject ?? n.body}>
                    {n.subject ?? n.body}
                    {n.status === 'recurring' && n.recurrence && (
                      <span className="ml-1.5 rounded bg-muted px-1.5 py-0.5 font-mono text-[10px] text-muted-fg" title={`Cron: ${n.recurrence}`}>
                        {n.recurrence}
                      </span>
                    )}
                  </td>
                  <td className="px-3 py-2.5"><StatusBadge status={n.status as Status} /></td>
                  <td className="px-3 py-2.5">
                    <div className="flex justify-end gap-1">
                      {(n.status === 'scheduled' || n.status === 'recurring') && (
                        <button
                          type="button"
                          onClick={() => setCancelTarget(n)}
                          className={iconBtn}
                          aria-label={`Hủy notification đến ${n.recipient}`}
                          title={n.status === 'recurring' ? 'Gỡ lịch lặp' : 'Hủy job hẹn giờ'}
                        >
                          <Prohibit size={16} aria-hidden="true" />
                        </button>
                      )}
                      {n.status === 'failed' && (
                        <button
                          type="button"
                          onClick={() => void requestReplay(n)}
                          disabled={replayingId === n.id}
                          className={iconBtn}
                          aria-label={`Đẩy lại notification đến ${n.recipient}`}
                          title="Replay job dead"
                        >
                          <ArrowsClockwise size={16} aria-hidden="true" />
                        </button>
                      )}
                      <Link
                        to={`/notifications/${n.id}`}
                        className="inline-flex h-8 cursor-pointer items-center rounded-md border border-line px-2.5 text-xs font-medium hover:bg-muted"
                      >
                        Chi tiết
                      </Link>
                    </div>
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
        {!loading && items.length > 0 && (
          <div className="px-3">
            <Pagination limit={limit} offset={offset} total={total} onPage={setOffset} />
          </div>
        )}
      </div>

      <ConfirmDialog
        open={cancelTarget !== null}
        title="Hủy notification này?"
        message={
          cancelTarget
            ? cancelTarget.status === 'recurring'
              ? `Lịch lặp "${cancelTarget.recurrence}" đến "${cancelTarget.recipient}" sẽ bị gỡ khỏi queue — không còn tự bắn nữa.`
              : `Job hẹn giờ đến "${cancelTarget.recipient}" sẽ bị gỡ khỏi queue và không bao giờ được gửi.`
            : ''
        }
        confirmLabel="Hủy notification"
        danger
        busy={cancelling}
        onConfirm={() => void requestCancel()}
        onCancel={() => setCancelTarget(null)}
      />
    </div>
  );
}
