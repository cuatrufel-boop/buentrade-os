-- Tabla nueva Trucking (separada de freight_carriers, sin cruzar con esa data vieja)

create table if not exists trucking (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  contact_name text,
  email text,
  country text,
  city text,
  phone text,
  notes text,
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);

alter table trucking enable row level security;

create policy "authenticated_full_access_trucking" on trucking for all to authenticated using (true) with check (true);
grant select, insert, update, delete on trucking to authenticated;
