-- Example schema exercising the features Warden introspects:
-- foreign keys, enums, nullable columns, defaults, timestamps, json, numerics.

create type user_role as enum ('member', 'admin', 'owner');
create type order_status as enum ('pending', 'paid', 'shipped', 'cancelled', 'refunded');

create table companies (
  id          bigint generated always as identity primary key,
  name        text not null,
  domain      text unique,
  plan        text not null default 'free',
  created_at  timestamptz not null default now()
);

create table users (
  id             bigint generated always as identity primary key,
  company_id     bigint references companies (id) on delete set null,
  email          text not null unique,
  full_name      text,
  role           user_role not null default 'member',
  password_hash  text not null,
  is_active      boolean not null default true,
  metadata       jsonb not null default '{}',
  last_login_at  timestamptz,
  created_at     timestamptz not null default now()
);

create table orders (
  id           bigint generated always as identity primary key,
  company_id   bigint not null references companies (id) on delete cascade,
  user_id      bigint references users (id) on delete set null,
  status       order_status not null default 'pending',
  total        numeric(12, 2) not null check (total >= 0),
  currency     char(3) not null default 'USD',
  notes        text,
  placed_at    timestamptz not null default now()
);

create index on users (company_id);
create index on orders (company_id);
create index on orders (user_id);
