-- Additive inbox only: never reads or writes public.ledger_snapshots.
-- Run once in the existing Supabase project, or apply with `supabase db push`.
begin;

create table if not exists public.autoaccounting_sources (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  label text not null check (char_length(label) between 1 and 60),
  token_hash text not null unique check (token_hash ~ '^[0-9a-f]{64}$'),
  created_at timestamptz not null default now(),
  last_received_at timestamptz,
  revoked_at timestamptz
);
create index if not exists autoaccounting_sources_user_idx on public.autoaccounting_sources(user_id);

create table if not exists public.autoaccounting_inbox (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  source_id uuid not null references public.autoaccounting_sources(id) on delete cascade,
  upstream_id text not null check (upstream_id ~ '^[1-9][0-9]{0,18}$'),
  payload_hash text not null check (payload_hash ~ '^[0-9a-f]{64}$'),
  bill jsonb not null check (jsonb_typeof(bill) = 'object' and octet_length(bill::text) <= 16384),
  first_received_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (source_id, upstream_id)
);
create index if not exists autoaccounting_inbox_user_updated_idx on public.autoaccounting_inbox(user_id, updated_at, id);

alter table public.autoaccounting_sources enable row level security;
alter table public.autoaccounting_inbox enable row level security;
revoke all on public.autoaccounting_sources, public.autoaccounting_inbox from public, anon, authenticated;
-- Do NOT grant SELECT on the whole sources table: token hashes stay server-only.
grant select (id, user_id, label, created_at, last_received_at, revoked_at) on public.autoaccounting_sources to authenticated;
grant select on public.autoaccounting_inbox to authenticated;
grant all on public.autoaccounting_sources, public.autoaccounting_inbox to service_role;
drop policy if exists autoaccounting_sources_read_own on public.autoaccounting_sources;
create policy autoaccounting_sources_read_own on public.autoaccounting_sources for select to authenticated using ((select auth.uid()) = user_id);
drop policy if exists autoaccounting_inbox_read_own on public.autoaccounting_inbox;
create policy autoaccounting_inbox_read_own on public.autoaccounting_inbox for select to authenticated using ((select auth.uid()) = user_id);

-- Not exposed through PostgREST. Counts every authorized upload, even duplicates.
create schema if not exists autoaccounting_private;
revoke all on schema autoaccounting_private from public, anon, authenticated;
create table if not exists autoaccounting_private.source_windows (
  source_id uuid primary key references public.autoaccounting_sources(id) on delete cascade,
  window_start timestamptz not null,
  requests integer not null
);
revoke all on autoaccounting_private.source_windows from public, anon, authenticated;

create or replace function public.autoaccounting_create_source(p_user_id uuid, p_label text, p_token_hash text)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_source public.autoaccounting_sources%rowtype;
begin
  if p_user_id is null or char_length(btrim(p_label)) not between 1 and 60 or p_token_hash !~ '^[0-9a-f]{64}$' then
    return jsonb_build_object('ok', false, 'code', 'INVALID_DEVICE');
  end if;
  perform pg_advisory_xact_lock(hashtextextended(p_user_id::text, 493));
  if (select count(*) from public.autoaccounting_sources where user_id = p_user_id and revoked_at is null) >= 20 then
    return jsonb_build_object('ok', false, 'code', 'DEVICE_LIMIT');
  end if;
  insert into public.autoaccounting_sources(user_id, label, token_hash)
  values (p_user_id, btrim(p_label), p_token_hash) returning * into v_source;
  return jsonb_build_object('ok', true, 'source', jsonb_build_object(
    'id', v_source.id, 'label', v_source.label, 'created_at', v_source.created_at,
    'last_received_at', v_source.last_received_at, 'revoked_at', v_source.revoked_at));
end;
$$;

create or replace function public.autoaccounting_receive_bill(p_token_hash text, p_upstream_id text, p_payload_hash text, p_bill jsonb)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_source public.autoaccounting_sources%rowtype;
  v_existing public.autoaccounting_inbox%rowtype;
  v_saved public.autoaccounting_inbox%rowtype;
  v_now timestamptz;
  v_minute timestamptz := date_trunc('minute', now());
  v_count integer;
