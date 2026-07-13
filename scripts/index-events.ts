// Indexes Match/Cancel events from active chains into Supabase.
// First run backfills the last 90 days; later runs resume from the stored
// cursor. Idempotent: re-scanning a range is a no-op (upsert + ignore dupes).
// Usage: npm run index [-- --chain=<chainId>]
import { createPublicClient, encodeEventTopics, http, type Log, type PublicClient } from "viem";
import { loadChains, type Chain } from "../lib/chains";
import { findBlockByTimestamp } from "../lib/blocks";
import { matchEvent, cancelEvent } from "../lib/abi";
import { supabase } from "../lib/supabase";

const BACKFILL_DAYS = 90;
const MIN_CHUNK = 10n;
const UPSERT_BATCH = 500;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const matchTopic = encodeEventTopics({ abi: [matchEvent] })[0];

async function getLogsWithRetry(
  client: PublicClient,
  chain: Chain,
  fromBlock: bigint,
  toBlock: bigint
): Promise<Log[]> {
  for (let attempt = 1; ; attempt++) {
    try {
      return await client.getLogs({
        address: chain.exchangeAddress,
        events: [matchEvent, cancelEvent],
        fromBlock,
        toBlock,
      });
    } catch (e) {
      if (attempt >= 3) throw e;
      await sleep(2000 * attempt);
    }
  }
}

async function blockTimes(
  client: PublicClient,
  blockNumbers: bigint[],
  cache: Map<bigint, string>
): Promise<void> {
  const missing = [...new Set(blockNumbers)].filter((b) => !cache.has(b));
  for (let i = 0; i < missing.length; i += 5) {
    await Promise.all(
      missing.slice(i, i + 5).map(async (blockNumber) => {
        const block = await client.getBlock({ blockNumber });
        cache.set(blockNumber, new Date(Number(block.timestamp) * 1000).toISOString());
      })
    );
  }
}

async function indexChain(chain: Chain): Promise<void> {
  const client = createPublicClient({ transport: http(chain.rpcUrl) });
  const head = await client.getBlockNumber();

  const { data: cursor } = await supabase
    .from("indexer_cursors")
    .select("last_block")
    .eq("chain_id", chain.chainId)
    .maybeSingle();

  let from: bigint;
  if (cursor) {
    from = BigInt(cursor.last_block) + 1n;
  } else {
    const since = Math.floor(Date.now() / 1000) - BACKFILL_DAYS * 86400;
    from = await findBlockByTimestamp(client, since, BigInt(chain.deployBlock));
    console.log(`  ${chain.name}: backfilling from block ${from}`);
  }

  const maxChunk = BigInt(chain.logRange);
  let chunk = maxChunk;
  let total = 0;
  const timeCache = new Map<bigint, string>();

  while (from <= head) {
    const to = from + chunk - 1n > head ? head : from + chunk - 1n;
    let logs: Log[];
    try {
      logs = await getLogsWithRetry(client, chain, from, to);
    } catch (e) {
      if (chunk > MIN_CHUNK) {
        chunk = chunk / 2n < MIN_CHUNK ? MIN_CHUNK : chunk / 2n;
        continue; // retry same `from` with a smaller range
      }
      throw e;
    }

    if (logs.length > 0) {
      await blockTimes(client, logs.map((l) => l.blockNumber!), timeCache);
      const rows = logs.map((log) => ({
        chain_id: chain.chainId,
        tx_hash: log.transactionHash!,
        log_index: Number(log.logIndex!),
        block_number: Number(log.blockNumber!),
        block_time: timeCache.get(log.blockNumber!)!,
        event_type: log.topics[0] === matchTopic ? "match" : "cancel",
      }));
      for (let i = 0; i < rows.length; i += UPSERT_BATCH) {
        const { error } = await supabase
          .from("match_events")
          .upsert(rows.slice(i, i + UPSERT_BATCH), {
            onConflict: "chain_id,tx_hash,log_index",
            ignoreDuplicates: true,
          });
        if (error) throw new Error(`upsert failed: ${error.message}`);
      }
      total += rows.length;
    }

    const { error } = await supabase.from("indexer_cursors").upsert({
      chain_id: chain.chainId,
      last_block: Number(to),
      updated_at: new Date().toISOString(),
    });
    if (error) throw new Error(`cursor update failed: ${error.message}`);

    from = to + 1n;
    if (chunk < maxChunk) chunk = chunk * 2n > maxChunk ? maxChunk : chunk * 2n;
  }

  console.log(`  ${chain.name}: indexed ${total} events, cursor at ${head}`);
}

async function main() {
  const chainArg = process.argv.find((a) => a.startsWith("--chain="))?.split("=")[1];

  const { data: activeRows, error } = await supabase
    .from("chains")
    .select("chain_id")
    .eq("active", true);
  if (error) throw new Error(`failed to load chains: ${error.message}`);
  const activeIds = new Set(activeRows.map((r) => r.chain_id));

  let chains = loadChains().filter((c) => activeIds.has(c.chainId));
  if (chainArg) chains = loadChains().filter((c) => c.chainId === Number(chainArg));
  if (chains.length === 0) {
    console.log("no chains to index — run `npm run discover` first");
    return;
  }

  let failures = 0;
  for (const chain of chains) {
    try {
      await indexChain(chain);
    } catch (e) {
      failures++;
      console.error(`  ${chain.name}: FAILED — ${(e as Error).message.slice(0, 120)}`);
    }
  }
  if (failures > 0) process.exitCode = 1;
}

main();
