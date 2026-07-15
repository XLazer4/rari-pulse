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

-- per-chain totals within a range + all-time last event (for dead-chain spotting);
-- opensea = successful wrapper purchases against OpenSea-family venues
drop function if exists chain_stats(timestamptz, timestamptz);
create function chain_stats(from_ts timestamptz, to_ts timestamptz)
returns table (chain_id bigint, matches bigint, opensea bigint, cancels bigint, last_event timestamptz)
language sql stable as $$
  with m as (
    select chain_id,
           count(*) filter (where event_type = 'match' and block_time >= from_ts and block_time < to_ts) as matches,
           count(*) filter (where event_type = 'cancel' and block_time >= from_ts and block_time < to_ts) as cancels,
           max(block_time) as last_event
    from match_events
    group by chain_id
  ), w as (
    select chain_id, count(*) as opensea
    from wrapper_purchases
    where success
      and market in ('WyvernExchange', 'SeaPort_1_1', 'SeaPort_1_4', 'SeaPort_1_5', 'SeaPort_1_6')
      and block_time >= from_ts and block_time < to_ts
    group by chain_id
  )
  select chain_id, coalesce(m.matches, 0), coalesce(w.opensea, 0), coalesce(m.cancels, 0), m.last_event
  from m full outer join w using (chain_id);
$$;

-- Purchases routed through RaribleExchangeWrapper (one row per Execution leg).
-- market holds the raw Markets enum name; display grouping happens in SQL below.
-- ExchangeV2 legs also emit a Match (already in match_events) — stored here but
-- excluded from source counts to avoid double counting.
create table if not exists wrapper_purchases (
  chain_id bigint not null references chains(chain_id),
  tx_hash text not null,
  leg_index int not null,
  market text not null,
  amount numeric not null,
  success boolean not null,
  block_number bigint not null,
  block_time timestamptz not null,
  primary key (chain_id, tx_hash, leg_index)
);
create index if not exists wrapper_purchases_block_time_idx on wrapper_purchases (block_time);

-- trades per day per source: all ExchangeV2 matches as 'Rarible' + successful
-- non-ExchangeV2 wrapper legs grouped by venue
create or replace function daily_source_counts(from_ts timestamptz, to_ts timestamptz)
returns table (day date, source text, trades bigint)
language sql stable as $$
  select date_trunc('day', block_time)::date as day, 'Rarible' as source, count(*) as trades
  from match_events
  where event_type = 'match' and block_time >= from_ts and block_time < to_ts
  group by 1
  union all
  select date_trunc('day', block_time)::date as day,
         case
           when market in ('WyvernExchange', 'SeaPort_1_1', 'SeaPort_1_4', 'SeaPort_1_5', 'SeaPort_1_6') then 'OpenSea'
           when market in ('LooksRareOrders', 'LooksRareV2') then 'LooksRare'
           when market = 'SudoSwap' then 'Sudoswap'
           else market
         end as source,
         count(*) as trades
  from wrapper_purchases
  where success and market <> 'ExchangeV2' and block_time >= from_ts and block_time < to_ts
  group by 1, 2
  order by 1;
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
