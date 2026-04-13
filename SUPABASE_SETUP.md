# AlphaEdge — Supabase Setup

## 1. Create Supabase project
1. Go to https://supabase.com → New Project
2. Name: alphaedge, password: (save it), region: EU West

## 2. Run this SQL in Supabase SQL Editor:

```sql
-- License codes table
create table codes (
  id uuid default gen_random_uuid() primary key,
  code text unique not null,
  plan text default 'lifetime',
  price integer default 149,
  device_id text,
  used_at timestamptz,
  created_at timestamptz default now(),
  notes text
);

-- Signals table (shared signal for all users)
create table signals (
  id bigint generated always as identity primary key,
  window_ts bigint not null,
  direction text, -- 'UP', 'DOWN', or null
  confidence numeric,
  reason text,
  locked_at timestamptz,
  created_at timestamptz default now()
);

-- Create index for fast lookup
create index signals_window_ts_idx on signals(window_ts desc);
create index codes_code_idx on codes(code);

-- Row Level Security
alter table codes enable row level security;
alter table signals enable row level security;

-- Allow service_role full access (our API uses this)
create policy "service_role_all_codes" on codes for all using (true);
create policy "service_role_all_signals" on signals for all using (true);

-- Allow public to read signals (all users see same signal)
create policy "public_read_signals" on signals for select using (true);
```

## 3. Get your keys
In Supabase: Settings → API
- `SUPABASE_URL` = https://xxxxx.supabase.co
- `SUPABASE_ANON_KEY` = eyJ...
- `SUPABASE_SERVICE_KEY` = eyJ... (keep secret!)

## 4. Add to Vercel
Vercel Dashboard → Your Project → Settings → Environment Variables:
- `SUPABASE_URL` = your URL
- `SUPABASE_SERVICE_KEY` = your service key
- `ADMIN_CODE` = AE-ADMIN-0000

## 5. Deploy
Push to GitHub → Vercel auto-deploys
