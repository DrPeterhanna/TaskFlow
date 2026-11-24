-- 0002: profiles bound to auth.users; profile row created by an auth trigger.
create table app.profiles (
  id uuid primary key references auth.users (id) on delete cascade,
  display_name text not null default '' check (char_length(display_name) <= 100),
  avatar_path text check (avatar_path is null or char_length(avatar_path) <= 300),
  locale text not null default 'en' check (locale in ('ar', 'en')),
  theme text not null default 'system' check (theme in ('system', 'light', 'dark')),
  timezone text check (timezone is null or char_length(timezone) <= 64),
  reminder_time time,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  row_version bigint not null default 1,
  change_xid xid8 not null default pg_current_xact_id(),
  deleted_at timestamptz
);
create trigger profiles_touch before insert or update on app.profiles
  for each row execute function app_private.touch_row();
create index profiles_change_idx on app.profiles (change_xid, id);

create function app_private.handle_new_user()
returns trigger language plpgsql security definer
set search_path = ''
as $$
begin
  insert into app.profiles (id, display_name)
  values (new.id, left(coalesce(new.raw_user_meta_data ->> 'display_name', ''), 100))
  on conflict (id) do nothing;
  return new;
end $$;

create trigger on_auth_user_created after insert on auth.users
  for each row execute function app_private.handle_new_user();

alter table app.profiles enable row level security;
alter table app.profiles force row level security;
grant select, insert, update, delete on app.profiles to app_rpc;
create policy profiles_rpc on app.profiles to app_rpc using (true) with check (true);

select app_private.finalize_ownership();
