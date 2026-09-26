import { useCallback, useEffect, useState } from 'react';
import { NavLink, Outlet } from 'react-router-dom';
import {
  BellRinging,
  ChartLineUp,
  Key,
  Moon,
  PlusCircle,
  Sun,
  ArrowSquareOut,
  ListChecks,
} from '@phosphor-icons/react';
import { apiBase } from './api';

const NAV: Array<{ to: string; label: string; icon: typeof ChartLineUp; end?: boolean }> = [
  { to: '/', label: 'Tổng quan', icon: ChartLineUp, end: true },
  { to: '/notifications', label: 'Thông báo', icon: ListChecks },
  { to: '/create', label: 'Tạo mới', icon: PlusCircle },
];

function useHealth(): boolean | null {
  const [healthy, setHealthy] = useState<boolean | null>(null);
  useEffect(() => {
    let alive = true;
    const check = () =>
      fetch(`${apiBase}/health`)
        .then((r) => r.ok)
        .then((ok) => alive && setHealthy(ok))
        .catch(() => alive && setHealthy(false));
    check();
    const t = setInterval(check, 10_000);
    return () => {
      alive = false;
      clearInterval(t);
    };
  }, []);
  return healthy;
}

export default function App() {
  const [theme, setTheme] = useState<'dark' | 'light'>(() =>
    localStorage.getItem('theme') === 'light' ? 'light' : 'dark',
  );
  const [apiKey, setApiKey] = useState(() => localStorage.getItem('apiKey') ?? '');
  const healthy = useHealth();

  useEffect(() => {
    document.documentElement.classList.toggle('light', theme === 'light');
    localStorage.setItem('theme', theme);
  }, [theme]);

  const onKeyChange = useCallback((value: string) => {
    setApiKey(value);
    localStorage.setItem('apiKey', value);
  }, []);

  const navLinkCls = ({ isActive }: { isActive: boolean }) =>
    `flex items-center gap-2.5 cursor-pointer rounded-lg px-3 py-2.5 text-sm font-medium transition-colors hover:bg-muted ${
      isActive ? 'bg-accent/15 text-accent' : 'text-muted-fg'
    }`;

  return (
    <div className="flex min-h-dvh">
      <a
        href="#main"
        className="sr-only focus:not-sr-only focus:absolute focus:top-2 focus:left-2 focus:z-50 focus:rounded-lg focus:bg-accent focus:px-3 focus:py-2 focus:text-accent-fg"
      >
        Tới nội dung chính
      </a>

      {/* sidebar — desktop */}
      <aside className="sticky top-0 hidden h-dvh w-56 shrink-0 flex-col border-r border-line bg-card/50 px-3 py-4 backdrop-blur md:flex">
        <div className="flex items-center gap-2 px-2 pb-4">
          <span className="rounded-lg bg-accent/15 p-1.5 text-accent">
            <BellRinging size={20} weight="bold" aria-hidden="true" />
          </span>
          <span className="font-mono text-sm font-semibold">Notification</span>
        </div>
        <nav className="flex flex-col gap-1" aria-label="Điều hướng chính">
          {NAV.map(({ to, label, icon: Icon, end }) => (
            <NavLink key={to} to={to} className={navLinkCls} end={end}>
              <Icon size={18} aria-hidden="true" />
              {label}
            </NavLink>
          ))}
        </nav>
        <div className="mt-auto border-t border-line pt-3">
          <a
            href="/admin/queues"
            target="_blank"
            rel="noreferrer"
            className="flex items-center gap-2.5 rounded-lg px-3 py-2.5 text-sm font-medium text-muted-fg transition-colors hover:bg-muted hover:text-fg"
          >
            <ArrowSquareOut size={18} aria-hidden="true" />
            Bull Board
          </a>
        </div>
      </aside>

      <div className="flex min-w-0 flex-1 flex-col">
        {/* topbar */}
        <header className="glass sticky top-0 z-40 flex h-14 items-center gap-3 px-4">
          <span className="flex items-center gap-2 md:hidden">
            <BellRinging size={18} weight="bold" aria-hidden="true" className="text-accent" />
            <span className="font-mono text-sm font-semibold">Notification</span>
          </span>

          <span
            aria-live="polite"
            className="hidden items-center gap-1.5 rounded-full border border-line bg-muted px-2.5 py-1 text-xs sm:inline-flex"
          >
            <span
              aria-hidden="true"
              className={`h-2 w-2 rounded-full ${healthy === null ? 'bg-muted-fg' : healthy ? 'bg-accent' : 'bg-danger'}`}
            />
            {healthy === null ? 'Đang kiểm tra…' : healthy ? 'Hệ thống đang chạy' : 'Mất kết nối API'}
          </span>

          <div className="ml-auto flex items-center gap-2">
            <label className="flex items-center gap-1.5 rounded-lg border border-line bg-card px-2.5 h-9">
              <Key size={15} aria-hidden="true" className="shrink-0 text-muted-fg" />
              <input
                type="password"
                value={apiKey}
                onChange={(e) => onKeyChange(e.target.value)}
                placeholder="API key (cho thao tác ghi)"
                aria-label="API key dùng cho các thao tác ghi"
                autoComplete="off"
                className="w-36 bg-transparent text-xs outline-none placeholder:text-muted-fg sm:w-48"
              />
            </label>
            <button
              type="button"
              onClick={() => setTheme(theme === 'dark' ? 'light' : 'dark')}
              aria-label={theme === 'dark' ? 'Chuyển sang giao diện sáng' : 'Chuyển sang giao diện tối'}
              className="flex h-9 w-9 cursor-pointer items-center justify-center rounded-lg border border-line bg-card text-muted-fg hover:text-fg"
            >
              {theme === 'dark' ? <Sun size={16} aria-hidden="true" /> : <Moon size={16} aria-hidden="true" />}
            </button>
          </div>
        </header>

        {/* nav — mobile */}
        <nav className="flex gap-2 overflow-x-auto border-b border-line px-4 py-2 md:hidden" aria-label="Điều hướng chính">
          {NAV.map(({ to, label, icon: Icon, end }) => (
            <NavLink key={to} to={to} className={navLinkCls} end={end}>
              <Icon size={18} aria-hidden="true" />
              {label}
            </NavLink>
          ))}
        </nav>

        <main id="main" className="mx-auto w-full max-w-6xl flex-1 p-4 md:p-6">
          <Outlet />
        </main>
      </div>
    </div>
  );
}
