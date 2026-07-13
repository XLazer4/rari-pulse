// Marks chains active/inactive based on whether the exchange emitted at least
// one Match event in the last 30 days. Upserts results into the chains table.
import { createPublicClient, http, type PublicClient } from "viem";
import { loadChains, type Chain } from "../lib/chains";
import { findBlockByTimestamp } from "../lib/blocks";
import { matchEvent } from "../lib/abi";
import { supabase } from "../lib/supabase";

const LOOKBACK_DAYS = 30;
// Cap on getLogs calls per chain, so chains whose RPC only serves tiny block
// ranges (e.g. 50) don't take forever. If the cap is hit before covering 30
// days, the chain is marked inactive with a "partial coverage" note.
const MAX_CALLS = 300;

async function hasRecentMatch(client: PublicClient, chain: Chain): Promise<boolean> {
  const since = Math.floor(Date.now() / 1000) - LOOKBACK_DAYS * 86400;
  const from = await findBlockByTimestamp(client, since, BigInt(chain.deployBlock));
  const head = await client.getBlockNumber();
  const chunk = BigInt(chain.logRange);

  // scan newest-first: active chains hit in the first chunk
  let to = head;
  let calls = 0;
  while (to >= from && calls < MAX_CALLS) {
    const start = to - chunk + 1n > from ? to - chunk + 1n : from;
    const logs = await client.getLogs({
      address: chain.exchangeAddress,
      event: matchEvent,
      fromBlock: start,
      toBlock: to,
    });
    if (logs.length > 0) return true;
    to = start - 1n;
    calls++;
  }
  if (to >= from) {
    const covered = Number(head - to);
    const total = Number(head - from);
    console.log(`    (partial: covered newest ${covered}/${total} blocks before call cap)`);
  }
  return false;
}

async function main() {
  const results: { chain: Chain; active: boolean; error?: string }[] = [];

  for (const chain of loadChains()) {
    const client = createPublicClient({ transport: http(chain.rpcUrl) });
    try {
      const active = await hasRecentMatch(client, chain);
      results.push({ chain, active });
      console.log(`  ${chain.name} (${chain.chainId}): ${active ? "ACTIVE" : "inactive"}`);
    } catch (e) {
      results.push({ chain, active: false, error: (e as Error).message.slice(0, 80) });
      console.log(`  ${chain.name} (${chain.chainId}): ERROR ${(e as Error).message.slice(0, 80)}`);
    }
  }

  const { error } = await supabase.from("chains").upsert(
    results.map(({ chain, active }) => ({
      chain_id: chain.chainId,
      name: chain.name,
      exchange_address: chain.exchangeAddress,
      active,
      checked_at: new Date().toISOString(),
    }))
  );
  if (error) throw new Error(`supabase upsert failed: ${error.message}`);

  const active = results.filter((r) => r.active);
  console.log(`\n${active.length}/${results.length} chains active: ${active.map((r) => r.chain.name).join(", ")}`);
}

main();
