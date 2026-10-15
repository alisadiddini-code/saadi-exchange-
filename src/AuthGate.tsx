import { useEffect, useRef, useState, type FormEvent } from 'react';
import { format } from 'date-fns';
import { KeyRound, LogIn, ShieldCheck, Trash2, UserPlus, X, Power, ArrowLeft } from 'lucide-react';
import App from './App';
import { admin, checkSession, clearSession, loadStoredSession, login, logout, type AdminUser, type LoginError, type Session } from './auth';
import { cn } from './lib/utils';

const LOGIN_ERRORS: Record<LoginError, string> = {
  not_allowed: 'Ин ном дар рӯйхати иҷозатдодашуда нест. Ба роҳбар муроҷиат кунед.',
  in_use: 'Бо ин ном ҳозир дар дастгоҳи дигар ворид шудаанд. Аввал аз он ҷо бароед ё ба роҳбар муроҷиат кунед.',
  bad_device: 'Хатои дастгоҳ. Саҳифаро аз нав кушоед.',
  network: 'Пайваст бо сервер нест. Интернетро санҷед ва дубора кӯшиш кунед.',
  not_setup: 'Системаи вуруд ҳанӯз дар база танзим нашудааст (login_setup.sql).',
};

const EXPIRED_MESSAGE = 'Вақти вуруд (12 соат) тамом шуд. Барои рӯзи нави корӣ дубора ворид шавед.';
const KICKED_MESSAGE = 'Вуруди шумо қатъ карда шуд. Дубора ворид шавед.';

// Мавзӯи торик/равшан пеш аз боркунии App ҳам риоя мешавад.
function applyStoredTheme() {
  try {
    document.documentElement.classList.toggle('dark', localStorage.getItem('saadi_theme') === 'dark');
  } catch {
    // ignore
  }
}

export default function AuthGate() {
  const [session, setSession] = useState<Session | null>(() => loadStoredSession());
  const [checking, setChecking] = useState(() => !!loadStoredSession());
  const [notice, setNotice] = useState<string | null>(null);
  const [screen, setScreen] = useState<'login' | 'admin'>('login');
  const sessionRef = useRef(session);
  sessionRef.current = session;

  useEffect(applyStoredTheme, []);

  const endSession = (message: string) => {
    clearSession();
    setSession(null);
    setNotice(message);
    setScreen('login');
    applyStoredTheme();
  };

  // Санҷиши аввал + ҳар дақиқа + ҳангоми бозгашт ба саҳифа.
  useEffect(() => {
    let cancelled = false;
    const verify = async () => {
      const s = sessionRef.current;
      if (!s) return;
      const result = await checkSession(s);
      if (cancelled || sessionRef.current?.token !== s.token) return;
      if (result === 'invalid') {
        endSession(new Date(s.expiresAt).getTime() <= Date.now() ? EXPIRED_MESSAGE : KICKED_MESSAGE);
      }
      setChecking(false);
    };
    void verify();
    const id = window.setInterval(verify, 60000);
    const onVisible = () => {
      if (document.visibilityState === 'visible') void verify();
    };
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      cancelled = true;
      window.clearInterval(id);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, [session?.token]);

  // Дақиқ дар лаҳзаи анҷоми 12 соат баромадан.
  useEffect(() => {
    if (!session) return;
    const ms = new Date(session.expiresAt).getTime() - Date.now();
    const id = window.setTimeout(() => endSession(EXPIRED_MESSAGE), Math.max(0, Math.min(ms, 2 ** 31 - 1)));
    return () => window.clearTimeout(id);
  }, [session?.expiresAt]);

  if (session && checking) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-surface-0 dark:bg-gray-950">
        <div className="text-sm text-ink-muted animate-pulse">Санҷиши вуруд…</div>
      </div>
    );
  }

  if (session) {
    return (
      <App
        sessionName={session.name}
        sessionExpiresAt={session.expiresAt}
        onLogout={async () => {
          await logout(session);
          setSession(null);
          setNotice(null);
          applyStoredTheme();
        }}
      />
    );
  }

  return (
    <div className="min-h-screen flex items-center justify-center px-4 py-10 bg-surface-0 dark:bg-gray-950">
      <div className="w-full max-w-md">
        <div className="flex items-center gap-3 mb-6 justify-center">
          <div className="w-12 h-12 rounded-full bg-brand-green text-white flex items-center justify-center text-xl font-bold shadow-md">
            S
          </div>
          <div>
            <div className="text-2xl font-bold text-brand-green-dark dark:text-emerald-400">Saadi Exchange</div>
            <div className="text-xs text-ink-muted">Системаи назорати гузаришҳои рӯзона</div>
          </div>
        </div>

        {screen === 'login' ? (
          <LoginCard
            notice={notice}
            onLoggedIn={(s) => {
              setNotice(null);
              setChecking(false);
              setSession(s);
            }}
            onOpenAdmin={() => setScreen('admin')}
          />
        ) : (
          <AdminCard onBack={() => setScreen('login')} />
        )}
      </div>
    </div>
  );
}

