// Indexes Match/Cancel events from active chains into Supabase.
// First run backfills the last 90 days; later runs resume from the stored
// cursor. Idempotent: re-scanning a range is a no-op (upsert + ignore dupes).
// Usage: npm run index [-- --chain=<chainId> | --all]
import {
  createPublicClient,
  decodeFunctionData,
  encodeEventTopics,
  http,
  type Log,
  type PublicClient,
} from "viem";
import { loadChains, type Chain } from "../lib/chains";
import { findBlockByTimestamp } from "../lib/blocks";
import { matchEvent, cancelEvent, executionEvent, wrapperAbi, MARKETS } from "../lib/abi";
import { supabase } from "../lib/supabase";

const BACKFILL_DAYS = 90;
const MIN_CHUNK = 10n;
const UPSERT_BATCH = 500;

// RPCs capped at 50-block getLogs ranges — full scans are infeasible (monad alone
// is ~4300 calls/day). Skipped in --all mode unless the chain is marked active.
const SLOW_RPC_CHAINS = new Set([143, 999, 32769]); // monad, hyper_evm, zilliqa

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const matchTopic = encodeEventTopics({ abi: [matchEvent] })[0];
const executionTopic = encodeEventTopics({ abi: [executionEvent] })[0];

type ExecutionLog = Log & { args: { result: boolean } };

async function getLogsWithRetry(
  client: PublicClient,
  chain: Chain,
  fromBlock: bigint,
  toBlock: bigint
): Promise<Log[]> {
  const events = [matchEvent, cancelEvent, executionEvent];
  for (let attempt = 1; ; attempt++) {
    try {
      if (!chain.wrapperAddress) {
        return await client.getLogs({ address: chain.exchangeAddress, events, fromBlock, toBlock });
      }
      try {
        return await client.getLogs({
          address: [chain.exchangeAddress, chain.wrapperAddress],
          events,
          fromBlock,
          toBlock,
        });
      } catch {
        // some RPCs (e.g. blockscout's eth-rpc) reject address arrays — query per address
        const perAddress = await Promise.all(
          [chain.exchangeAddress, chain.wrapperAddress].map((address) =>
            client.getLogs({ address, events, fromBlock, toBlock })
          )
        );
        return perAddress.flat();
      }
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

// Execution events carry no market/amount data — fetch each tx and decode the
// singlePurchase/bulkPurchase calldata. Calldata order == Execution logIndex order.
async function wrapperRows(
  client: PublicClient,
  chain: Chain,
  executionLogs: ExecutionLog[],
  timeCache: Map<bigint, string>
): Promise<Record<string, unknown>[]> {
  const byTx = new Map<string, ExecutionLog[]>();
  for (const log of executionLogs) {
    byTx.set(log.transactionHash!, [...(byTx.get(log.transactionHash!) ?? []), log]);
  }

  const rows: Record<string, unknown>[] = [];
  const txHashes = [...byTx.keys()];
  for (let i = 0; i < txHashes.length; i += 5) {
    await Promise.all(
      txHashes.slice(i, i + 5).map(async (txHash) => {
        const legs = byTx
          .get(txHash)!
          .sort((a, b) => Number(a.logIndex!) - Number(b.logIndex!));
        let details;
        try {
          const tx = await client.getTransaction({ hash: txHash as `0x${string}` });
          const decoded = decodeFunctionData({ abi: wrapperAbi, data: tx.input });
          details = decoded.functionName === "singlePurchase" ? [decoded.args[0]] : decoded.args[0];
        } catch (e) {
          console.warn(
            `  ${chain.name}: skipping wrapper tx ${txHash} — decode failed: ${(e as Error).message.slice(0, 80)}`
          );
          return;
        }
        if (details.length !== legs.length) {
          console.warn(
            `  ${chain.name}: skipping wrapper tx ${txHash} — ${details.length} purchases vs ${legs.length} Execution logs`
          );
          return;
        }
        legs.forEach((log, legIndex) => {
          const d = details[legIndex];
          rows.push({
            chain_id: chain.chainId,
            tx_hash: txHash,
            leg_index: legIndex,
            market: MARKETS[d.marketId] ?? `market_${d.marketId}`,
            amount: d.amount.toString(),
            success: log.args.result,
            block_number: Number(log.blockNumber!),
            block_time: timeCache.get(log.blockNumber!)!,
          });
        });
      })
    );
  }
  return rows;
}

async function indexChain(chain: Chain, backfillDays = BACKFILL_DAYS): Promise<void> {
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
    const since = Math.floor(Date.now() / 1000) - backfillDays * 86400;
    from = await findBlockByTimestamp(client, since, BigInt(chain.deployBlock));
    console.log(`  ${chain.name}: backfilling from block ${from}`);
  }

  const maxChunk = BigInt(chain.logRange);
  let chunk = maxChunk;
  let total = 0;
  let wrapperTotal = 0;
  const timeCache = new Map<bigint, string>();
  const wrapperAddr = chain.wrapperAddress?.toLowerCase();

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
      const exchangeLogs = logs.filter((l) => l.address.toLowerCase() !== wrapperAddr);
      const rows = exchangeLogs.map((log) => ({
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

      const executionLogs = logs.filter(
        (l) => l.address.toLowerCase() === wrapperAddr && l.topics[0] === executionTopic
      ) as ExecutionLog[];
      if (executionLogs.length > 0) {
        const purchases = await wrapperRows(client, chain, executionLogs, timeCache);
        for (let i = 0; i < purchases.length; i += UPSERT_BATCH) {
          const { error } = await supabase
            .from("wrapper_purchases")
            .upsert(purchases.slice(i, i + UPSERT_BATCH), {
              onConflict: "chain_id,tx_hash,leg_index",
              ignoreDuplicates: true,
            });
          if (error) throw new Error(`wrapper upsert failed: ${error.message}`);
        }
        wrapperTotal += purchases.length;
      }
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

  console.log(
    `  ${chain.name}: indexed ${total} events, ${wrapperTotal} wrapper legs, cursor at ${head}`
  );
}

async function main() {
  const chainArg = process.argv.find((a) => a.startsWith("--chain="))?.split("=")[1];
  const allMode = process.argv.includes("--all");

  const { data: activeRows, error } = await supabase
    .from("chains")
    .select("chain_id")
    .eq("active", true);
  if (error) throw new Error(`failed to load chains: ${error.message}`);
  const activeIds = new Set(activeRows.map((r) => r.chain_id));

  // --all: every config chain (slow-RPC ones only when active); cursor-less
  // chains seed from ~1 day back instead of the full backfill
  let chains = loadChains().filter((c) => activeIds.has(c.chainId));
  if (allMode) {
    chains = loadChains().filter(
      (c) => !SLOW_RPC_CHAINS.has(c.chainId) || activeIds.has(c.chainId)
    );
  }
  if (chainArg) chains = loadChains().filter((c) => c.chainId === Number(chainArg));
  if (chains.length === 0) {
    console.log("no chains to index — run `npm run discover` first");
    return;
  }

  let failures = 0;
  for (const chain of chains) {
    try {
      await indexChain(chain, allMode ? 1 : BACKFILL_DAYS);
    } catch (e) {
      failures++;
      console.error(`  ${chain.name}: FAILED — ${(e as Error).message.slice(0, 120)}`);
    }
  }
  if (failures > 0) process.exitCode = 1;
}

main();
