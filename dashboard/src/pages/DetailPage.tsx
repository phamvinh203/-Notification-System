import { useCallback, useEffect, useState } from 'react';
import { Link, useLocation, useParams } from 'react-router-dom';
import { ArrowLeft, ArrowsClockwise, Prohibit } from '@phosphor-icons/react';
import { api, ApiError, type DeliveryEvent, type NotificationRow } from '../api';
import { ChannelBadge, StatusBadge } from '../components/badges';
import { Timeline } from '../components/Timeline';
import { Alert } from '../components/ui';
import { ConfirmDialog } from '../components/ConfirmDialog';
import { fmtDateTime } from '../utils';

const IN_FLIGHT: Array<string> = ['scheduled', 'queued', 'processing'];

export default function DetailPage() {
  const { id } = useParams<{ id: string }>();
  const location = useLocation();
  // flash truyền qua navigate state từ trang Tạo mới
  const [flash, setFlash] = useState<string | null>(
    (location.state as { flash?: string } | null)?.flash ?? null,
  );
  const [row, setRow] = useState<NotificationRow | null>(null);
  const [events, setEvents] = useState<DeliveryEvent[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [confirmCancel, setConfirmCancel] = useState(false);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    if (!id) return;
    try {
      const res = await api.detail(id);
      setRow(res.notification);
      setEvents(res.events);
      setError(null);
    } catch (e) {
      setError(e instanceof ApiError && e.status === 404 ? 'Notification không tồn tại (hoặc đã bị xóa khỏi DB).' : e instanceof Error ? e.message : 'Không tải được chi tiết');
    } finally {
      setLoading(false);
    }
  }, [id]);

  // notification đang chạy → poll để timeline "sống"
  useEffect(() => {
    load();
    if (!row || !IN_FLIGHT.includes(row.status)) return;
    const t = setInterval(() => void load(), 2000);
    return () => clearInterval(t);
  }, [load, row?.status]);

  const doCancel = async () => {
    setBusy(true);
    try {
      await api.cancel(id!);
      setFlash('Đã hủy notification.');
      setConfirmCancel(false);
      await load();
    } catch (e) {
      const hint = e instanceof ApiError && e.status === 401 ? ' — kiểm tra API key ở thanh trên' : '';
      setActionError(`Hủy thất bại: ${e instanceof Error ? e.message : 'lỗi không rõ'}${hint}`);
      setConfirmCancel(false);
    } finally {
      setBusy(false);
    }
  };

  const doReplay = async () => {
    setBusy(true);
    try {
      await api.replay(id!);
      setFlash('Đã đẩy lại vào hàng đợi.');
      await load();
    } catch (e) {
      const hint = e instanceof ApiError && e.status === 401 ? ' — kiểm tra API key ở thanh trên' : '';
      setActionError(`Replay thất bại: ${e instanceof Error ? e.message : 'lỗi không rõ'}${hint}`);
    } finally {
      setBusy(false);
    }
  };

  if (loading) return <p className="py-20 text-center text-sm text-muted-fg">Đang tải…</p>;
  if (error || !row)
    return (
      <div className="space-y-4 py-10">
        <Alert variant="error">{error ?? 'Không tìm thấy notification'}</Alert>
        <Link to="/notifications" className="inline-flex items-center gap-1.5 text-sm text-info underline underline-offset-2">
          <ArrowLeft size={14} aria-hidden="true" /> Về danh sách
        </Link>
      </div>
    );

  const canCancel = row.status === 'scheduled';
  const canReplay = row.status === 'failed';

  return (
    <div className="space-y-4">
      <Link to="/notifications" className="inline-flex items-center gap-1.5 text-sm text-muted-fg hover:text-fg">
        <ArrowLeft size={14} aria-hidden="true" /> Danh sách
      </Link>

      <div className="flex flex-wrap items-center gap-3">
        <h1 className="font-mono text-lg font-semibold break-all" style={{ overflowWrap: 'anywhere' }}>
          {row.id}
        </h1>
        <StatusBadge status={row.status} />
      </div>

      {flash && <Alert variant="success">{flash}</Alert>}
      {actionError && <Alert variant="error">{actionError}</Alert>}

      <div className="grid gap-4 lg:grid-cols-2">
        <section aria-label="Thông tin notification" className="space-y-4 rounded-xl border border-line bg-card p-4">
          <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-2.5 text-sm">
            <dt className="text-muted-fg">Kênh</dt>
            <dd><ChannelBadge channel={row.channel} /></dd>
            <dt className="text-muted-fg">Người nhận</dt>
            <dd className="font-mono text-xs break-all" style={{ overflowWrap: 'anywhere' }}>{row.recipient}</dd>
            {row.subject && (
              <>
                <dt className="text-muted-fg">Tiêu đề</dt>
                <dd>{row.subject}</dd>
              </>
            )}
            <dt className="text-muted-fg">Tạo lúc</dt>
            <dd className="tabular text-xs">{fmtDateTime(row.created_at)}</dd>
            {row.scheduled_at && (
              <>
                <dt className="text-muted-fg">Hẹn gửi lúc</dt>
                <dd className="tabular text-xs">{fmtDateTime(row.scheduled_at)}</dd>
              </>
            )}
          </dl>
          <div>
            <p className="mb-1 text-sm font-medium">Nội dung</p>
            <pre className="max-h-56 overflow-auto rounded-lg bg-muted p-3 font-mono text-xs whitespace-pre-wrap break-words">{row.body}</pre>
          </div>

          <div className="flex gap-2 border-t border-line pt-3">
            {canCancel && (
              <button
                type="button"
                onClick={() => setConfirmCancel(true)}
                className="inline-flex h-10 cursor-pointer items-center gap-2 rounded-lg bg-danger px-3.5 text-sm font-semibold text-white hover:opacity-90"
              >
                <Prohibit size={15} weight="bold" aria-hidden="true" />
                Hủy job hẹn giờ
              </button>
            )}
            {canReplay && (
              <button
                type="button"
                onClick={() => void doReplay()}
                disabled={busy}
                className="inline-flex h-10 cursor-pointer items-center gap-2 rounded-lg bg-accent px-3.5 text-sm font-semibold text-accent-fg hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-50"
              >
                <ArrowsClockwise size={15} weight="bold" aria-hidden="true" />
                {busy ? 'Đang đẩy lại…' : 'Replay job dead'}
              </button>
            )}
            {!canCancel && !canReplay && (
              <p className="text-xs text-muted-fg">
                Không có hành động khả dụng với trạng thái này.
              </p>
            )}
          </div>
        </section>

        <section aria-label="Timeline delivery events" className="rounded-xl border border-line bg-card p-4">
          <h2 className="mb-4 text-sm font-semibold text-muted-fg uppercase">
            Timeline {IN_FLIGHT.includes(row.status) && <span className="ml-1 normal-case text-info">• live</span>}
          </h2>
          <Timeline events={events} />
        </section>
      </div>

      <ConfirmDialog
        open={confirmCancel}
        title="Hủy notification này?"
        message={`Job hẹn giờ đến "${row.recipient}" sẽ bị gỡ khỏi queue và không bao giờ được gửi.`}
        confirmLabel="Hủy notification"
        danger
        busy={busy}
        onConfirm={() => void doCancel()}
        onCancel={() => setConfirmCancel(false)}
      />
    </div>
  );
}
