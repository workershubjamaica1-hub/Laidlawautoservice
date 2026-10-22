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

-- Proof of work: a technician's photo of a finished job (kept in the private storage bucket)
alter table service_requests add column if not exists work_photo_path text;
alter table service_requests add column if not exists work_photo_at timestamptz;
alter table emergency_requests add column if not exists work_photo_path text;
alter table emergency_requests add column if not exists work_photo_at timestamptz;

-- Monthly subscription for service providers. paid_until is how long their access runs; payments is the receipt book.
-- transaction_id is unique so the same payment notification can never be credited twice.
alter table users add column if not exists subscription_paid_until timestamptz;
create table if not exists subscription_payments (
  id             bigint generated always as identity primary key,
  user_id        bigint not null references users(id) on delete cascade,
  provider       text not null,              -- 'fygaro' or 'manual' (added by an admin)
  transaction_id text unique,
  amount         numeric(12,2),
  currency       text,
  period_start   timestamptz,
  period_end     timestamptz,
  created_at     timestamptz not null default now()
);
create index if not exists subscription_payments_user_idx on subscription_payments(user_id);
alter table subscription_payments enable row level security;

-- Premium customers: a paid membership with free servicing perks (free oil and filter changes, yearly brake pad check).
-- premium_year_start is when the current membership year began; perks are counted per year.
alter table users add column if not exists premium_paid_until timestamptz;
alter table users add column if not exists premium_year_start timestamptz;
-- A service request booked with a premium perk, and what AutoAid pays the technician for it (their earnings for the job)
alter table service_requests add column if not exists premium_perk text check (premium_perk in ('oil', 'brakes'));
alter table service_requests add column if not exists platform_pay numeric(12,2);
-- The payment log now covers both provider subscriptions and Premium memberships
alter table subscription_payments add column if not exists kind text not null default 'provider';
alter table subscription_payments add column if not exists plan text;

-- Record that a person agreed to the Terms and Privacy Notice when they signed up (and which version)
alter table users add column if not exists terms_accepted_at timestamptz;
alter table users add column if not exists terms_version text;

-- Email verification: a 6-digit code is emailed when someone signs up. Everyone who already has an account counts as verified.
-- Only a scrambled copy of the code is stored.
alter table users add column if not exists email_verified boolean not null default true;
alter table users add column if not exists verify_code_hash text;
alter table users add column if not exists verify_expires_at timestamptz;
alter table users add column if not exists verify_attempts integer not null default 0;
alter table users add column if not exists verify_sent_at timestamptz;

-- Parts marketplace: parts vendors are a new kind of account. They apply, an admin approves them, and customers order parts from them in a chat.
alter table users drop constraint if exists users_role_check;
alter table users add constraint users_role_check check (role in ('customer', 'staff', 'admin', 'vendor'));

-- One row per customer + vendor conversation about a part. The current offer sits on the row; the chat is in part_messages.
create table if not exists part_orders (
  id                 bigint generated always as identity primary key,
  customer_id        bigint references users(id) on delete set null,
  vendor_id          bigint references users(id) on delete set null,
  vehicle_id         bigint references vehicles(id) on delete set null,
  part               text not null,
  status             text not null default 'chatting' check (status in ('chatting', 'offered', 'accepted', 'completed', 'cancelled')),
  offer_item         text,
  offer_condition    text,
  offer_quantity     integer,
  offer_unit_price   numeric(12, 2),
  offer_total        numeric(12, 2),
  commission_percent numeric(5, 2),
  commission_amount  numeric(12, 2),
  accepted_at        timestamptz,
  completed_at       timestamptz,
  commission_settled_at timestamptz,
  rating             integer check (rating between 1 and 5),
  review             text,
  customer_unread    boolean not null default false,
  vendor_unread      boolean not null default true,
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now()
);
create index if not exists part_orders_customer_idx on part_orders(customer_id);
create index if not exists part_orders_vendor_idx on part_orders(vendor_id, status);
alter table part_orders enable row level security;

