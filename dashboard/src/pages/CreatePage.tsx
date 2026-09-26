import { useEffect, useMemo, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import {
  ChatText,
  DeviceMobileSpeaker,
  EnvelopeSimple,
  Eye,
  PaperPlaneRight,
  WebhooksLogo,
} from '@phosphor-icons/react';
import { api, ApiError, type Channel } from '../api';
import { Alert, Field } from '../components/ui';

type ContentMode = 'body' | 'template';

const CHANNELS: Array<{ value: Channel; label: string; icon: typeof EnvelopeSimple; hint: string; placeholder: string }> = [
  { value: 'email', label: 'Email', icon: EnvelopeSimple, hint: 'Địa chỉ email người nhận', placeholder: 'you@example.com' },
  { value: 'sms', label: 'SMS', icon: ChatText, hint: 'Số điện thoại (E.164)', placeholder: '+84901234567' },
  { value: 'push', label: 'Push', icon: DeviceMobileSpeaker, hint: 'Device token của thiết bị', placeholder: 'device-token-abc-123' },
  { value: 'webhook', label: 'Webhook', icon: WebhooksLogo, hint: 'URL http(s) sẽ nhận POST JSON', placeholder: 'https://webhook.site/xxx' },
];

export default function CreatePage() {
  const navigate = useNavigate();
  const [channel, setChannel] = useState<Channel>('email');
  const [recipient, setRecipient] = useState('');
  const [subject, setSubject] = useState('');
  const [mode, setMode] = useState<ContentMode>('body');
  const [body, setBody] = useState('');
  const [templates, setTemplates] = useState<string[]>([]);
  const [template, setTemplate] = useState('');
  const [params, setParams] = useState('{\n  "name": "Vinh",\n  "product": "Notification System"\n}');
  const [priority, setPriority] = useState<'high' | 'normal' | 'low'>('normal');
  const [sendAt, setSendAt] = useState('');
  const [idempotencyKey, setIdempotencyKey] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [paramsError, setParamsError] = useState<string | null>(null);

  useEffect(() => {
    api.templates().then((r) => setTemplates(r.templates)).catch(() => setTemplates([]));
  }, []);

  const meta = CHANNELS.find((c) => c.value === channel)!;

  const parsedParams = useMemo<Record<string, unknown> | null>(() => {
    if (mode !== 'template') return {};
    try {
      const v = JSON.parse(params);
      if (v && typeof v === 'object' && !Array.isArray(v)) return v as Record<string, unknown>;
      return null;
    } catch {
      return null;
    }
  }, [mode, params]);

  useEffect(() => {
    if (mode === 'template' && parsedParams === null) {
      setParamsError('Params phải là JSON object hợp lệ, ví dụ {"code": "123456"}');
    } else {
      setParamsError(null);
    }
  }, [mode, parsedParams]);

  const payload = useMemo(() => {
    const p: Record<string, unknown> = { channel, recipient, priority };
    if (subject && channel === 'email') p.subject = subject;
    if (mode === 'body') p.body = body;
    else {
      p.template = template;
      if (parsedParams) p.params = parsedParams;
    }
    if (sendAt) p.sendAt = new Date(sendAt).toISOString();
    return p;
  }, [channel, recipient, subject, body, mode, template, parsedParams, priority, sendAt]);

  const onSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    if (mode === 'template' && parsedParams === null) return;
    setSubmitting(true);
    try {
      const res = await api.create(payload, idempotencyKey || undefined);
      if (res.deduplicated) {
        // trùng Idempotency-Key — dẫn tới notification cũ thay vì tạo mới
        navigate(`/notifications/${res.id}`, { state: { flash: 'Trùng Idempotency-Key — đã trả về notification có sẵn (deduplicated).' } });
      } else {
        navigate(`/notifications/${res.id}`, { state: { flash: `Đã tạo notification (${res.status}).` } });
      }
    } catch (err) {
      const hint = err instanceof ApiError && err.status === 401 ? ' — thao tác ghi cần API key, nhập ở thanh trên' : '';
      setError(`${err instanceof Error ? err.message : 'Gửi thất bại'}${hint}`);
    } finally {
      setSubmitting(false);
    }
  };

  const inputCls =
    'h-11 w-full rounded-lg border border-line bg-card px-3 text-sm outline-none placeholder:text-muted-fg focus:border-accent';

  return (
    <div className="space-y-4">
      <div>
        <h1 className="text-xl font-semibold">Tạo notification</h1>
        <p className="text-sm text-muted-fg">Gửi qua POST /notifications — job sẽ đi qua outbox → queue → worker</p>
      </div>

      <form onSubmit={onSubmit} className="grid gap-4 lg:grid-cols-[1fr_320px]" noValidate={false}>
        <div className="space-y-4 rounded-xl border border-line bg-card p-4">
          <fieldset>
            <legend className="mb-2 text-sm font-medium">Kênh gửi</legend>
            <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
              {CHANNELS.map((c) => (
                <label
                  key={c.value}
                  className={`flex cursor-pointer flex-col items-center gap-1 rounded-lg border px-3 py-3 text-sm font-medium transition-colors has-checked:border-accent has-checked:bg-accent/10 has-checked:text-accent ${
                    channel === c.value ? 'border-accent bg-accent/10 text-accent' : 'border-line text-muted-fg hover:bg-muted'
                  }`}
                >
                  <input
                    type="radio"
                    name="channel"
                    value={c.value}
                    checked={channel === c.value}
                    onChange={() => setChannel(c.value)}
                    className="sr-only"
                  />
                  <c.icon size={20} aria-hidden="true" />
                  {c.label}
                </label>
              ))}
            </div>
          </fieldset>

          <Field id="recipient" label="Người nhận" hint={meta.hint} required>
            <input
              id="recipient"
              type={channel === 'webhook' ? 'url' : 'text'}
              inputMode={channel === 'sms' ? 'tel' : undefined}
              value={recipient}
              onChange={(e) => setRecipient(e.target.value)}
              placeholder={meta.placeholder}
              required
              className={inputCls}
            />
          </Field>

          {channel === 'email' && (
            <Field id="subject" label="Tiêu đề" hint="Bỏ trống nếu không cần">
              <input id="subject" type="text" value={subject} onChange={(e) => setSubject(e.target.value)} className={inputCls} />
            </Field>
          )}

          <fieldset>
            <legend className="mb-2 text-sm font-medium">Nội dung</legend>
            <div className="mb-2 inline-flex rounded-lg border border-line bg-muted p-0.5" role="tablist" aria-label="Chế độ nội dung">
              {(
                [
                  ['body', 'Nhập trực tiếp'],
                  ['template', 'Dùng template'],
                ] as Array<[ContentMode, string]>
              ).map(([value, label]) => (
                <button
                  key={value}
                  type="button"
                  role="tab"
                  aria-selected={mode === value}
                  onClick={() => setMode(value)}
                  className={`h-8 cursor-pointer rounded-md px-3 text-xs font-medium ${
                    mode === value ? 'bg-card text-fg shadow-sm' : 'text-muted-fg hover:text-fg'
                  }`}
                >
                  {label}
                </button>
              ))}
            </div>

            {mode === 'body' ? (
              <Field id="body" label="Nội dung tin nhắn" required>
                <textarea
                  id="body"
                  value={body}
                  onChange={(e) => setBody(e.target.value)}
                  rows={4}
                  required
                  className="w-full rounded-lg border border-line bg-card px-3 py-2.5 text-sm outline-none focus:border-accent"
                />
              </Field>
            ) : (
              <div className="space-y-3">
                <Field
                  id="template"
                  label="Template"
                  hint={templates.length ? `Khả dụng: ${templates.join(', ')}` : 'Không tải được danh sách template'}
                  required
                >
                  <select
                    id="template"
                    value={template}
                    onChange={(e) => setTemplate(e.target.value)}
                    required
                    className={`${inputCls} cursor-pointer`}
                  >
                    <option value="" disabled>
                      — chọn template —
                    </option>
                    {templates.map((t) => (
                      <option key={t} value={t}>{t}</option>
                    ))}
                  </select>
                </Field>
                <Field
                  id="params"
                  label="Params (JSON)"
                  hint={'Biến truyền vào template, VD {"code": "246810", "minutes": 5}'}
                  error={paramsError ?? undefined}
                >
                  <textarea
                    id="params"
                    value={params}
                    onChange={(e) => setParams(e.target.value)}
                    rows={4}
                    aria-invalid={paramsError !== null}
                    aria-describedby={paramsError ? 'params-error' : 'params-hint'}
                    className="w-full rounded-lg border border-line bg-card px-3 py-2.5 font-mono text-xs outline-none focus:border-accent"
                  />
                </Field>
              </div>
            )}
          </fieldset>

          <div className="grid gap-3 sm:grid-cols-3">
            <Field id="priority" label="Ưu tiên">
              <select id="priority" value={priority} onChange={(e) => setPriority(e.target.value as typeof priority)} className={`${inputCls} cursor-pointer`}>
                <option value="high">Cao</option>
                <option value="normal">Bình thường</option>
                <option value="low">Thấp</option>
              </select>
            </Field>
            <Field id="sendAt" label="Hẹn giờ gửi" hint="Bỏ trống = gửi ngay">
              <input
                id="sendAt"
                type="datetime-local"
                value={sendAt}
                onChange={(e) => setSendAt(e.target.value)}
                className={`${inputCls} cursor-pointer`}
              />
            </Field>
            <Field id="idem" label="Idempotency-Key" hint="Tránh gửi trùng khi retry">
              <input
                id="idem"
                type="text"
                value={idempotencyKey}
                onChange={(e) => setIdempotencyKey(e.target.value)}
                placeholder="otp-user-42"
                autoComplete="off"
                className={inputCls}
              />
            </Field>
          </div>

          {error && <Alert variant="error">{error}</Alert>}

          <button
            type="submit"
            disabled={submitting || (mode === 'template' && parsedParams === null)}
            className="inline-flex h-11 cursor-pointer items-center gap-2 rounded-lg bg-accent px-5 text-sm font-semibold text-accent-fg hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-50"
          >
            <PaperPlaneRight size={17} weight="bold" aria-hidden="true" />
            {submitting ? 'Đang gửi…' : 'Gửi notification'}
          </button>
        </div>

        {/* preview payload — nhìn thấy chính xác điều mình sắp gửi */}
        <aside aria-label="Xem trước payload" className="h-fit rounded-xl border border-line bg-card p-4 lg:sticky lg:top-20">
          <p className="mb-2 flex items-center gap-1.5 text-sm font-semibold text-muted-fg">
            <Eye size={15} aria-hidden="true" /> Payload sẽ gửi
          </p>
          <pre className="max-h-96 overflow-auto rounded-lg bg-muted p-3 font-mono text-[11px] leading-relaxed whitespace-pre-wrap break-words">
{JSON.stringify(payload, null, 2)}
          </pre>
          <p className="mt-2 text-[11px] text-muted-fg">
            Header <code className="font-mono">Idempotency-Key: {idempotencyKey || '(không đặt)'}</code>
          </p>
          <p className="mt-3 text-[11px] text-muted-fg">
            Thao tác ghi cần API key — đặt ở thanh trên cùng.{' '}
            <Link to="/notifications" className="text-info underline underline-offset-2">Xem danh sách</Link>
          </p>
        </aside>
      </form>
    </div>
  );
}