const cardClass =
  'bg-white dark:bg-gray-900 rounded-3xl border border-gray-100 dark:border-gray-800 shadow-xl p-6 space-y-4';
const inputClass =
  'w-full p-3 rounded-xl border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-950 text-gray-800 dark:text-gray-100 focus:ring-2 focus:ring-brand-green focus:border-transparent outline-none';
const primaryButton =
  'w-full py-3 bg-brand-green text-white rounded-xl font-semibold disabled:opacity-50 flex items-center justify-center gap-2';

function LoginCard({
  notice,
  onLoggedIn,
  onOpenAdmin,
}: {
  notice: string | null;
  onLoggedIn: (s: Session) => void;
  onOpenAdmin: () => void;
}) {
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!name.trim() || busy) return;
    setBusy(true);
    setError(null);
    const result = await login(name);
    setBusy(false);
    if (result.session) onLoggedIn(result.session);
    else setError(LOGIN_ERRORS[result.error || 'not_allowed']);
  };

  return (
    <form onSubmit={submit} className={cardClass}>
      <div>
        <h1 className="text-lg font-bold text-gray-800 dark:text-gray-100">Вуруд ба система</h1>
        <p className="text-sm text-ink-muted mt-1">Номи худро ворид кунед. Вуруд барои як рӯзи корӣ (12 соат) эътибор дорад.</p>
      </div>

      {notice && (
        <div className="text-sm rounded-xl px-3 py-2 bg-amber-50 text-amber-800 border border-amber-200 dark:bg-amber-500/10 dark:text-amber-300 dark:border-amber-500/30">
          {notice}
        </div>
      )}

      <input
        type="text"
        placeholder="Номи шумо"
        autoComplete="username"
        maxLength={40}
        className={inputClass}
        value={name}
        onChange={(e) => setName(e.target.value)}
        autoFocus
      />

      {error && (
        <div className="text-sm rounded-xl px-3 py-2 bg-red-50 text-red-700 border border-red-200 dark:bg-red-500/10 dark:text-red-300 dark:border-red-500/30">
          {error}
        </div>
      )}

      <button type="submit" disabled={!name.trim() || busy} className={primaryButton}>
        <LogIn className="w-4 h-4" />
        {busy ? 'Лутфан интизор шавед…' : 'Ворид шудан'}
      </button>

      <button
        type="button"
        onClick={onOpenAdmin}
        className="w-full text-xs text-ink-muted hover:text-brand-green flex items-center justify-center gap-1.5 pt-1"
      >
        <ShieldCheck className="w-3.5 h-3.5" />
        Идоракунии номҳо (барои роҳбар)
      </button>
    </form>
  );
}

const ADMIN_ERRORS: Record<string, string> = {
  bad_code: 'Рамзи идоракунӣ нодуруст аст.',
  bad_name: 'Ном бояд ҳадди ақал 2 ҳарф бошад.',
  network: 'Пайваст бо сервер нест.',
  not_setup: 'Системаи вуруд ҳанӯз дар база танзим нашудааст (login_setup.sql).',
};

