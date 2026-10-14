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

-- Service members (technicians) apply on their own and must be approved by an admin before they can sign in.
-- Existing accounts stay approved.
alter table users add column if not exists approved boolean not null default true;
alter table users add column if not exists specialties text;      -- comma-separated, e.g. "mechanical,towing"
alter table users add column if not exists business_name text;
alter table users add column if not exists experience text;

-- Emergency requests: roadside assistance and wrecker (towing)
create table if not exists emergency_requests (
  id            bigint generated always as identity primary key,
  user_id       bigint references users(id) on delete set null,
  kind          text not null check (kind in ('roadside', 'towing')),
  vehicle_id    bigint references vehicles(id) on delete set null,
  note          text,
  latitude      double precision,
  longitude     double precision,
  location_text text,
  parish        text not null,
  phone         text not null,
  status        text not null default 'open' check (status in ('open', 'dispatched', 'resolved', 'cancelled')),
  technician_id bigint references users(id) on delete set null,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);
create index if not exists emergency_status_idx on emergency_requests(status, parish);
create index if not exists emergency_user_idx on emergency_requests(user_id);
alter table emergency_requests enable row level security;

-- Technician dashboard: who did each job, what they charged (JMD) and how the customer rated it.
-- Applies to both regular service requests and emergency requests.
alter table users add column if not exists avatar_path text;   -- optional profile photo
alter table service_requests add column if not exists technician_id bigint references users(id) on delete set null;
alter table service_requests add column if not exists amount numeric(12,2);
alter table service_requests add column if not exists completed_at timestamptz;
alter table service_requests add column if not exists rating smallint check (rating between 1 and 5);
alter table service_requests add column if not exists review text;
alter table service_requests add column if not exists rated_at timestamptz;
alter table emergency_requests add column if not exists amount numeric(12,2);
alter table emergency_requests add column if not exists completed_at timestamptz;
alter table emergency_requests add column if not exists rating smallint check (rating between 1 and 5);
alter table emergency_requests add column if not exists review text;
alter table emergency_requests add column if not exists rated_at timestamptz;
create index if not exists service_requests_tech_idx on service_requests(technician_id);
create index if not exists emergency_tech_idx on emergency_requests(technician_id);

-- Make Supabase's API notice the new columns and table straight away
notify pgrst, 'reload schema';
