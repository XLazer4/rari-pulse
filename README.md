# rari-pulse

Internal ops dashboard for Rarible protocol activity across chains. A small
indexer reads `Match` / `Cancel` events from the `ExchangeV2` contracts over
RPC and stores them in Supabase; a Next.js dashboard shows trade counts per
chain with a customizable date range.

## Setup

1. `npm install`
2. Create `.env.local`:

   ```
   SUPABASE_URL=https://<project-ref>.supabase.co
   SUPABASE_SECRET_KEY=sb_secret_...
   ALCHEMY_API_KEY=...            # optional fallback RPCs
   # direct psql access (schema changes only)
   SUPABASE_DB_HOST=aws-0-<region>.pooler.supabase.com
   SUPABASE_DB_USER=postgres.<project-ref>
   SUPABASE_DB_PASSWORD=...
   ```

3. Apply the schema (idempotent):

   ```
   set -a && source .env.local && set +a
   PGPASSWORD="$SUPABASE_DB_PASSWORD" psql -h "$SUPABASE_DB_HOST" -U "$SUPABASE_DB_USER" -d postgres -f db/schema.sql
   ```

## Workflow

```
npm run gen:chains   # build config/chains.json from the contracts repo + RPCs
npm run discover     # mark chains active/inactive (≥1 trade in last 30 days)
npm run index        # backfill (90 days on first run), then incremental
npm run dev          # dashboard at http://localhost:3000
```

- `gen:chains` reads deployment artifacts from the sibling
  `rarible-protocol-contracts` repo and RPC URLs from `~/.ethereum/<network>.json`
  (with public/Alchemy fallbacks). Every RPC is verified live, including the max
  `eth_getLogs` block range it serves. Chains with no working RPC are printed
  and skipped — `config/chains.json` is gitignored because URLs may embed keys.
- `discover` scans newest-first and stops at the first hit, capped at 300
  `getLogs` calls per chain; chains whose RPC only serves tiny ranges may be
  checked partially (a note is printed). Flip `chains.active` in the DB to
  override.
- `index` is resumable and idempotent — run it any time; a cursor per chain is
  kept in `indexer_cursors`. `npm run index -- --chain=<chainId>` for one chain.

## Ongoing indexing

Manual `npm run index` works; for hands-off updates add a crontab entry:

```
*/30 * * * * cd ~/Documents/Github/rari-pulse && npm run index >> ~/rari-pulse-index.log 2>&1
```

The dashboard's Indexer column flags chains whose cursor hasn't moved in 24h.

## Phase 2 ideas (not built)

- USD volume: decode `matchOrders` calldata for the payment asset + amount
  (see `projects/exchange-v2/contracts/indexing.md` in the contracts repo),
  price via CoinGecko historical API; add `usd_value` to `match_events`.
- Unique traders: fetch `tx.from` per event (`tx_from` column).
