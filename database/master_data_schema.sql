-- BUENTRADE Trading OS — Fase 2: Base de Datos (Master Data)
-- Crea únicamente el esquema de las 9 entidades aprobadas en Fase 1.1,
-- más 1 tabla de relación (plant_products) exigida explícitamente por el
-- documento BUENTRADE Trading OS v1.0 (sección 3.5: un producto puede
-- existir en múltiples plantas, con precios distintos por planta).
--
-- No incluye pantallas, lógica de negocio, ni políticas de acceso (RLS)
-- todavía — eso se diseña en una fase posterior, una vez definido el
-- puente de autenticación Firebase <-> Supabase.
--
-- RLS queda ACTIVADO pero SIN políticas: esto significa que, hasta que
-- se agreguen políticas explícitas, nadie puede leer ni escribir estas
-- tablas a través de la API pública. Es el estado seguro por defecto.

-- ============================================================
-- CATÁLOGOS (sin dependencias)
-- ============================================================

create table packaging (
  id uuid primary key default gen_random_uuid(),
  name text not null unique,
  notes text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table temperature (
  id uuid primary key default gen_random_uuid(),
  name text not null unique,
  notes text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table cost_types (
  id uuid primary key default gen_random_uuid(),
  name text not null unique,
  typical_currency text,
  notes text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table incoterms (
  id uuid primary key default gen_random_uuid(),
  code text not null unique,
  name text not null,
  description text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table exchange_rates (
  id uuid primary key default gen_random_uuid(),
  rate_date date not null,
  from_currency text not null default 'USD',
  to_currency text not null default 'MXN',
  rate numeric(12,6) not null,
  source text not null default 'manual',
  created_at timestamptz not null default now(),
  unique (rate_date, from_currency, to_currency)
);

-- ============================================================
-- SUPPLIERS / PLANTS
-- ============================================================

create table suppliers (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  country text,
  state text,
  city text,
  contact_name text,
  email text,
  phone text,
  website text,
  notes text,
  avg_response_time text,
  payment_terms text,
  required_documentation text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table plants (
  id uuid primary key default gen_random_uuid(),
  supplier_id uuid not null references suppliers(id) on delete restrict,
  name text not null,
  country text,
  state text,
  city text,
  address text,
  internal_code text,
  contact_name text,
  email text,
  phone text,
  business_hours text,
  avg_loading_time text,
  document_cost numeric(12,2),
  avg_freight_to_border numeric(12,2),
  notes text,
  internal_notes text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- ============================================================
-- PRODUCTS
-- ============================================================

create table products (
  id uuid primary key default gen_random_uuid(),
  category text not null,
  name text not null,
  subcategory text,
  brand text,
  packaging_id uuid references packaging(id),
  temperature_id uuid references temperature(id),
  presentation text,
  unit_of_measure text,
  standard_weight numeric(12,2),
  origin text,
  documents_included text,
  documents_excluded text,
  commercial_notes text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- Relación N:M Plant <-> Product: el precio y disponibilidad viven aquí,
-- nunca en Product por sí solo (regla explícita del documento fuente).
create table plant_products (
  id uuid primary key default gen_random_uuid(),
  plant_id uuid not null references plants(id) on delete cascade,
  product_id uuid not null references products(id) on delete cascade,
  current_price numeric(12,4),
  price_currency text default 'USD',
  price_date date,
  availability text,
  notes text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (plant_id, product_id)
);

-- ============================================================
-- CUSTOMERS
-- ============================================================
-- Nota: "Preferencias Comerciales" e "Historial Comercial" (última
-- compra, último BID, margen promedio, etc.) se agregan en una fase
-- posterior, una vez existan Opportunities/Quotes reales que generen
-- esos datos — no tiene sentido crear esas columnas/tablas vacías hoy.

create table customers (
  id uuid primary key default gen_random_uuid(),
  trade_name text not null,
  legal_name text,
  country text,
  state text,
  city text,
  address text,
  contact_name text,
  contact_role text,
  email text,
  phone text,
  whatsapp text,
  website text,
  notes text,
  preferred_currency text,
  usual_delivery_type text,
  usual_destination text,
  payment_days integer,
  usual_incoterm_id uuid references incoterms(id),
  payment_method text,
  preferred_exchange_rate_mode text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- ============================================================
-- SEGURIDAD: RLS activado, sin políticas todavía (nadie puede
-- leer/escribir vía la API pública hasta que se diseñen las políticas)
-- ============================================================

alter table packaging enable row level security;
alter table temperature enable row level security;
alter table cost_types enable row level security;
alter table incoterms enable row level security;
alter table exchange_rates enable row level security;
alter table suppliers enable row level security;
alter table plants enable row level security;
alter table products enable row level security;
alter table plant_products enable row level security;
alter table customers enable row level security;
