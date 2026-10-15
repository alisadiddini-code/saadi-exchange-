-- =====================================================================
-- Saadi Exchange — вуруд бо номҳои иҷозатдодашуда
--   * танҳо номҳое, ки роҳбар илова мекунад, ворид шуда метавонанд
--   * ҳар вуруд 12 соат (як рӯзи корӣ) эътибор дорад
--   * бо ҳар ном дар як вақт танҳо як дастгоҳ
--
-- Истифода: ин файлро пурра дар Supabase → SQL Editor иҷро кунед.
-- ПЕШ АЗ ИҶРО 'CHANGE_ME' -ро (дар поён) ба рамзи идоракунии худ иваз кунед.
-- Иҷрои такрорӣ бехатар аст (рамзи идоракуниро нав мекунад).
-- =====================================================================

create extension if not exists pgcrypto with schema extensions;

-- Номҳои иҷозатдодашуда
create table if not exists public.app_users (
  name       text primary key,
  name_key   text generated always as (lower(btrim(name))) stored unique,
  active     boolean not null default true,
  created_at timestamptz not null default now()
);

-- Вурудҳо (сессияҳо)
create table if not exists public.app_sessions (
  token      uuid primary key default gen_random_uuid(),
  user_name  text not null references public.app_users(name) on delete cascade on update cascade,
  device_id  text not null,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null,
  ended_at   timestamptz
);
create index if not exists app_sessions_user_open_idx
  on public.app_sessions (user_name) where ended_at is null;

-- Танзимот (рамзи идоракунӣ ба таври hash нигоҳ дошта мешавад)
create table if not exists public.app_settings (
  key   text primary key,
  value text not null
);

-- Ба ин ҷадвалҳо мустақиман аз браузер дастрасӣ нест — танҳо тавассути функсияҳои поён.
alter table public.app_users    enable row level security;
alter table public.app_sessions enable row level security;
alter table public.app_settings enable row level security;
revoke all on public.app_users, public.app_sessions, public.app_settings from anon, authenticated;

-- >>> РАМЗИ ИДОРАКУНИРО ДАР ИН ҶО ИВАЗ КУНЕД <<<
insert into public.app_settings (key, value)
values ('admin_code_hash', extensions.crypt('CHANGE_ME', extensions.gen_salt('bf')))
on conflict (key) do update set value = excluded.value;


-- ---------------------------------------------------------------------
-- Вуруд
-- ---------------------------------------------------------------------
create or replace function public.app_login(p_name text, p_device text)
returns json
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  u public.app_users;
  s public.app_sessions;
begin
  if p_device is null or length(p_device) < 8 then
    return json_build_object('ok', false, 'error', 'bad_device');
  end if;

  select * into u from public.app_users
  where name_key = lower(btrim(coalesce(p_name, ''))) and active
  for update;  -- ду вуруди ҳамзамон бо як ном якдигарро намегузаранд

  if not found then
    perform pg_sleep(0.4);
    return json_build_object('ok', false, 'error', 'not_allowed');
  end if;

  select * into s from public.app_sessions
  where user_name = u.name and ended_at is null and expires_at > now()
  order by created_at desc
  limit 1;

  if found then
    if s.device_id = p_device then
      -- ҳамон дастгоҳ дубора ворид мешавад — ҳамон вуруд бармегардад
      return json_build_object('ok', true, 'token', s.token, 'name', u.name, 'expires_at', s.expires_at);
    end if;
    return json_build_object('ok', false, 'error', 'in_use');
  end if;

  insert into public.app_sessions (user_name, device_id, expires_at)
  values (u.name, p_device, now() + interval '12 hours')
  returning * into s;

  return json_build_object('ok', true, 'token', s.token, 'name', u.name, 'expires_at', s.expires_at);
end;
$$;

