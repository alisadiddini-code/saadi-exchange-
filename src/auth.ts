import { supabase } from './lib/supabase';

// Вуруд бо номҳои иҷозатдодашуда. Қоидаҳо дар база (supabase/login_setup.sql)
// иҷро мешаванд: рӯйхати номҳо, 12 соат эътибор, як ном = як дастгоҳ.

export type Session = { token: string; name: string; expiresAt: string };

export type LoginError = 'not_allowed' | 'in_use' | 'bad_device' | 'network' | 'not_setup';

export type AdminUser = {
  name: string;
  active: boolean;
  session_started: string | null;
  session_expires: string | null;
};

const SESSION_KEY = 'saadi_session';
const DEVICE_KEY = 'saadi_device_id';

function newId() {
  return typeof crypto !== 'undefined' && 'randomUUID' in crypto
    ? crypto.randomUUID()
    : `d-${Date.now()}-${Math.random().toString(36).slice(2)}-${Math.random().toString(36).slice(2)}`;
}

// ID-и доимии ин браузер/дастгоҳ.
let memoryDeviceId: string | null = null;
export function getDeviceId() {
  try {
    let id = localStorage.getItem(DEVICE_KEY);
    if (!id) {
      id = newId();
      localStorage.setItem(DEVICE_KEY, id);
    }
    return id;
  } catch {
    memoryDeviceId ??= newId();
    return memoryDeviceId;
  }
}

export function loadStoredSession(): Session | null {
  try {
    const raw = localStorage.getItem(SESSION_KEY);
    if (!raw) return null;
    const s = JSON.parse(raw) as Session;
    if (!s?.token || !s?.name || !s?.expiresAt) return null;
    if (new Date(s.expiresAt).getTime() <= Date.now()) return null;
    return s;
  } catch {
    return null;
  }
}

function storeSession(s: Session | null) {
  try {
    if (s) localStorage.setItem(SESSION_KEY, JSON.stringify(s));
    else localStorage.removeItem(SESSION_KEY);
  } catch {
    // localStorage дастрас нест
  }
}

function isMissingFunction(error: { code?: string; message?: string } | null) {
  return !!error && (error.code === 'PGRST202' || /could not find the function/i.test(error.message || ''));
}

export async function login(name: string): Promise<{ session?: Session; error?: LoginError }> {
  const { data, error } = await supabase.rpc('app_login', { p_name: name, p_device: getDeviceId() });
  if (error) return { error: isMissingFunction(error) ? 'not_setup' : 'network' };
  if (!data?.ok) return { error: (data?.error as LoginError) || 'not_allowed' };
  const session: Session = { token: data.token, name: data.name, expiresAt: data.expires_at };
  storeSession(session);
  return { session };
}

// 'valid' | 'invalid' | 'unknown' (шабака нест — вурудро нигоҳ медорем)
export async function checkSession(s: Session): Promise<'valid' | 'invalid' | 'unknown'> {
  if (new Date(s.expiresAt).getTime() <= Date.now()) return 'invalid';
  const { data, error } = await supabase.rpc('app_check_session', { p_token: s.token, p_device: getDeviceId() });
  if (error) return 'unknown';
  return data?.ok ? 'valid' : 'invalid';
}

export async function logout(s: Session | null) {
  storeSession(null);
  if (s) await supabase.rpc('app_logout', { p_token: s.token, p_device: getDeviceId() });
}

export function clearSession() {
  storeSession(null);
}

async function adminCall<T = any>(fn: string, args: Record<string, unknown>) {
  const { data, error } = await supabase.rpc(fn, args);
  if (error) return { ok: false as const, error: isMissingFunction(error) ? 'not_setup' : 'network' };
  if (!data?.ok) return { ok: false as const, error: String(data?.error || 'error') };
  return { ok: true as const, data: data as T };
}

export const admin = {
  list: (code: string) => adminCall<{ users: AdminUser[] }>('app_admin_list', { p_code: code }),
  addUser: (code: string, name: string) => adminCall('app_admin_add_user', { p_code: code, p_name: name }),
  removeUser: (code: string, name: string) => adminCall('app_admin_remove_user', { p_code: code, p_name: name }),
  endSession: (code: string, name: string) => adminCall('app_admin_end_session', { p_code: code, p_name: name }),
};
