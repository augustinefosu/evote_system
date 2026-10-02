-- TEST FIXTURE — NOT PART OF THE DEPLOYED SCHEMA.
--
-- supabase/schema.sql deliberately depends on Supabase's own managed
-- `auth.users` table (the users.auth_id foreign key and the three sync
-- triggers). That table only exists inside a Supabase project, so the schema
-- cannot be applied to a stock Postgres server as written.
--
-- This fixture creates a minimal stand-in so the schema can be applied and
-- exercised locally. It reproduces only the columns and DML behaviour the
-- schema depends on:
--   id                  uuid primary key (defaulted, as Supabase does)
--   email               unique, never null
--   raw_user_meta_data  jsonb, read for the display name
--   email_confirmed_at  timestamptz, drives public.users.verified
--
-- It is NOT a Supabase emulator: no sessions, no tokens, no password hashing.
-- Only run it against a throwaway local database.
create schema if not exists auth;

create table if not exists auth.users (
  id                  uuid primary key default gen_random_uuid(),
  email               text unique not null,
  raw_user_meta_data  jsonb not null default '{}'::jsonb,
  email_confirmed_at  timestamptz,
  created_at          timestamptz not null default now()
);