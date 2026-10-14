-- Run this once in the Supabase dashboard: SQL Editor > New query > paste > Run.
-- Safe to run again; it only adds what is missing.

create table if not exists users (
  id            bigint generated always as identity primary key,
  name          text not null,
  email         text not null unique,
  password_hash text not null,
  role          text not null default 'customer' check (role in ('customer', 'staff', 'admin')),
  active        boolean not null default true,
  created_at    timestamptz not null default now()
);

-- Each vehicle belongs to the customer who added it.
-- Vehicles that existed before accounts have no owner account (user_id is null): staff and admins can see them.
alter table vehicles add column if not exists user_id bigint references users(id) on delete set null;
create index if not exists vehicles_user_id_idx on vehicles(user_id);

-- The server uses the secret key, so block direct access from the public API key
alter table users enable row level security;

-- Contact details and location. The parish lets the shop send the nearest technician.
-- chassis_photo_path points to the customer's photo of their chassis (VIN) number in Supabase Storage
-- (the private bucket "chassis-photos" is created by the server on start-up).
alter table users add column if not exists phone text;
alter table users add column if not exists address text;
alter table users add column if not exists parish text;
alter table users add column if not exists chassis_photo_path text;
create index if not exists users_parish_idx on users(parish);
