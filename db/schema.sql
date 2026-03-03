-- backend/db/schema.sql
-- VoiceSafe MAX schema (Postgres)

create table if not exists cases (
  id text primary key,
  created_at timestamptz not null default now(),
  rid text,
  api_key text,
  original_filename text,
  stored_filename text,
  output_format text,
  runtime_ms integer,

  title text,
  platform text,
  country text,
  language text,
  tags text,
  notes text,

  risk_level text,
  confidence double precision,
  scam_score double precision,
  ai_probability double precision,
  stress_level double precision,
  summary text,

  flags jsonb,
  transcript text,
  features jsonb,
  file_hash text,
  pipeline jsonb,
  storage jsonb
);

create index if not exists idx_cases_api_created on cases(api_key, created_at desc);
create index if not exists idx_cases_text on cases using gin (to_tsvector('simple',
  coalesce(title,'') || ' ' || coalesce(notes,'') || ' ' || coalesce(tags,'')
));

create table if not exists audit_logs (
  id bigserial primary key,
  created_at timestamptz not null default now(),
  event_type text not null,
  rid text,
  ip text,
  api_key text,
  data jsonb
);

create index if not exists idx_audit_created on audit_logs(created_at desc);
