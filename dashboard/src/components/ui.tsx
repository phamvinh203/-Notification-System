import type { ReactNode } from 'react';
import { Warning, CheckCircle, Info } from '@phosphor-icons/react';

export function Alert({ variant, children }: { variant: 'error' | 'success' | 'info'; children: ReactNode }) {
  const meta = {
    error: { cls: 'border-danger/40 bg-danger/10 text-danger', icon: Warning },
    success: { cls: 'border-accent/40 bg-accent/10 text-accent', icon: CheckCircle },
    info: { cls: 'border-info/40 bg-info/10 text-info', icon: Info },
  }[variant];
  const Icon = meta.icon;
  const role = variant === 'error' ? 'alert' : 'status';
  return (
    <div role={role} className={`flex items-start gap-2 rounded-lg border px-3 py-2.5 text-sm ${meta.cls}`}>
      <Icon size={18} weight="bold" aria-hidden="true" className="mt-0.5 shrink-0" />
      <div className="min-w-0" style={{ overflowWrap: 'anywhere' }}>{children}</div>
    </div>
  );
}

export function Field({
  id,
  label,
  hint,
  error,
  required = false,
  children,
}: {
  id: string;
  label: string;
  hint?: string;
  error?: string;
  required?: boolean;
  children: ReactNode;
}) {
  return (
    <div>
      <label htmlFor={id} className="mb-1 block text-sm font-medium">
        {label} {required && <span aria-hidden="true" className="text-danger">*</span>}
      </label>
      {children}
      {hint && !error && <p id={`${id}-hint`} className="mt-1 text-xs text-muted-fg">{hint}</p>}
      {error && (
        <p id={`${id}-error`} role="alert" className="mt-1 text-xs text-danger">
          {error}
        </p>
      )}
    </div>
  );
}

export function Pagination({
  limit,
  offset,
  total,
  onPage,
}: {
  limit: number;
  offset: number;
  total: number;
  onPage: (offset: number) => void;
}) {
  const from = total === 0 ? 0 : offset + 1;
  const to = Math.min(offset + limit, total);
  const hasPrev = offset > 0;
  const hasNext = offset + limit < total;
  return (
    <nav className="flex items-center justify-between gap-3 px-1 py-3" aria-label="Phân trang">
      <p className="tabular text-xs text-muted-fg" aria-live="polite">
        Hiển thị {from}–{to} / {total} notification
      </p>
      <div className="flex gap-2">
        <button
          type="button"
          disabled={!hasPrev}
          onClick={() => onPage(Math.max(0, offset - limit))}
          className="h-9 cursor-pointer rounded-lg border border-line px-3 text-sm font-medium hover:bg-muted disabled:cursor-not-allowed disabled:opacity-40"
        >
          ← Trước
        </button>
        <button
          type="button"
          disabled={!hasNext}
          onClick={() => onPage(offset + limit)}
          className="h-9 cursor-pointer rounded-lg border border-line px-3 text-sm font-medium hover:bg-muted disabled:cursor-not-allowed disabled:opacity-40"
        >
          Sau →
        </button>
      </div>
    </nav>
  );
}

export function SkeletonRows({ rows = 5, cols = 5 }: { rows?: number; cols?: number }) {
  return (
    <>
      {Array.from({ length: rows }, (_, r) => (
        <tr key={r} className="border-t border-line">
          {Array.from({ length: cols }, (_, c) => (
            <td key={c} className="px-3 py-3">
              <div className="h-4 animate-pulse rounded bg-muted" style={{ width: `${55 + ((r * 13 + c * 29) % 40)}%` }} />
            </td>
          ))}
        </tr>
      ))}
    </>
  );
}
