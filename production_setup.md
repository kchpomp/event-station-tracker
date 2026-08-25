# Event Station Tracker — Current Production Setup

## 1. Database: run in Supabase SQL Editor, in order

### 1a. Drop everything

```sql
drop trigger if exists on_auth_user_created on auth.users;
drop view if exists public.leaderboard;
drop function if exists public.get_leaderboard() cascade;
drop function if exists public.get_email_by_nickname(text) cascade;
drop function if exists public.scan_station(text) cascade;
drop function if exists public.handle_new_user() cascade;
drop function if exists public.set_updated_at() cascade;
drop table if exists public.station_visits cascade;
drop table if exists public.stations cascade;
drop table if exists public.profiles cascade;
drop table if exists public.events cascade;
drop type if exists event_status;
drop extension if exists "uuid-ossp";
```

### 1b. Create schema

```sql
create type event_status as enum ('planned', 'active', 'finished');

create table public.events (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  description text,
  start_datetime timestamptz,
  end_datetime timestamptz,
  status event_status not null default 'planned',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.stations (
  id uuid primary key default gen_random_uuid(),
  event_id uuid not null references public.events(id) on delete cascade,
  name text not null,
  description text,
  points integer not null default 0,
  qr_token text not null unique,
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  nickname text not null,
  display_name text,
  created_at timestamptz not null default now()
);

create unique index profiles_nickname_lower_idx on public.profiles (lower(nickname));

create table public.station_visits (
  id uuid primary key default gen_random_uuid(),
  participant_id uuid not null references auth.users(id) on delete cascade,
  station_id uuid not null references public.stations(id) on delete cascade,
  points_awarded integer not null,
  scanned_at timestamptz not null default now(),
  unique (participant_id, station_id)
);

create index on public.stations (event_id);
create index on public.station_visits (participant_id);
create index on public.station_visits (station_id);

create or replace function public.set_updated_at()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

create trigger events_set_updated_at
  before update on public.events
  for each row execute procedure public.set_updated_at();

create trigger stations_set_updated_at
  before update on public.stations
  for each row execute procedure public.set_updated_at();

alter table public.events enable row level security;
alter table public.stations enable row level security;
alter table public.profiles enable row level security;
alter table public.station_visits enable row level security;

revoke all on public.events from public, anon, authenticated;
revoke all on public.stations from public, anon, authenticated;
revoke all on public.profiles from public, anon, authenticated;
revoke all on public.station_visits from public, anon, authenticated;

grant select on public.events to authenticated;
grant select on public.stations to authenticated;
grant select, update on public.profiles to authenticated;
grant select on public.station_visits to authenticated;

create policy "authenticated users can read events"
  on public.events for select
  to authenticated
  using (true);

create policy "authenticated users can read stations"
  on public.stations for select
  to authenticated
  using (true);

create policy "users can read their own profile"
  on public.profiles for select
  to authenticated
  using ((select auth.uid()) = id);

create policy "users can update their own profile"
  on public.profiles for update
  to authenticated
  using ((select auth.uid()) = id)
  with check ((select auth.uid()) = id);

create policy "users can read their own visits"
  on public.station_visits for select
  to authenticated
  using ((select auth.uid()) = participant_id);

create or replace function public.scan_station(p_token text)
returns table (
  points_awarded integer,
  total_points bigint,
  stations_completed bigint,
  already_completed boolean
)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_station record;
  v_event record;
  v_participant uuid := auth.uid();
  v_points integer;
  v_already boolean := false;
begin
  if v_participant is null then
    raise exception 'not authenticated';
  end if;

  select * into v_station from public.stations where qr_token = p_token;
  if not found then
    raise exception 'invalid station token';
  end if;

  if not v_station.is_active then
    raise exception 'station is not active';
  end if;

  select * into v_event from public.events where id = v_station.event_id;
  if v_event.status <> 'active' then
    raise exception 'event is not active';
  end if;

  begin
    insert into public.station_visits (participant_id, station_id, points_awarded)
    values (v_participant, v_station.id, v_station.points);
    v_points := v_station.points;
  exception when unique_violation then
    v_already := true;
    v_points := 0;
  end;

  return query
  select
    v_points,
    (select coalesce(sum(sv.points_awarded), 0) from public.station_visits sv where sv.participant_id = v_participant),
    (select count(*) from public.station_visits sv where sv.participant_id = v_participant),
    v_already;
end;
$$;

revoke all on function public.scan_station(text) from public, anon;
grant execute on function public.scan_station(text) to authenticated;

create or replace function public.get_leaderboard()
returns table (
  participant_id uuid,
  display_name text,
  total_points bigint,
  stations_completed bigint
)
language sql
stable
security definer
set search_path = ''
as $$
  select
    p.id as participant_id,
    coalesce(p.display_name, 'Participant') as display_name,
    coalesce(sum(v.points_awarded), 0) as total_points,
    count(v.id) as stations_completed
  from public.profiles p
  left join public.station_visits v on v.participant_id = p.id
  group by p.id, p.display_name
  order by total_points desc;
$$;

revoke all on function public.get_leaderboard() from public, anon;
grant execute on function public.get_leaderboard() to authenticated;

create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  insert into public.profiles (id, nickname, display_name)
  values (
    new.id,
    new.raw_user_meta_data->>'nickname',
    coalesce(new.raw_user_meta_data->>'display_name', new.raw_user_meta_data->>'nickname')
  );
  return new;
end;
$$;

revoke all on function public.handle_new_user() from public, anon, authenticated;

create trigger on_auth_user_created
  after insert on auth.users
  for each row execute procedure public.handle_new_user();

create or replace function public.get_email_by_nickname(p_nickname text)
returns text
language sql
stable
security definer
set search_path = ''
as $$
  select u.email
  from auth.users u
  join public.profiles p on p.id = u.id
  where lower(p.nickname) = lower(p_nickname)
  limit 1;
$$;

revoke all on function public.get_email_by_nickname(text) from public, authenticated;
grant execute on function public.get_email_by_nickname(text) to anon;
```

