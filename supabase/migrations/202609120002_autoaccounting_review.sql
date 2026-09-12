-- Owner review metadata only. Never changes normalized bill/hash or ledger.
begin;

alter table public.autoaccounting_inbox
  add column if not exists expense_confirmed_hash text
    check (expense_confirmed_hash is null or expense_confirmed_hash ~ '^[0-9a-f]{64}$'),
  add column if not exists expense_confirmed_at timestamptz;

create or replace function public.autoaccounting_confirm_expense(
  p_user_id uuid, p_inbox_id uuid, p_expected_hash text
) returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_row public.autoaccounting_inbox%rowtype;
  v_bill jsonb;
  v_amount numeric;
  v_date timestamp;
  v_now timestamptz;
  v_allowed boolean;
begin
  if p_user_id is null or p_inbox_id is null or p_expected_hash is null
     or p_expected_hash !~ '^[0-9a-f]{64}$' then
    return jsonb_build_object('ok', false, 'code', 'INVALID_BILL');
  end if;
  -- Same per-user lock as receipt; acquire before the inbox row. This keeps
  -- updates ordered for the sync cursor without acquiring a source lock.
  perform pg_advisory_xact_lock(hashtextextended(p_user_id::text, 493));
  select * into v_row from public.autoaccounting_inbox
  where id = p_inbox_id and user_id = p_user_id for update;
  if not found then return jsonb_build_object('ok', false, 'code', 'INBOX_NOT_FOUND'); end if;
  if v_row.payload_hash <> p_expected_hash then
    return jsonb_build_object('ok', false, 'code', 'PAYLOAD_CHANGED');
  end if;

  v_bill := v_row.bill;
  -- Recognition facts remain immutable. Only an ordinary safe Expend or our
  -- exact completed outgoing-transfer marker may receive an owner override.
  v_allowed := (
    v_bill->>'type' = 'Expend' and v_bill->'eligible' = 'true'::jsonb
      and v_bill->>'reviewReason' = ''
  ) or (
    v_bill->>'merchant' = '微信转账'
      and v_bill->>'note' = '已完成转出，待确认用途'
      and v_bill->'eligible' = 'false'::jsonb
      and (
        (v_bill->>'type' = 'Transfer' and v_bill->>'reviewReason' = '非普通消费支出，需确认归属；可能涉及转账、退款或经营用途')
        or (v_bill->>'type' = 'Expend' and v_bill->>'reviewReason' = '可能涉及转账、退款或经营用途')
      )
  );
  if v_allowed is distinct from true
     or v_bill->>'currency' is distinct from 'CNY'
     or coalesce(v_bill->>'payment', '') not in ('微信', '支付宝')
     or jsonb_typeof(v_bill->'amount') is distinct from 'number'
     or coalesce(v_bill->>'date', '') !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}$' then
    return jsonb_build_object('ok', false, 'code', 'NOT_CONFIRMABLE');
  end if;
  begin
    v_amount := (v_bill->>'amount')::numeric;
    v_date := (v_bill->>'date')::timestamp;
  exception when others then
    return jsonb_build_object('ok', false, 'code', 'NOT_CONFIRMABLE');
  end;
  if v_amount <= 0 or v_amount > 100000000 or v_amount * 100 <> trunc(v_amount * 100)
     or to_char(v_date, 'YYYY-MM-DD"T"HH24:MI:SS') <> v_bill->>'date'
     or v_date < timestamp '2000-01-01' or v_date >= timestamp '2101-01-02'
     or v_date > (clock_timestamp() at time zone 'Asia/Shanghai') + interval '24 hours' then
    return jsonb_build_object('ok', false, 'code', 'NOT_CONFIRMABLE');
  end if;

  if v_row.expense_confirmed_hash = p_expected_hash and v_row.expense_confirmed_at is not null then
    return jsonb_build_object('ok', true, 'id', v_row.id, 'payloadHash', p_expected_hash,
      'expenseConfirmedAt', v_row.expense_confirmed_at, 'updated_at', v_row.updated_at);
  end if;
  v_now := greatest(clock_timestamp(), v_row.updated_at + interval '1 microsecond');
  update public.autoaccounting_inbox set expense_confirmed_hash = p_expected_hash,
    expense_confirmed_at = v_now, updated_at = v_now where id = v_row.id;
  return jsonb_build_object('ok', true, 'id', v_row.id, 'payloadHash', p_expected_hash,
    'expenseConfirmedAt', v_now, 'updated_at', v_now);
end;
$$;

revoke all on function public.autoaccounting_confirm_expense(uuid, uuid, text) from public, anon, authenticated;
grant execute on function public.autoaccounting_confirm_expense(uuid, uuid, text) to service_role;
comment on column public.autoaccounting_inbox.expense_confirmed_hash is 'Owner personal-expense confirmation, valid only when equal to current payload_hash. Excluded from normalized payload hash.';
commit;