-- Санҷиши эътибори вуруд
create or replace function public.app_check_session(p_token uuid, p_device text)
returns json
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  s public.app_sessions;
begin
  select ss.* into s
  from public.app_sessions ss
  join public.app_users uu on uu.name = ss.user_name and uu.active
  where ss.token = p_token
    and ss.device_id = p_device
    and ss.ended_at is null
    and ss.expires_at > now();

  if not found then
    return json_build_object('ok', false);
  end if;
  return json_build_object('ok', true, 'name', s.user_name, 'expires_at', s.expires_at);
end;
$$;

-- Баромадан
create or replace function public.app_logout(p_token uuid, p_device text)
returns void
language sql
security definer
set search_path = public, extensions
as $$
  update public.app_sessions
  set ended_at = now()
  where token = p_token and device_id = p_device and ended_at is null;
$$;


-- ---------------------------------------------------------------------
-- Идоракунӣ (бо рамзи идоракунӣ)
-- ---------------------------------------------------------------------
create or replace function public.app_admin_ok(p_code text)
returns boolean
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  h text;
begin
  select value into h from public.app_settings where key = 'admin_code_hash';
  if h is null or p_code is null or extensions.crypt(p_code, h) <> h then
    perform pg_sleep(0.6);
    return false;
  end if;
  return true;
end;
$$;

create or replace function public.app_admin_list(p_code text)
returns json
language plpgsql
security definer
set search_path = public, extensions
as $$
begin
  if not public.app_admin_ok(p_code) then
    return json_build_object('ok', false, 'error', 'bad_code');
  end if;

  return json_build_object('ok', true, 'users', coalesce((
    select json_agg(json_build_object(
      'name', u.name,
      'active', u.active,
      'session_started', s.created_at,
      'session_expires', s.expires_at
    ) order by u.name)
    from public.app_users u
    left join lateral (
      select created_at, expires_at from public.app_sessions
      where user_name = u.name and ended_at is null and expires_at > now()
      order by created_at desc limit 1
    ) s on true
  ), '[]'::json));
end;
$$;

create or replace function public.app_admin_add_user(p_code text, p_name text)
returns json
language plpgsql
security definer
set search_path = public, extensions
as $$
begin
  if not public.app_admin_ok(p_code) then
    return json_build_object('ok', false, 'error', 'bad_code');
  end if;
  if length(btrim(coalesce(p_name, ''))) < 2 then
    return json_build_object('ok', false, 'error', 'bad_name');
  end if;
  insert into public.app_users (name) values (btrim(p_name))
  on conflict (name_key) do update set active = true;
  return json_build_object('ok', true);
end;
$$;

create or replace function public.app_admin_remove_user(p_code text, p_name text)
returns json
language plpgsql
security definer
set search_path = public, extensions
as $$
begin
  if not public.app_admin_ok(p_code) then
    return json_build_object('ok', false, 'error', 'bad_code');
  end if;
  delete from public.app_users where name = p_name;  -- вурудҳояш ҳам нест мешаванд
  return json_build_object('ok', true);
end;
$$;

-- Вуруди ҷориро қатъ кардан (масалан, агар дастгоҳ гум шуда бошад)
create or replace function public.app_admin_end_session(p_code text, p_name text)
returns json
language plpgsql
security definer
set search_path = public, extensions
as $$
begin
  if not public.app_admin_ok(p_code) then
    return json_build_object('ok', false, 'error', 'bad_code');
  end if;
  update public.app_sessions set ended_at = now()
  where user_name = p_name and ended_at is null;
  return json_build_object('ok', true);
end;
$$;

-- Танҳо функсияҳои зарурӣ барои браузер кушодаанд
revoke execute on function public.app_admin_ok(text) from public, anon, authenticated;
grant execute on function
  public.app_login(text, text),
  public.app_check_session(uuid, text),
  public.app_logout(uuid, text),
  public.app_admin_list(text),
  public.app_admin_add_user(text, text),
  public.app_admin_remove_user(text, text),
  public.app_admin_end_session(text, text)
to anon, authenticated;
