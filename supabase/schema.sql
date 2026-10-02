-- ===========================================================================
-- University E-Voting System — Supabase (Postgres) schema
--
-- Run this once in the Supabase SQL Editor, or with:
--   psql "$SUPABASE_DB_URL" -v ON_ERROR_STOP=1 -f supabase/schema.sql
--
-- It is a faithful translation of the SQLite schema in src/db.js. Two
-- deliberate departures from SQLite, both required by Postgres:
--
--   1. Flag columns (verified, is_active, is_abstain, is_mandatory,
--      results_public) are smallint 0/1, NOT boolean. SQLite has no boolean
--      type, so the existing routes, JSON responses and frontend all read
--      these as 0/1. Switching to boolean would silently change every API
--      response shape.
--   2. users.auth_id links to Supabase's own auth.users table. The local
--      users table is retained because it holds voter/admin/superadmin roles,
--      which the voting logic and the admin console both read.
--
-- The secret-ballot design is preserved exactly: `ballots` has no voter
-- column and `vote_receipts` stores no choices. Neither table can be joined to
-- reveal how anyone voted.
-- ===========================================================================

begin;

create schema if not exists public;

-- --- Identity ---------------------------------------------------------------

create table if not exists public.users (
  id            integer generated always as identity primary key,
  -- Set null rather than cascade on delete: deleting an auth user must never
  -- erase the receipt proving they voted. See handle_auth_user_delete().
  auth_id       uuid unique references auth.users(id) on delete set null,
  student_id    text unique,
  name          text not null,
  email         text unique not null,
  -- Unused once Supabase Auth owns passwords. Kept non-null so existing
  -- INSERTs that still pass a bcrypt hash keep working during the migration.
  password_hash text not null default '',
  role          text not null default 'voter'
                  check (role in ('voter', 'admin', 'superadmin')),
  faculty       text not null default '',
  department    text not null default '',
  level         text not null default '',
  verified      smallint not null default 0 check (verified in (0, 1)),
  is_active     smallint not null default 1 check (is_active in (0, 1)),
  created_at    timestamptz not null default now()
);

-- Superseded by Supabase Auth (which owns email confirmation and recovery).
-- Retained so the not-yet-migrated register/verify/reset routes in server.js
-- keep functioning during the transition.
create table if not exists public.email_verifications (
  id          integer generated always as identity primary key,
  user_id     integer not null references public.users(id) on delete cascade,
  token       text unique not null,
  expires_at  text not null,
  used        smallint not null default 0 check (used in (0, 1))
);

create table if not exists public.password_resets (
  id          integer generated always as identity primary key,
  user_id     integer not null references public.users(id) on delete cascade,
  token_hash  text unique not null,
  expires_at  text not null,
  used        smallint not null default 0 check (used in (0, 1))
);

-- --- Elections --------------------------------------------------------------

create table if not exists public.elections (
  id              integer generated always as identity primary key,
  title           text not null,
  description     text not null default '',
  instructions    text not null default '',
  starts_at       timestamptz not null,
  ends_at         timestamptz not null,
  status          text not null default 'draft'
                    check (status in ('draft', 'open', 'closed', 'published')),
  timezone        text not null default 'UTC',
  published_at    timestamptz,
  results_public  smallint not null default 1 check (results_public in (0, 1)),
  created_by      integer references public.users(id) on delete set null,
  created_at      timestamptz not null default now()
);

create table if not exists public.positions (
  id            integer generated always as identity primary key,
  election_id   integer not null references public.elections(id) on delete cascade,
  title         text not null,
  description   text not null default '',
  max_select    integer not null default 1 check (max_select >= 0),
  min_select    integer not null default 1 check (min_select >= 0),
  is_mandatory  smallint not null default 1 check (is_mandatory in (0, 1)),
  sort_order    integer not null default 0
);

create table if not exists public.candidates (
  id            integer generated always as identity primary key,
  election_id   integer not null references public.elections(id) on delete cascade,
  position_id   integer not null references public.positions(id) on delete cascade,
  name          text not null,
  student_id    text not null default '',
  department    text not null default '',
  faculty       text not null default '',
  level         text not null default '',
  affiliation   text not null default 'Independent',
  bio           text not null default '',
  manifesto     text not null default '',
  photo_url     text not null default '',
  sort_order    integer not null default 0
);

