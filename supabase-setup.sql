-- 账清云同步数据库初始化脚本
-- 在 Supabase Dashboard → SQL Editor 中完整运行一次。

create table if not exists public.ledger_snapshots (
  user_id uuid primary key references auth.users(id) on delete cascade,
  payload jsonb not null default '{}'::jsonb,
  client_updated_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table public.ledger_snapshots enable row level security;

grant select, insert, update, delete on public.ledger_snapshots to authenticated;

drop policy if exists "Users read own ledger" on public.ledger_snapshots;
create policy "Users read own ledger"
on public.ledger_snapshots for select
to authenticated
using ((select auth.uid()) = user_id);

drop policy if exists "Users insert own ledger" on public.ledger_snapshots;
create policy "Users insert own ledger"
on public.ledger_snapshots for insert
to authenticated
with check ((select auth.uid()) = user_id);

drop policy if exists "Users update own ledger" on public.ledger_snapshots;
create policy "Users update own ledger"
on public.ledger_snapshots for update
to authenticated
using ((select auth.uid()) = user_id)
with check ((select auth.uid()) = user_id);

drop policy if exists "Users delete own ledger" on public.ledger_snapshots;
create policy "Users delete own ledger"
on public.ledger_snapshots for delete
to authenticated
using ((select auth.uid()) = user_id);

-- RLS 保证每个账号只能读取和修改自己的账本。