create table if not exists part_messages (
  id         bigint generated always as identity primary key,
  order_id   bigint not null references part_orders(id) on delete cascade,
  sender_id  bigint references users(id) on delete set null,
  kind       text not null default 'text' check (kind in ('text', 'system')),
  body       text not null,
  created_at timestamptz not null default now()
);
create index if not exists part_messages_order_idx on part_messages(order_id, id);
alter table part_messages enable row level security;

-- Vehicle rentals: rental companies are vendors too. A vendor says what they offer (parts, rentals or both).
-- Drivers licence photos are kept in the private photo bucket; only the vendor of an accepted booking can open one.
alter table users add column if not exists vendor_offers text not null default 'parts';
alter table users add column if not exists licence_photo_path text;
-- What a rental company asks of every renter (age, licence held for, documents, ...). Shown to customers before they request.
alter table users add column if not exists rental_requirements text;

create table if not exists rental_vehicles (
  id            bigint generated always as identity primary key,
  vendor_id     bigint references users(id) on delete cascade,
  title         text not null,
  year          integer,
  category      text not null default 'car',
  seats         integer,
  transmission  text,
  daily_rate    numeric(12, 2) not null,
  deposit       numeric(12, 2) not null default 0,
  min_days      integer not null default 3,
  requirements  text,
  description   text,
  parish        text,
  photo_path    text,
  active        boolean not null default true,
  created_at    timestamptz not null default now()
);
create index if not exists rental_vehicles_vendor_idx on rental_vehicles(vendor_id);
alter table rental_vehicles enable row level security;

-- Days a vehicle cannot be rented (in the workshop, with the owner, ...)
create table if not exists rental_blocks (
  id          bigint generated always as identity primary key,
  vehicle_id  bigint not null references rental_vehicles(id) on delete cascade,
  start_date  date not null,
  end_date    date not null,
  note        text,
  created_at  timestamptz not null default now()
);
alter table rental_blocks enable row level security;

create table if not exists rental_bookings (
  id                 bigint generated always as identity primary key,
  vehicle_id         bigint references rental_vehicles(id) on delete set null,
  vehicle_title      text not null,
  customer_id        bigint references users(id) on delete set null,
  vendor_id          bigint references users(id) on delete set null,
  start_date         date not null,
  end_date           date not null,
  days               integer not null,
  daily_rate         numeric(12, 2) not null,
  total              numeric(12, 2) not null,
  deposit            numeric(12, 2) not null default 0,
  note               text,
  damage_authorized_at timestamptz,
  status             text not null default 'requested' check (status in ('requested', 'accepted', 'declined', 'cancelled', 'picked_up', 'returned')),
  commission_percent numeric(5, 2),
  commission_amount  numeric(12, 2),
  accepted_at        timestamptz,
  picked_up_at       timestamptz,
  returned_at        timestamptz,
  commission_settled_at timestamptz,
  rating             integer check (rating between 1 and 5),
  review             text,
  customer_unread    boolean not null default false,
  vendor_unread      boolean not null default true,
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now()
);
create index if not exists rental_bookings_customer_idx on rental_bookings(customer_id);
create index if not exists rental_bookings_vendor_idx on rental_bookings(vendor_id, status);
create index if not exists rental_bookings_vehicle_idx on rental_bookings(vehicle_id, status);
alter table rental_bookings enable row level security;

create table if not exists rental_messages (
  id          bigint generated always as identity primary key,
  booking_id  bigint not null references rental_bookings(id) on delete cascade,
  sender_id   bigint references users(id) on delete set null,
  kind        text not null default 'text' check (kind in ('text', 'system')),
  body        text not null,
  created_at  timestamptz not null default now()
);
create index if not exists rental_messages_booking_idx on rental_messages(booking_id, id);
alter table rental_messages enable row level security;

-- Accounts: password reset codes, sign everyone out of old sessions when the password changes, and account deletion (the row is kept but emptied).
alter table users add column if not exists pw_changed_at timestamptz;
alter table users add column if not exists reset_code_hash text;
alter table users add column if not exists reset_expires_at timestamptz;
alter table users add column if not exists reset_attempts integer not null default 0;
alter table users add column if not exists reset_sent_at timestamptz;
alter table users add column if not exists deleted_at timestamptz;

-- Make Supabase's API notice the new columns and table straight away
notify pgrst, 'reload schema';
schema-users