function AdminCard({ onBack }: { onBack: () => void }) {
  // Рамз танҳо дар хотираи ҳамин саҳифа нигоҳ дошта мешавад.
  const [code, setCode] = useState('');
  const [unlocked, setUnlocked] = useState(false);
  const [users, setUsers] = useState<AdminUser[]>([]);
  const [newName, setNewName] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const refresh = async (c = code) => {
    const r = await admin.list(c);
    if (!r.ok) {
      setError(ADMIN_ERRORS[r.error] || r.error);
      return false;
    }
    setUsers(r.data.users);
    setError(null);
    return true;
  };

  const run = async (fn: () => Promise<{ ok: boolean; error?: string }>) => {
    setBusy(true);
    const r = await fn();
    if (!r.ok) setError(ADMIN_ERRORS[r.error || ''] || r.error || 'Хато');
    else await refresh();
    setBusy(false);
  };

  if (!unlocked) {
    return (
      <form
        className={cardClass}
        onSubmit={async (e) => {
          e.preventDefault();
          if (!code || busy) return;
          setBusy(true);
          const ok = await refresh(code);
          setBusy(false);
          if (ok) setUnlocked(true);
        }}
      >
        <div className="flex items-center gap-2">
          <button type="button" onClick={onBack} className="p-1.5 -ml-1.5 rounded-lg text-ink-muted hover:text-brand-green" aria-label="Бозгашт">
            <ArrowLeft className="w-4 h-4" />
          </button>
          <h1 className="text-lg font-bold text-gray-800 dark:text-gray-100">Идоракунии номҳо</h1>
        </div>
        <input
          type="password"
          placeholder="Рамзи идоракунӣ"
          autoComplete="current-password"
          className={inputClass}
          value={code}
          onChange={(e) => setCode(e.target.value)}
          autoFocus
        />
        {error && <div className="text-sm text-red-600 dark:text-red-400">{error}</div>}
        <button type="submit" disabled={!code || busy} className={primaryButton}>
          <KeyRound className="w-4 h-4" />
          {busy ? 'Санҷиш…' : 'Кушодан'}
        </button>
      </form>
    );
  }

  return (
    <div className={cardClass}>
      <div className="flex items-center gap-2">
        <button type="button" onClick={onBack} className="p-1.5 -ml-1.5 rounded-lg text-ink-muted hover:text-brand-green" aria-label="Бозгашт">
          <ArrowLeft className="w-4 h-4" />
        </button>
        <h1 className="text-lg font-bold text-gray-800 dark:text-gray-100">Номҳои иҷозатдодашуда</h1>
      </div>

      <form
        className="flex gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          const n = newName.trim();
          if (!n) return;
          void run(() => admin.addUser(code, n)).then(() => setNewName(''));
        }}
      >
        <input
          type="text"
          placeholder="Номи нав"
          maxLength={40}
          className={inputClass}
          value={newName}
          onChange={(e) => setNewName(e.target.value)}
        />
        <button
          type="submit"
          disabled={!newName.trim() || busy}
          className="shrink-0 px-4 rounded-xl bg-brand-green text-white disabled:opacity-50"
          aria-label="Илова кардан"
        >
          <UserPlus className="w-4 h-4" />
        </button>
      </form>

      {error && <div className="text-sm text-red-600 dark:text-red-400">{error}</div>}

      <div className="divide-y divide-gray-100 dark:divide-gray-800 -mx-2">
        {users.length === 0 && <div className="px-2 py-4 text-sm text-ink-muted text-center">Ҳоло ягон ном нест.</div>}
        {users.map((u) => {
          const online = !!u.session_expires;
          return (
            <div key={u.name} className="flex items-center gap-3 px-2 py-2.5">
              <span className={cn('w-2 h-2 rounded-full shrink-0', online ? 'bg-emerald-500' : 'bg-gray-300 dark:bg-gray-600')} />
              <div className="min-w-0 flex-1">
                <div className="text-sm font-semibold text-gray-800 dark:text-gray-100 truncate">{u.name}</div>
                <div className="text-[11px] text-ink-muted">
                  {online
                    ? `Ворид шуд ${format(new Date(u.session_started!), 'HH:mm')} · то ${format(new Date(u.session_expires!), 'HH:mm')}`
                    : 'Ворид нашудааст'}
                </div>
              </div>
              {online && (
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => void run(() => admin.endSession(code, u.name))}
                  title="Қатъ кардани вуруд (масалан, агар дастгоҳ иваз шуда бошад)"
                  className="p-2 rounded-lg text-amber-600 hover:bg-amber-50 dark:hover:bg-amber-500/10 disabled:opacity-50"
                  aria-label={`Қатъ кардани вуруди ${u.name}`}
                >
                  <Power className="w-4 h-4" />
                </button>
              )}
              <button
                type="button"
                disabled={busy}
                onClick={() => {
                  if (window.confirm(`«${u.name}» аз рӯйхат хориҷ карда шавад?`)) void run(() => admin.removeUser(code, u.name));
                }}
                className="p-2 rounded-lg text-red-500 hover:bg-red-50 dark:hover:bg-red-500/10 disabled:opacity-50"
                aria-label={`Хориҷ кардани ${u.name}`}
              >
                <Trash2 className="w-4 h-4" />
              </button>
            </div>
          );
        })}
      </div>

      <button
        type="button"
        onClick={() => {
          setUnlocked(false);
          setCode('');
          onBack();
        }}
        className="w-full text-xs text-ink-muted hover:text-brand-green flex items-center justify-center gap-1.5"
      >
        <X className="w-3.5 h-3.5" />
        Пӯшидани идоракунӣ
      </button>
    </div>
  );
}