### 1c. Seed a test event and station

```sql
with new_event as (
  insert into public.events (name, status)
  values ('Test Event', 'active')
  returning id
)
insert into public.stations (event_id, name, points, qr_token)
select id, 'Welcome Booth', 10, gen_random_uuid()::text from new_event
returning qr_token;
```

### 1d. Manually confirm a test account (only if email delivery isn't working yet)

```sql
update auth.users
set email_confirmed_at = now()
where email = 'your-test-email@example.com';
```

---

## 2. Frontend: `src/main.js`

Both nickname `<input>` elements need these attributes (login screen and register screen):

```html
<input id="nickname" placeholder="Никнейм" autocapitalize="off" autocorrect="off" spellcheck="false" />
```
```html
<input id="nickname" placeholder="Никнейм (для входа)" autocapitalize="off" autocorrect="off" spellcheck="false" />
```

## 3. Frontend: `src/supabaseClient.js`

```javascript
import { createClient } from '@supabase/supabase-js'

export const supabase = createClient(
  import.meta.env.VITE_SUPABASE_URL,
  import.meta.env.VITE_SUPABASE_ANON_KEY,
  { auth: { flowType: 'pkce' } }
)
```

## 4. Frontend: `vite.config.js`

```javascript
import { defineConfig } from 'vite'

export default defineConfig({
  base: '/event-station-tracker/',
})
```

---

## 5. GitHub repo settings

**Settings → Secrets and variables → Actions:**
- `VITE_SUPABASE_URL` = your Supabase project URL
- `VITE_SUPABASE_ANON_KEY` = your Supabase anon public key

**Settings → Pages → Build and deployment → Source:** GitHub Actions

---

## 6. Supabase dashboard settings

**Authentication → URL Configuration:**
- Site URL: `https://<you>.github.io/event-station-tracker/`
- Redirect URLs: same URL added here too

**Authentication → Email Templates → Confirm signup:**
```html
<h2>Подтвердите регистрацию</h2>
<p>Здравствуйте!</p>
<p>Чтобы завершить регистрацию и начать участвовать в мероприятии, подтвердите свой email, перейдя по ссылке ниже:</p>
<p><a href="{{ .ConfirmationURL }}">Подтвердить email</a></p>
<p>Если вы не регистрировались на этом мероприятии, просто проигнорируйте это письмо.</p>
```
Subject: `Подтвердите ваш email — Трекер станций мероприятия`

**Authentication → SMTP Settings:**
- Host: `smtp.yandex.com`
- Port: `587`
- Username: full mailbox address (e.g. `kchpomp@yandex.ru`) — not a project name
- Password: Yandex **app password** (Yandex ID → Security → App passwords), not the account password
- Sender email: same as username

---

## 7. After applying all of the above

1. Trigger a fresh GitHub Actions build (Actions → Run workflow) so the deployed frontend picks up any secret/code changes.
2. Register a new test account with a real, checkable email.
3. Confirm the email arrives, click it, confirm it lands on the dashboard.
4. Log out, log back in with the nickname.
5. Scan the seeded station's `qr_token`, confirm points are credited once and blocked on a repeat scan.
