-- rari-pulse schema. Applied once via:
--   source .env.local && PGPASSWORD=$SUPABASE_DB_PASSWORD psql -h $SUPABASE_DB_HOST -U $SUPABASE_DB_USER -d postgres -f db/schema.sql

create table if not exists chains (
  chain_id bigint primary key,
  name text not null,
  exchange_address text not null,
  active boolean not null default false,
  checked_at timestamptz
);

create table if not exists match_events (
  chain_id bigint not null references chains(chain_id),
  tx_hash text not null,
  log_index int not null,
  block_number bigint not null,
  block_time timestamptz not null,
  event_type text not null check (event_type in ('match', 'cancel')),
  -- phase 2: usd_value numeric, tx_from text
  primary key (chain_id, tx_hash, log_index)
);
create index if not exists match_events_block_time_idx on match_events (block_time);
create index if not exists match_events_chain_time_idx on match_events (chain_id, block_time);

create table if not exists indexer_cursors (
  chain_id bigint primary key references chains(chain_id),
  last_block bigint not null,
  updated_at timestamptz not null default now()
);

-- per-chain totals within a range + all-time last event (for dead-chain spotting)
create or replace function chain_stats(from_ts timestamptz, to_ts timestamptz)
returns table (chain_id bigint, matches bigint, cancels bigint, last_event timestamptz)
language sql stable as $$
  select chain_id,
         count(*) filter (where event_type = 'match' and block_time >= from_ts and block_time < to_ts) as matches,
         count(*) filter (where event_type = 'cancel' and block_time >= from_ts and block_time < to_ts) as cancels,
         max(block_time) as last_event
  from match_events
  group by chain_id;
$$;

create or replace function daily_counts(from_ts timestamptz, to_ts timestamptz)
returns table (day date, chain_id bigint, matches bigint, cancels bigint)
language sql stable as $$
  select date_trunc('day', block_time)::date as day, match_events.chain_id,
         count(*) filter (where event_type = 'match') as matches,
         count(*) filter (where event_type = 'cancel') as cancels
  from match_events
  where block_time >= from_ts and block_time < to_ts
  group by 1, 2
  order by 1;
$$;
