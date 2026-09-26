import { useCallback, useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Megaphone, PaperPlaneRight, PlusCircle, UserMinus, Users } from '@phosphor-icons/react';
import { api, ApiError, type Channel, type PreferenceRow, type Subscriber, type TopicInfo } from '../api';
import { ChannelBadge } from '../components/badges';
import { Alert, Field, SkeletonRows } from '../components/ui';

const CHANNELS: Channel[] = ['email', 'push', 'sms', 'webhook'];

const inputCls =
  'h-11 w-full rounded-lg border border-line bg-card px-3 text-sm outline-none placeholder:text-muted-fg focus:border-accent';

// ===== phần Topics: danh sách topic + subscriber + form gửi broadcast =====

function TopicsSection() {
  const navigate = useNavigate();
  const [topics, setTopics] = useState<TopicInfo[] | null>(null);
  const [selected, setSelected] = useState<string>('');
  const [subscribers, setSubscribers] = useState<Subscriber[]>([]);
  const [subsLoading, setSubsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [flash, setFlash] = useState<string | null>(null);

  // form subscribe
  const [topic, setTopic] = useState(''); // topic đang thao tác (subscribe mới)
  const [recipient, setRecipient] = useState('');
  const [channel, setChannel] = useState<Channel>('email');
  const [busy, setBusy] = useState(false);

  // form broadcast
  const [subject, setSubject] = useState('');
  const [body, setBody] = useState('');
  const [sending, setSending] = useState(false);

  const loadTopics = useCallback(async () => {
    try {
      const res = await api.topics();
      setTopics(res.topics);
      setSelected((cur) => cur || res.topics[0]?.topic || '');
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Không tải được topics');
    }
  }, []);

  useEffect(() => {
    loadTopics();
  }, [loadTopics]);

  const loadSubscribers = useCallback(async (t: string) => {
    if (!t) {
      setSubscribers([]);
      return;
    }
    setSubsLoading(true);
    try {
      const res = await api.subscribers(t);
      setSubscribers(res.subscribers);
    } catch {
      setSubscribers([]);
    } finally {
      setSubsLoading(false);
    }
  }, []);

  useEffect(() => {
    loadSubscribers(selected);
  }, [selected, loadSubscribers]);

  const subscribe = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    setFlash(null);
    const t = topic.trim();
    if (!t || !recipient.trim()) return;
    setBusy(true);
    try {
      const res = await api.subscribe(t, recipient.trim(), channel);
      setFlash(res.created ? `Đã đăng ký ${recipient} vào topic "${t}"` : `${recipient} đã có trong topic "${t}" từ trước`);
      await loadTopics(); // refresh cả count (kể cả topic đã tồn tại) + danh sách select
      setSelected(t);
      await loadSubscribers(t);
      setRecipient('');
    } catch (err) {
      const hint = err instanceof ApiError && err.status === 401 ? ' — kiểm tra API key ở thanh trên' : '';
      setError(`Đăng ký thất bại: ${err instanceof Error ? err.message : 'lỗi không rõ'}${hint}`);
    } finally {
      setBusy(false);
    }
  };

  const unsubscribe = async (sub: Subscriber) => {
    setError(null);
    try {
      await api.unsubscribe(selected, sub.recipient, sub.channel);
      await loadSubscribers(selected);
      await loadTopics();
    } catch (err) {
      setError(`Hủy đăng ký thất bại: ${err instanceof Error ? err.message : 'lỗi không rõ'}`);
    }
  };

  const sendBroadcast = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    setFlash(null);
    if (!selected || !body.trim()) return;
    setSending(true);
    try {
      const res = await api.sendBroadcast(selected, subject.trim() ? { subject: subject.trim(), body: body.trim() } : { body: body.trim() });
      navigate(`/broadcasts/${res.broadcastId}`, {
        state: { flash: `Broadcast tới ${res.subscribers} subscriber — worker đang fan-out.` },
      });
    } catch (err) {
      const hint = err instanceof ApiError && err.status === 404 ? ' — topic chưa có subscriber nào' : '';
      setError(`Gửi broadcast thất bại: ${err instanceof Error ? err.message : 'lỗi không rõ'}${hint}`);
    } finally {
      setSending(false);
    }
  };

  return (
    <div className="space-y-4">
      {/* đăng ký subscriber */}
      <form onSubmit={subscribe} className="rounded-xl border border-line bg-card p-4" aria-label="Đăng ký subscriber vào topic">
        <h2 className="mb-3 flex items-center gap-2 text-sm font-semibold">
          <PlusCircle size={16} aria-hidden="true" className="text-accent" /> Đăng ký vào topic
        </h2>
        <div className="grid gap-3 sm:grid-cols-[1fr_1fr_auto]">
          <Field id="topic" label="Topic" hint="Tên mới cũng được — tự tạo khi đăng ký">
            <input
              id="topic"
              list="topic-list"
              value={topic}
              onChange={(e) => setTopic(e.target.value)}
              placeholder="news, otp-events…"
              required
              className={inputCls}
            />
            <datalist id="topic-list">
              {(topics ?? []).map((t) => <option key={t.topic} value={t.topic} />)}
            </datalist>
          </Field>
          <Field id="sub-recipient" label="Người nhận" required>
            <input
              id="sub-recipient"
              value={recipient}
              onChange={(e) => setRecipient(e.target.value)}
              placeholder="user@example.com"
              required
              className={inputCls}
            />
          </Field>
          <Field id="sub-channel" label="Kênh">
            <select id="sub-channel" value={channel} onChange={(e) => setChannel(e.target.value as Channel)} className={`${inputCls} cursor-pointer`}>
              {CHANNELS.map((c) => <option key={c} value={c}>{c}</option>)}
            </select>
          </Field>
        </div>
        <button
          type="submit"
          disabled={busy}
          className="mt-3 inline-flex h-10 cursor-pointer items-center gap-2 rounded-lg bg-accent px-4 text-sm font-semibold text-accent-fg hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-50"
        >
          {busy ? 'Đang lưu…' : 'Đăng ký'}
        </button>
      </form>

      {flash && <Alert variant="success">{flash}</Alert>}
      {error && <Alert variant="error">{error}</Alert>}

      {/* danh sách topic + subscribers */}
      <div className="grid gap-4 lg:grid-cols-[240px_1fr]">
        <aside className="h-fit rounded-xl border border-line bg-card p-3" aria-label="Danh sách topic">
          <p className="mb-2 flex items-center gap-1.5 px-1 text-sm font-semibold text-muted-fg">
            <Users size={15} aria-hidden="true" /> Topics
          </p>
          {topics === null ? (
            <div className="space-y-2 p-1">{[0, 1].map((i) => <div key={i} className="h-8 animate-pulse rounded bg-muted" />)}</div>
          ) : topics.length === 0 ? (
            <p className="p-1 text-xs text-muted-fg">Chưa có topic nào — đăng ký subscriber đầu tiên ở trên.</p>
          ) : (
            <ul className="space-y-1">
              {topics.map((t) => (
                <li key={t.topic}>
                  <button
                    type="button"
                    onClick={() => setSelected(t.topic)}
                    className={`flex w-full cursor-pointer items-center justify-between gap-2 rounded-lg px-2.5 py-2 text-left text-sm font-mono transition-colors ${
                      selected === t.topic ? 'bg-accent/15 text-accent' : 'text-fg hover:bg-muted'
                    }`}
                  >
                    <span className="truncate">{t.topic}</span>
                    <span className="tabular shrink-0 rounded-full bg-muted px-2 py-0.5 text-xs text-muted-fg">{t.subscribers}</span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </aside>

        <div className="min-w-0 space-y-4">
          <div className="overflow-hidden rounded-xl border border-line bg-card" aria-label={`Subscribers của topic ${selected}`}>
            <p className="border-b border-line px-3 py-2.5 text-sm">
              Subscribers của <span className="font-mono font-semibold">{selected || '—'}</span>
            </p>
            <table className="w-full text-left text-sm">
              <thead>
                <tr className="border-b border-line text-xs text-muted-fg uppercase">
                  <th scope="col" className="px-3 py-2 font-medium">Người nhận</th>
                  <th scope="col" className="px-3 py-2 font-medium">Kênh</th>
                  <th scope="col" className="px-3 py-2 font-medium text-right">Hành động</th>
                </tr>
              </thead>
              <tbody>
                {subsLoading ? (
                  <SkeletonRows rows={3} cols={3} />
                ) : !selected || subscribers.length === 0 ? (
                  <tr>
                    <td colSpan={3} className="px-3 py-8 text-center text-sm text-muted-fg">
                      {selected ? 'Topic chưa có subscriber.' : 'Chọn một topic để xem subscribers.'}
                    </td>
                  </tr>
                ) : (
                  subscribers.map((s) => (
                    <tr key={`${s.recipient}:${s.channel}`} className="border-t border-line first:border-t-0 hover:bg-muted/40">
                      <td className="max-w-56 truncate px-3 py-2 font-mono text-xs" title={s.recipient}>{s.recipient}</td>
                      <td className="px-3 py-2"><ChannelBadge channel={s.channel} /></td>
                      <td className="px-3 py-2 text-right">
                        <button
                          type="button"
                          onClick={() => void unsubscribe(s)}
                          className="inline-flex h-8 cursor-pointer items-center gap-1 rounded-md border border-line px-2.5 text-xs font-medium text-danger hover:bg-danger/10"
                          aria-label={`Hủy đăng ký ${s.recipient}`}
                        >
                          <UserMinus size={13} aria-hidden="true" /> Hủy
                        </button>
                      </td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>

          {/* gửi broadcast */}
          <form onSubmit={sendBroadcast} className="rounded-xl border border-line bg-card p-4" aria-label="Gửi broadcast tới topic">
            <h2 className="mb-3 flex items-center gap-2 text-sm font-semibold">
              <Megaphone size={16} aria-hidden="true" className="text-accent" /> Gửi broadcast tới topic “{selected || '—'}”
            </h2>
            <div className="space-y-3">
              <Field id="bc-subject" label="Tiêu đề" hint="Tùy chọn — một số kênh (SMS/push) bỏ qua">
                <input id="bc-subject" value={subject} onChange={(e) => setSubject(e.target.value)} className={inputCls} />
              </Field>
              <Field id="bc-body" label="Nội dung" required>
                <textarea
                  id="bc-body"
                  value={body}
                  onChange={(e) => setBody(e.target.value)}
                  rows={3}
                  required
                  className="w-full rounded-lg border border-line bg-card px-3 py-2.5 text-sm outline-none focus:border-accent"
                />
              </Field>
              <button
                type="submit"
                disabled={sending || !selected}
                className="inline-flex h-10 cursor-pointer items-center gap-2 rounded-lg bg-accent px-4 text-sm font-semibold text-accent-fg hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-50"
              >
                <PaperPlaneRight size={16} weight="bold" aria-hidden="true" />
                {sending ? 'Đang gửi…' : 'Gửi broadcast'}
              </button>
              <p className="text-xs text-muted-fg">
                API trả ngay 202 — worker đọc subscribers, tạo 1 notification mỗi người (bỏ qua ai đã tắt kênh), theo dõi tiến độ ở trang Broadcasts.
              </p>
            </div>
          </form>
        </div>
      </div>
    </div>
  );
}

// ===== phần Preferences: bật/tắt kênh theo recipient =====

function PreferencesSection() {
  const [recipient, setRecipient] = useState('');
  const [rows, setRows] = useState<PreferenceRow[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [flash, setFlash] = useState<string | null>(null);
  const [searched, setSearched] = useState('');

  const load = useCallback(async (r: string) => {
    if (!r.trim()) return;
    setLoading(true);
    setError(null);
    setFlash(null);
    try {
      const res = await api.preferences(r.trim());
      setRows(res.preferences);
      setSearched(res.recipient);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Không tải được preferences');
    } finally {
      setLoading(false);
    }
  }, []);

  const toggle = async (channel: Channel, current: boolean) => {
    setError(null);
    try {
      await api.setPreference(searched, channel, !current);
      setFlash(`Đã ${!current ? 'bật' : 'tắt'} kênh ${channel} cho ${searched}`);
      await load(searched);
    } catch (err) {
      const hint = err instanceof ApiError && err.status === 401 ? ' — kiểm tra API key ở thanh trên' : '';
      setError(`Thay đổi thất bại: ${err instanceof Error ? err.message : 'lỗi không rõ'}${hint}`);
    }
  };

  return (
    <div className="space-y-4 rounded-xl border border-line bg-card p-4" aria-label="Preference người nhận">
      <div>
        <h2 className="text-sm font-semibold">Preference theo người nhận</h2>
        <p className="mt-0.5 text-xs text-muted-fg">
          Tắt kênh = worker sẽ chặn gửi (notification rơi vào trạng thái “Bị chặn”), broadcast cũng bỏ qua.
        </p>
      </div>

      <form
        onSubmit={(e) => {
          e.preventDefault();
          load(recipient);
        }}
        className="flex gap-2"
      >
        <label htmlFor="pref-recipient" className="sr-only">Người nhận</label>
        <input
          id="pref-recipient"
          value={recipient}
          onChange={(e) => setRecipient(e.target.value)}
          placeholder="Nhập email / số điện thoại / device token…"
          className={inputCls}
        />
        <button
          type="submit"
          disabled={!recipient.trim() || loading}
          className="h-11 shrink-0 cursor-pointer rounded-lg border border-line bg-card px-4 text-sm font-medium hover:bg-muted disabled:cursor-not-allowed disabled:opacity-40"
        >
          {loading ? 'Đang tải…' : 'Xem'}
        </button>
      </form>

      {flash && <Alert variant="success">{flash}</Alert>}
      {error && <Alert variant="error">{error}</Alert>}

      {searched && (
        <ul className="grid gap-2 sm:grid-cols-2">
          {CHANNELS.map((c) => {
            const row = rows.find((r) => r.channel === c);
            const enabled = row?.enabled ?? true; // mặc định bật — worker chỉ chặn khi có row enabled=false
            return (
              <li
                key={c}
                className="flex items-center justify-between gap-3 rounded-lg border border-line px-3 py-2.5"
              >
                <div>
                  <p className="text-sm font-medium">{c}</p>
                  <p className="text-xs text-muted-fg">
                    {row ? `Cập nhật ${row.updated_at.slice(0, 16).replace('T', ' ')}` : 'Mặc định (bật)'}
                  </p>
                </div>
                <button
                  type="button"
                  role="switch"
                  aria-checked={enabled}
                  aria-label={`${enabled ? 'Tắt' : 'Bật'} kênh ${c}`}
                  onClick={() => void toggle(c, enabled)}
                  className={`relative h-6 w-11 shrink-0 cursor-pointer rounded-full transition-colors ${enabled ? 'bg-accent' : 'bg-muted-fg/40'}`}
                >
                  <span
                    aria-hidden="true"
                    className={`absolute top-0.5 h-5 w-5 rounded-full bg-white shadow transition-transform ${enabled ? 'translate-x-[22px]' : 'translate-x-0.5'}`}
                  />
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}

export default function AudiencePage() {
  const [tab, setTab] = useState<'topics' | 'preferences'>('topics');
  return (
    <div className="space-y-4">
      <div>
        <h1 className="text-xl font-semibold">Đối tượng</h1>
        <p className="text-sm text-muted-fg">Topics (gửi broadcast theo nhóm) và preference của từng người nhận</p>
      </div>
      <div className="inline-flex rounded-lg border border-line bg-muted p-0.5" role="tablist" aria-label="Chế độ xem">
        {(
          [
            ['topics', 'Topics & Broadcast'],
            ['preferences', 'Preferences'],
          ] as Array<['topics' | 'preferences', string]>
        ).map(([value, label]) => (
          <button
            key={value}
            type="button"
            role="tab"
            aria-selected={tab === value}
            onClick={() => setTab(value)}
            className={`h-9 cursor-pointer rounded-md px-4 text-sm font-medium ${
              tab === value ? 'bg-card text-fg shadow-sm' : 'text-muted-fg hover:text-fg'
            }`}
          >
            {label}
          </button>
        ))}
      </div>
      {tab === 'topics' ? <TopicsSection /> : <PreferencesSection />}
    </div>
  );
}
