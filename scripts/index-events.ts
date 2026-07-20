// Indexes Match/Cancel events from active chains into Supabase.
// First run backfills the last 90 days; later runs resume from the stored
// cursor. Idempotent: re-scanning a range is a no-op (upsert + ignore dupes).
// Usage: npm run index [-- --chain=<chainId> | --all]
import {
  createPublicClient,
  decodeAbiParameters,
  decodeFunctionData,
  encodeEventTopics,
  http,
  toFunctionSelector,
  type Log,
  type PublicClient,
} from "viem";
import { loadChains, type Chain } from "../lib/chains";
import { findBlockByTimestamp } from "../lib/blocks";
import {
  matchEvent,
  cancelEvent,
  executionEvent,
  wrapperAbi,
  exchangeAbi,
  ETH_ASSET_CLASS,
  ERC20_ASSET_CLASS,
  MARKETS,
} from "../lib/abi";
import { fetchPrices, priceIdsForChain, usdValue } from "../lib/prices";
import { supabase } from "../lib/supabase";

const BACKFILL_DAYS = 90;
const MIN_CHUNK = 10n;
const UPSERT_BATCH = 500;

// RPCs capped at 50-block getLogs ranges — full scans are infeasible (monad alone
// is ~4300 calls/day). Skipped in --all mode unless the chain is marked active.
const SLOW_RPC_CHAINS = new Set([143, 32769]); // monad, zilliqa

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const matchTopic = encodeEventTopics({ abi: [matchEvent] })[0];
const executionTopic = encodeEventTopics({ abi: [executionEvent] })[0];

type ExecutionLog = Log & { args: { result: boolean } };
type Payment = {
  payment_token: string | null;
  payment_amount: string | null;
  usd_value: number | null;
};

const NULL_PAYMENT: Payment = { payment_token: null, payment_amount: null, usd_value: null };
const exchangeSelectors = exchangeAbi
  .filter((item) => item.type === "function")
  .map((fn) => toFunctionSelector(fn).slice(2));

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

function extractPayment(functionName: string, args: readonly unknown[]): { token: string; amount: bigint } | null {
  if (functionName === "matchOrders") {
    const left = args[0] as {
      makeAsset: { assetType: { assetClass: string; data: `0x${string}` }; value: bigint };
      takeAsset: { assetType: { assetClass: string; data: `0x${string}` }; value: bigint };
    };
    for (const asset of [left.makeAsset, left.takeAsset]) {
      const cls = asset.assetType.assetClass.toLowerCase();
      if (cls === ETH_ASSET_CLASS) return { token: "native", amount: asset.value };
      if (cls === ERC20_ASSET_CLASS) {
        const [token] = decodeAbiParameters([{ type: "address" }], asset.assetType.data);
        return { token: token.toLowerCase(), amount: asset.value };
      }
    }
    return null;
  }
  const direct = args[0] as {
    paymentToken: string;
    sellOrderPaymentAmount: bigint;
    bidPaymentAmount?: bigint;
  };
  const amount = functionName === "directAcceptBid" ? direct.bidPaymentAmount! : direct.sellOrderPaymentAmount;
  const token =
    direct.paymentToken === "0x0000000000000000000000000000000000000000"
      ? "native"
      : direct.paymentToken.toLowerCase();
  return { token, amount };
}

