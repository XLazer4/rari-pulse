// Marks chains active/inactive based on whether the exchange emitted at least
// one Match event in the last 30 days. Results are upserted per chain as soon
// as they are known, and chains checked within the last 12h are skipped — so
// an interrupted run resumes where it left off.
import { createPublicClient, http, type PublicClient } from "viem";
import { loadChains, type Chain } from "../lib/chains";
import { findBlockByTimestamp } from "../lib/blocks";
import { matchEvent } from "../lib/abi";
import { supabase } from "../lib/supabase";

const LOOKBACK_DAYS = 30;
const RECHECK_HOURS = 12;
// Cap on getLogs calls per chain, so chains whose RPC only serves tiny block
// ranges (e.g. 50) don't take forever. If the cap is hit before covering 30
// days, the chain is marked inactive with a "partial coverage" note.
const MAX_CALLS = 300;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function hasRecentMatch(client: PublicClient, chain: Chain): Promise<boolean> {
  const since = Math.floor(Date.now() / 1000) - LOOKBACK_DAYS * 86400;
  const from = await findBlockByTimestamp(client, since, BigInt(chain.deployBlock));
  const head = await client.getBlockNumber();
  let chunk = BigInt(chain.logRange);

  // scan newest-first: active chains hit in the first chunk
  let to = head;
  let calls = 0;
  let failures = 0;
  while (to >= from && calls < MAX_CALLS) {
    const start = to - chunk + 1n > from ? to - chunk + 1n : from;
    try {
      const logs = await client.getLogs({
        address: chain.exchangeAddress,
        event: matchEvent,
        fromBlock: start,
        toBlock: to,
      });
      if (logs.length > 0) return true;
      to = start - 1n;
      failures = 0;
    } catch (e) {
      // halve the range (some RPCs enforce stricter limits on busy/old
      // ranges than the probed one), back off on rate limits
      failures++;
      if (failures > 5) throw e;
      if (chunk > 10n) chunk = chunk / 2n < 10n ? 10n : chunk / 2n;
      await sleep(1000 * failures);
    }
    calls++;
  }
  if (to >= from) {
    const covered = Number(head - to);
    const total = Number(head - from);
    console.log(`    (partial: covered newest ${covered}/${total} blocks before call cap)`);
  }
  return false;
}

async function upsert(chain: Chain, active: boolean) {
  const { error } = await supabase.from("chains").upsert({
    chain_id: chain.chainId,
    name: chain.name,
    exchange_address: chain.exchangeAddress,
    active,
    checked_at: new Date().toISOString(),
  });
  if (error) throw new Error(`supabase upsert failed: ${error.message}`);
}

async function main() {
  const { data: checkedRows, error } = await supabase
    .from("chains")
    .select("chain_id, checked_at, active");
  if (error) throw new Error(`failed to load chains: ${error.message}`);
  const cutoff = Date.now() - RECHECK_HOURS * 3600 * 1000;
  const fresh = new Map(
    (checkedRows ?? [])
      .filter((r) => r.checked_at && new Date(r.checked_at).getTime() > cutoff)
      .map((r) => [r.chain_id, r.active])
  );

  let checked = 0;
  let failed = 0;
  const queue = loadChains().filter((chain) => {
    if (fresh.has(chain.chainId)) {
      console.log(`  ${chain.name} (${chain.chainId}): already checked (${fresh.get(chain.chainId) ? "ACTIVE" : "inactive"})`);
      return false;
    }
    return true;
  });

  const CONCURRENCY = 8;
  await Promise.all(
    Array.from({ length: CONCURRENCY }, async () => {
      let chain: Chain | undefined;
      while ((chain = queue.shift())) {
        const client = createPublicClient({ transport: http(chain.rpcUrl) });
        try {
          const active = await hasRecentMatch(client, chain);
          await upsert(chain, active);
          checked++;
          console.log(`  ${chain.name} (${chain.chainId}): ${active ? "ACTIVE" : "inactive"}`);
        } catch (e) {
          failed++;
          console.log(`  ${chain.name} (${chain.chainId}): ERROR ${(e as Error).message.slice(0, 80)}`);
        }
      }
    })
  );

  console.log(`\nchecked ${checked}, skipped ${fresh.size} fresh, ${failed} errors`);
  const { data: final } = await supabase.from("chains").select("name").eq("active", true);
  console.log(`active chains: ${(final ?? []).map((r) => r.name).join(", ") || "none"}`);
  if (failed > 0) process.exitCode = 1;
}

main();