create table if not exists public.voter_eligibility (
  election_id  integer not null references public.elections(id) on delete cascade,
  user_id      integer not null references public.users(id) on delete cascade,
  primary key (election_id, user_id)
);

-- Who voted (NO choices stored here) — enforces One Student = One Vote.
-- The constraint is named explicitly so src/supabase.js can distinguish
-- "already voted" from a reference_code collision by SQLSTATE + constraint
-- name, instead of parsing message text the way the SQLite version had to.
create table if not exists public.vote_receipts (
  id              integer generated always as identity primary key,
  election_id     integer not null references public.elections(id) on delete cascade,
  voter_id        integer not null references public.users(id) on delete cascade,
  reference_code  text unique not null,
  created_at      timestamptz not null default now(),
  constraint vote_receipts_election_voter_key unique (election_id, voter_id)
);

-- Anonymous ballots (NO voter link) — secret ballot.
create table if not exists public.ballots (
  id            integer generated always as identity primary key,
  election_id   integer not null references public.elections(id) on delete cascade,
  position_id   integer not null references public.positions(id) on delete cascade,
  candidate_id  integer references public.candidates(id) on delete set null,
  is_abstain    smallint not null default 0 check (is_abstain in (0, 1)),
  created_at    timestamptz not null default now()
);

-- --- Supporting tables ------------------------------------------------------

create table if not exists public.audit_logs (
  id          integer generated always as identity primary key,
  actor_id    integer references public.users(id) on delete set null,
  action      text not null,
  details     text not null default '',
  ip          text not null default '',
  created_at  timestamptz not null default now()
);

create table if not exists public.settings (
  key    text primary key,
  value  text not null
);

-- In-app notification outbox, plus the optional email channel.
create table if not exists public.notifications (
  id           integer generated always as identity primary key,
  user_id      integer not null references public.users(id) on delete cascade,
  election_id  integer references public.elections(id) on delete cascade,
  type         text not null,
  title        text not null,
  body         text not null default '',
  channel      text not null default 'inapp',
  status       text not null default 'pending'
                 check (status in ('pending', 'sent', 'failed')),
  read_at      timestamptz,
  created_at   timestamptz not null default now(),
  sent_at      timestamptz
);