begin
  if p_token_hash is null or p_token_hash !~ '^[0-9a-f]{64}$' then
    return jsonb_build_object('ok', false, 'code', 'INVALID_TOKEN');
  end if;
  -- Source row lock serializes token rotation/revocation with receipt.
  select * into v_source from public.autoaccounting_sources
  where token_hash = p_token_hash and revoked_at is null for update;
  if not found then return jsonb_build_object('ok', false, 'code', 'INVALID_TOKEN'); end if;
  if p_upstream_id is null or p_upstream_id !~ '^[1-9][0-9]{0,18}$'
     or p_payload_hash is null or p_payload_hash !~ '^[0-9a-f]{64}$'
     or p_bill is null or jsonb_typeof(p_bill) <> 'object' or octet_length(p_bill::text) > 16384 then
    return jsonb_build_object('ok', false, 'code', 'INVALID_BILL');
  end if;
  insert into autoaccounting_private.source_windows(source_id, window_start, requests)
  values (v_source.id, v_minute, 1)
  on conflict (source_id) do update set
    requests = case when autoaccounting_private.source_windows.window_start = excluded.window_start
                    then autoaccounting_private.source_windows.requests + 1 else 1 end,
    window_start = excluded.window_start
  returning requests into v_count;
  if v_count > 1000 then return jsonb_build_object('ok', false, 'code', 'RATE_LIMIT'); end if;

  -- Serialize the per-user cap across multiple sources, without touching ledger.
  perform pg_advisory_xact_lock(hashtextextended(v_source.user_id::text, 493));
  -- Timestamp after lock acquisition: transaction-start timestamps can go
  -- backwards when concurrent uploads queue, breaking the client's cursor.
  v_now := clock_timestamp();
  select * into v_existing from public.autoaccounting_inbox
  where source_id = v_source.id and upstream_id = p_upstream_id;
  if found then
    if v_existing.payload_hash = p_payload_hash then
      update public.autoaccounting_sources set last_received_at = v_now where id = v_source.id;
      return jsonb_build_object('ok', true, 'id', v_existing.id, 'duplicate', true,
        'updated', false, 'updated_at', v_existing.updated_at);
    end if;
    v_now := greatest(v_now, v_existing.updated_at + interval '1 microsecond');
    update public.autoaccounting_inbox set payload_hash = p_payload_hash, bill = p_bill, updated_at = v_now
    where id = v_existing.id returning * into v_saved;
    update public.autoaccounting_sources set last_received_at = v_now where id = v_source.id;
    return jsonb_build_object('ok', true, 'id', v_saved.id, 'duplicate', false,
      'updated', true, 'updated_at', v_saved.updated_at);
  end if;
  if (select count(*) from public.autoaccounting_inbox where user_id = v_source.user_id) >= 50000 then
    return jsonb_build_object('ok', false, 'code', 'INBOX_LIMIT');
  end if;
  insert into public.autoaccounting_inbox(user_id, source_id, upstream_id, payload_hash, bill, first_received_at, updated_at)
  values (v_source.user_id, v_source.id, p_upstream_id, p_payload_hash, p_bill, v_now, v_now) returning * into v_saved;
  update public.autoaccounting_sources set last_received_at = v_now where id = v_source.id;
  return jsonb_build_object('ok', true, 'id', v_saved.id, 'duplicate', false,
    'updated', false, 'updated_at', v_saved.updated_at);
end;
$$;

revoke all on function public.autoaccounting_create_source(uuid, text, text) from public, anon, authenticated;
revoke all on function public.autoaccounting_receive_bill(text, text, text, jsonb) from public, anon, authenticated;
grant execute on function public.autoaccounting_create_source(uuid, text, text) to service_role;
grant execute on function public.autoaccounting_receive_bill(text, text, text, jsonb) to service_role;

comment on column public.autoaccounting_inbox.upstream_id is 'AutoAccounting local database id; NOT WeChat/Alipay transaction id. Scope is one source installation.';
comment on table public.autoaccounting_inbox is 'One-way normalized upload inbox. No deletion mirroring and no direct ledger snapshot mutation.';
commit;
