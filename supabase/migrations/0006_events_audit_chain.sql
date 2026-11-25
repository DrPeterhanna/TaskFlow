-- 0006: append-only org events with a per-org hash chain (EVENT_AND_AUDIT_MODEL).
-- Guarantee: tamper EVIDENCE against roles that cannot rewrite the whole chain.
-- A privileged database operator can recompute the chain. Not tamper-proof.
create sequence app_private.events_id_seq;

create table app.events (
  id bigint primary key,
  org_id uuid not null references app.organizations (id),
  occurred_at timestamptz not null default now(),
  actor_membership_id uuid,
  actor_kind text not null check (actor_kind in ('user', 'system')),
  kind text not null check (kind ~ '^[a-z_]+\.[a-z_]+$'),
  subject_type text not null,
  subject_id uuid,
  task_id uuid,
  payload jsonb not null default '{}'::jsonb check (jsonb_typeof(payload) = 'object'),
  request_op_id uuid,
  prev_hash text not null check (prev_hash ~ '^[0-9a-f]{64}$'),
  hash text not null check (hash ~ '^[0-9a-f]{64}$'),
  unique (org_id, prev_hash),    -- a fork in the chain is rejected by the database
  foreign key (actor_membership_id, org_id) references app.memberships (id, org_id)
);
create index events_org_idx on app.events (org_id, id);
create index events_subject_idx on app.events (subject_type, subject_id);

create function app_private.event_hash(
  p_prev text, p_org uuid, p_id bigint, p_kind text, p_payload jsonb, p_at timestamptz)
returns text language sql immutable
set search_path = ''
as $$
  select pg_catalog.encode(
    pg_catalog.sha256(pg_catalog.convert_to(
      p_prev || '|' || p_org::text || '|' || p_id::text || '|' || p_kind || '|' || p_payload::text || '|' ||
      pg_catalog.to_char(p_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'), 'UTF8')),
    'hex')
$$;

-- Only write path. Serializes per org with an advisory lock so prev_hash reads are ordered.
create function app_private.emit_event(
  p_org uuid, p_actor uuid, p_kind text, p_subject_type text, p_subject_id uuid,
  p_payload jsonb default '{}'::jsonb, p_op_id uuid default null)
returns bigint language plpgsql
set search_path = ''
as $$
declare
  v_prev text;
  v_id bigint;
  v_at timestamptz := pg_catalog.clock_timestamp();
  v_payload jsonb := jsonb_build_object('v', 1) || coalesce(p_payload, '{}'::jsonb);
begin
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('org-events:' || p_org::text, 0));
  select e.hash into v_prev from app.events e where e.org_id = p_org order by e.id desc limit 1;
  v_prev := coalesce(v_prev, pg_catalog.repeat('0', 64));
  v_id := pg_catalog.nextval('app_private.events_id_seq');
  insert into app.events (id, org_id, occurred_at, actor_membership_id, actor_kind, kind,
                          subject_type, subject_id, payload, request_op_id, prev_hash, hash)
  values (v_id, p_org, v_at, p_actor, case when p_actor is null then 'system' else 'user' end,
          p_kind, p_subject_type, p_subject_id, v_payload, p_op_id, v_prev,
          app_private.event_hash(v_prev, p_org, v_id, p_kind, v_payload, v_at));
  return v_id;
end $$;

create function app_private.events_immutable()
returns trigger language plpgsql
set search_path = ''
as $$
begin
  raise exception 'events are append-only' using errcode = '42501';
end $$;
create trigger events_no_update before update or delete on app.events
  for each row execute function app_private.events_immutable();
create trigger events_no_truncate before truncate on app.events
  for each statement execute function app_private.events_immutable();

-- Recomputes the chain for one org. Returns the first broken event id, or null if intact.
create function app_private.verify_chain(p_org uuid)
returns bigint language plpgsql stable
set search_path = ''
as $$
declare r record; v_prev text := pg_catalog.repeat('0', 64);
begin
  for r in select * from app.events where org_id = p_org order by id loop
    if r.prev_hash <> v_prev
       or r.hash <> app_private.event_hash(r.prev_hash, r.org_id, r.id, r.kind, r.payload, r.occurred_at) then
      return r.id;
    end if;
    v_prev := r.hash;
  end loop;
  return null;
end $$;

alter table app.events enable row level security;
alter table app.events force row level security;
-- app_rpc may only read and insert: updates and deletes are revoked (and trigger-blocked).
grant select, insert on app.events to app_rpc;
create policy events_rpc_read on app.events for select to app_rpc using (true);
create policy events_rpc_insert on app.events for insert to app_rpc with check (true);
grant usage on sequence app_private.events_id_seq to app_rpc;

select app_private.finalize_ownership();