-- Brute-force protection: one row per login attempt, successful or not.
-- created_at stays text and keeps the exact ISO-8601 'T' form SQLite produced.
-- Postgres timestamptz would render with a '+00:00' offset, which sorts
-- differently from the strings the lockout query compares against and would
-- make every row look newer than the cutoff.
create table if not exists public.login_attempts (
  id          integer generated always as identity primary key,
  identifier  text not null,
  ip          text not null default '',
  ok          smallint not null default 0 check (ok in (0, 1)),
  created_at  text not null
                default (to_char((now() at time zone 'utc'), 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'))
);

-- --- Indexes ----------------------------------------------------------------

create index if not exists idx_ballots_election  on public.ballots(election_id);
create index if not exists idx_ballots_position  on public.ballots(position_id);
create index if not exists idx_ballots_candidate on public.ballots(candidate_id);
create index if not exists idx_users_roll       on public.users(role, department, level);
create index if not exists idx_users_auth        on public.users(auth_id);
create index if not exists idx_candidates_election_pos
  on public.candidates(election_id, position_id);
create index if not exists idx_elections_status on public.elections(status, starts_at);
create index if not exists idx_vote_receipts_election on public.vote_receipts(election_id);
create index if not exists idx_notifications_user on public.notifications(user_id, id desc);
create index if not exists idx_login_attempts_lookup
  on public.login_attempts(identifier, ok, created_at);

-- --- Atomic vote casting ---------------------------------------------------

-- The SQLite version wrapped the receipt insert and every ballot insert in
-- BEGIN IMMEDIATE. A Postgres function is atomic by default, so this is the
-- equivalent: either the receipt and all of its ballots are committed, or the
-- whole statement rolls back. The unique constraint on
-- (election_id, voter_id) is what actually prevents a double vote, and it is
-- enforced while the function holds the receipt row's lock.
create or replace function public.cast_vote(
  p_election_id integer,
  p_voter_id    integer,
  p_reference   text,
  p_ballots     jsonb
) returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.vote_receipts (election_id, voter_id, reference_code)
  values (p_election_id, p_voter_id, p_reference);

  insert into public.ballots (election_id, position_id, candidate_id, is_abstain)
  select p_election_id,
         (entry->>'position_id')::integer,
         nullif(entry->>'candidate_id', '')::integer,
         coalesce((entry->>'is_abstain')::smallint, 0)
  from jsonb_array_elements(p_ballots) as entry;
end;
$$;

-- --- Supabase Auth <-> profile sync ----------------------------------------

-- Keeps public.users.verified in step with Supabase's own confirmation state,
-- so the "verify before voting" gate keeps working without the app having to
-- check auth.users itself on every request.
create or replace function public.handle_auth_user_upsert() returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.users (auth_id, email, name, verified)
  values (
    new.id,
    new.email,
    coalesce(nullif(new.raw_user_meta_data ->> 'name', ''), split_part(new.email, '@', 1)),
    case when new.email_confirmed_at is null then 0 else 1 end
  )
  on conflict (auth_id) do update
    set email    = excluded.email,
        verified = excluded.verified;
  return new;
end;
$$;

-- Disabling rather than deleting on auth removal: cascading would delete the
-- vote_receipts row and erase the record that this student voted, which must
-- survive an account being closed.
--
-- Matching on auth_id is only safe from a BEFORE trigger. users.auth_id is
-- declared ON DELETE SET NULL, and that referential action runs *before*
-- AFTER DELETE triggers fire — so by the time an AFTER trigger executed,
-- auth_id was already NULL, the UPDATE matched nothing, and the account stayed
-- active. BEFORE DELETE runs while the link is still intact.
create or replace function public.handle_auth_user_delete() returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  update public.users set is_active = 0 where auth_id = old.id;
  return old;
end;
$$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_auth_user_upsert();

drop trigger if exists on_auth_user_updated on auth.users;
create trigger on_auth_user_updated
  after update on auth.users
  for each row execute function public.handle_auth_user_upsert();

drop trigger if exists on_auth_user_deleted on auth.users;
create trigger on_auth_user_deleted
  before delete on auth.users
  for each row execute function public.handle_auth_user_delete();

-- --- Access control --------------------------------------------------------

-- Row Level Security is enabled but no policies are defined. That is the
-- intended state, not an oversight: anon and authenticated get nothing, while
-- the API server connects with the service role key and bypasses RLS entirely.
-- Requests therefore only ever arrive through the audited Express layer.
alter table public.users                enable row level security;
alter table public.email_verifications  enable row level security;
alter table public.password_resets      enable row level security;
alter table public.elections            enable row level security;
alter table public.positions            enable row level security;
alter table public.candidates           enable row level security;
alter table public.voter_eligibility    enable row level security;
alter table public.vote_receipts        enable row level security;
alter table public.ballots              enable row level security;
alter table public.audit_logs           enable row level security;
alter table public.settings             enable row level security;
alter table public.notifications        enable row level security;
alter table public.login_attempts       enable row level security;

-- Supabase grants ALL on new public tables to anon/authenticated by default,
-- which would hand out direct PostgREST access to ballot data. Revoke it, but
-- tolerate a plain Postgres server where those roles do not exist.
do $$
begin
  if exists (select 1 from pg_roles where rolname = 'anon')
     and exists (select 1 from pg_roles where rolname = 'authenticated') then
    execute 'revoke all on all tables in schema public from anon, authenticated';
    execute 'revoke all on all sequences in schema public from anon, authenticated';
  end if;
end $$;

revoke all on function public.cast_vote(integer, integer, text, jsonb) from public;

do $$
begin
  if exists (select 1 from pg_roles where rolname = 'service_role') then
    execute 'grant execute on function public.cast_vote(integer, integer, text, jsonb) to service_role';
  end if;
end $$;

-- --- Default settings -------------------------------------------------------

insert into public.settings (key, value) values
  ('school_name',                     'UNIVERSITY E-VOTING SYSTEM'),
  ('allow_registration',              '1'),
  ('require_verification_to_vote',    '1'),
  ('results_visibility',              'published_only'),
  ('max_login_attempts',              '5'),
  ('session_hours',                   '12')
on conflict (key) do nothing;

commit;