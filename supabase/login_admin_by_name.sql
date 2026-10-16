-- =====================================================================
-- Saadi Exchange — панели идоракунӣ барои корбари ALONE
-- (пас аз login_setup.sql иҷро кунед; иҷрои такрорӣ бехатар аст)
--
--   * ALONE пас аз вуруд панели идоракуниро дар дохили сайт мебинад
--   * рамзи идоракунӣ ҳамчун роҳи эҳтиётӣ дар саҳифаи вуруд мемонад
--   * корбари идоракунанда аз рӯйхат хориҷ карда намешавад
-- =====================================================================

alter table public.app_users add column if not exists is_admin boolean not null default false;
update public.app_users set is_admin = (name_key = 'alone');

-- Вуруд — акнун is_admin-ро ҳам бармегардонад
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
  for update;

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
      return json_build_object('ok', true, 'token', s.token, 'name', u.name, 'expires_at', s.expires_at, 'is_admin', u.is_admin);
    end if;
    return json_build_object('ok', false, 'error', 'in_use');
  end if;

  insert into public.app_sessions (user_name, device_id, expires_at)
  values (u.name, p_device, now() + interval '12 hours')
  returning * into s;

  return json_build_object('ok', true, 'token', s.token, 'name', u.name, 'expires_at', s.expires_at, 'is_admin', u.is_admin);
end;
$$;

create or replace function public.app_check_session(p_token uuid, p_device text)
returns json
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  v_name text;
  v_expires timestamptz;
  admin boolean;
begin
  select ss.user_name, ss.expires_at, uu.is_admin into v_name, v_expires, admin
  from public.app_sessions ss
  join public.app_users uu on uu.name = ss.user_name and uu.active
  where ss.token = p_token
    and ss.device_id = p_device
    and ss.ended_at is null
    and ss.expires_at > now();

  if not found then
    return json_build_object('ok', false);
  end if;
  return json_build_object('ok', true, 'name', v_name, 'expires_at', v_expires, 'is_admin', admin);
end;
$$;

-- Иҷозати идоракунӣ: ё рамзи идоракунӣ, ё вуруди фаъоли корбари идоракунанда.
-- Вуруд ба шакли 'session:<token>:<device>' фиристода мешавад.
create or replace function public.app_admin_ok(p_code text)
returns boolean
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  h text;
  parts text[];
begin
  if p_code like 'session:%' then
    parts := string_to_array(p_code, ':');
    if array_length(parts, 1) = 3
       and parts[2] ~ '^[0-9a-f-]{36}$'
       and exists (
         select 1
         from public.app_sessions s
         join public.app_users u on u.name = s.user_name and u.active and u.is_admin
         where s.token = parts[2]::uuid
           and s.device_id = parts[3]
           and s.ended_at is null
           and s.expires_at > now()
       ) then
      return true;
    end if;
    perform pg_sleep(0.6);
    return false;
  end if;

  select value into h from public.app_settings where key = 'admin_code_hash';
  if h is null or p_code is null or crypt(p_code, h) <> h then
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
      'is_admin', u.is_admin,
      'session_started', s.created_at,
      'session_expires', s.expires_at
    ) order by u.is_admin desc, u.name)
    from public.app_users u
    left join lateral (
      select created_at, expires_at from public.app_sessions
      where user_name = u.name and ended_at is null and expires_at > now()
      order by created_at desc limit 1
    ) s on true
  ), '[]'::json));
end;
$$;

-- Корбари идоракунанда хориҷ карда намешавад (то худатонро қуфл накунед)
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
  if exists (select 1 from public.app_users where name = p_name and is_admin) then
    return json_build_object('ok', false, 'error', 'is_admin');
  end if;
  delete from public.app_users where name = p_name;
  return json_build_object('ok', true);
end;
$$;

revoke execute on function public.app_admin_ok(text) from public, anon, authenticated;

notify pgrst, 'reload schema';

-- Санҷиш: бояд ALONE | true нишон диҳад
select name, is_admin from public.app_users order by is_admin desc, name;