// Match events carry no payment data — fetch each tx and decode the exchange
// calldata. The call may be embedded in outer calldata (routers, ERC-4337
// bundles), so scan the input for the exchange selectors and decode at the hit.
// txs already priced by wrapperRows are skipped: their ExchangeV2 legs also
// emit a Match, but the wrapper row carries the value (no double counting).
async function matchPayments(
  client: PublicClient,
  chain: Chain,
  matchLogs: Log[],
  wrapperTxs: Set<string>,
  prices: Map<string, number>
): Promise<Map<string, Payment>> {
  const logCount = new Map<string, number>();
  for (const log of matchLogs) {
    logCount.set(log.transactionHash!, (logCount.get(log.transactionHash!) ?? 0) + 1);
  }

  const payments = new Map<string, Payment>();
  const txHashes = [...logCount.keys()].filter((h) => !wrapperTxs.has(h));
  for (let i = 0; i < txHashes.length; i += 5) {
    await Promise.all(
      txHashes.slice(i, i + 5).map(async (txHash) => {
        let input: string;
        try {
          input = (await client.getTransaction({ hash: txHash as `0x${string}` })).input.toLowerCase();
        } catch (e) {
          console.warn(
            `  ${chain.name}: no payment for ${txHash} — tx fetch failed: ${(e as Error).message.slice(0, 80)}`
          );
          return;
        }
        const found = new Map<string, { token: string; amount: bigint }>();
        for (const selector of exchangeSelectors) {
          for (let idx = input.indexOf(selector, 2); idx !== -1; idx = input.indexOf(selector, idx + 8)) {
            try {
              const decoded = decodeFunctionData({
                abi: exchangeAbi,
                data: `0x${input.slice(idx)}` as `0x${string}`,
              });
              const payment = extractPayment(decoded.functionName, decoded.args);
              if (payment) found.set(`${payment.token}:${payment.amount}`, payment);
            } catch {
              // false-positive selector hit or truncated call — ignore
            }
          }
        }
        // only the unambiguous case: one trade in the tx, one distinct payment
        if (found.size === 1 && logCount.get(txHash) === 1) {
          const { token, amount } = [...found.values()][0];
          payments.set(txHash, {
            payment_token: token,
            payment_amount: amount.toString(),
            usd_value: usdValue(chain.chainId, token, amount, prices),
          });
        } else {
          console.warn(
            `  ${chain.name}: no payment for ${txHash} — ${found.size} distinct payments, ${logCount.get(txHash)} Match logs`
          );
        }
      })
    );
  }
  return payments;
}

// Execution events carry no market/amount data — fetch each tx and decode the
// singlePurchase/bulkPurchase calldata. Calldata order == Execution logIndex order.
async function wrapperRows(
  client: PublicClient,
  chain: Chain,
  executionLogs: ExecutionLog[],
  timeCache: Map<bigint, string>,
  prices: Map<string, number>
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
            usd_value: usdValue(chain.chainId, "native", d.amount, prices), // wrapper purchases pay in msg.value
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

async function indexChain(
  chain: Chain,
  prices: Map<string, number>,
  backfillDays = BACKFILL_DAYS
): Promise<void> {
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
      const executionLogs = logs.filter(
        (l) => l.address.toLowerCase() === wrapperAddr && l.topics[0] === executionTopic
      ) as ExecutionLog[];
      const purchases =
        executionLogs.length > 0 ? await wrapperRows(client, chain, executionLogs, timeCache, prices) : [];
      const payments = await matchPayments(
        client,
        chain,
        exchangeLogs.filter((l) => l.topics[0] === matchTopic),
        new Set(purchases.map((p) => p.tx_hash as string)),
        prices
      );
      const rows = exchangeLogs.map((log) => ({
        chain_id: chain.chainId,
        tx_hash: log.transactionHash!,
        log_index: Number(log.logIndex!),
        block_number: Number(log.blockNumber!),
        block_time: timeCache.get(log.blockNumber!)!,
        event_type: log.topics[0] === matchTopic ? "match" : "cancel",
        ...(log.topics[0] === matchTopic
          ? payments.get(log.transactionHash!) ?? NULL_PAYMENT
          : NULL_PAYMENT),
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

      if (purchases.length > 0) {
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

  const prices = await fetchPrices(chains.flatMap((c) => priceIdsForChain(c.chainId)));

  let failures = 0;
  for (const chain of chains) {
    try {
      await indexChain(chain, prices, allMode ? 1 : BACKFILL_DAYS);
    } catch (e) {
      failures++;
      console.error(`  ${chain.name}: FAILED — ${(e as Error).message.slice(0, 120)}`);
    }
  }
  if (failures > 0) process.exitCode = 1;
}

main();
