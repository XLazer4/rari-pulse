// Generates config/chains.json from the rarible-protocol-contracts deployments
// and available RPCs (Alchemy-derived URLs preferred, ~/.ethereum/*.json fallback).
// Every emitted rpcUrl is verified with a live eth_chainId call.
import { readFileSync, readdirSync, existsSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import "../lib/env";

const DEPLOYMENTS_DIR = join(
  homedir(),
  "Documents/Github/rarible-protocol-contracts/projects/hardhat-deploy/deployments"
);
const ETHEREUM_DIR = join(homedir(), ".ethereum");
const OUT_FILE = join(import.meta.dirname, "../config/chains.json");

// Names of non-mainnet deployments that don't say "testnet"
const EXCLUDE = /testnet|sepolia|goerli|mumbai|pegasus|amoy|dev|old/i;

// Public RPCs for chains with no ~/.ethereum config (or a broken one).
const PUBLIC_FALLBACKS: Record<number, string[]> = {
  1: ["https://eth.drpc.org"],
  56: ["https://bsc.rpc.blxrbdn.com"],
  137: ["https://polygon.gateway.tenderly.co"],
  143: ["https://monad.drpc.org"],
};

// chainId -> Alchemy subdomain. Last-resort only: the free tier caps
// eth_getLogs at a 10-block range, which fails verification below — these
// only get picked if the key is upgraded to PAYG.
const ALCHEMY_SUBDOMAINS: Record<number, string> = {
  1: "eth-mainnet",
  56: "bnb-mainnet",
  137: "polygon-mainnet",
  143: "monad-mainnet",
  252: "frax-mainnet",
  324: "zksync-mainnet",
  360: "shape-mainnet",
  999: "hyperliquid-mainnet",
  1329: "sei-mainnet",
  2741: "abstract-mainnet",
  5000: "mantle-mainnet",
  8453: "base-mainnet",
  33139: "apechain-mainnet",
  42161: "arb-mainnet",
  42220: "celo-mainnet",
  80094: "berachain-mainnet",
};

type Chain = {
  name: string;
  chainId: number;
  exchangeAddress: string;
  deployBlock: number;
  rpcUrl: string;
  logRange: number; // max eth_getLogs block range this RPC serves
};

const PROBE_SPANS = [10_000, 2_000, 500, 50];

async function rpc(url: string, method: string, params: unknown[]): Promise<unknown> {
  const res = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
    signal: AbortSignal.timeout(15_000),
  });
  const body = (await res.json()) as { result?: unknown; error?: { message: string } };
  if (body.error) throw new Error(body.error.message);
  if (body.result === undefined) throw new Error("no result");
  return body.result;
}

// Verifies chainId, then probes the largest eth_getLogs block range the RPC
// serves (rules out Alchemy free tier's 10-block cap and other crippled
// endpoints). The range is probed at a ~90-day-old block, not at head, so
// pruned nodes that can't serve the backfill window are rejected too.
// Returns the usable range, or null if unusable.
async function probe(
  url: string,
  chainId: number,
  address: string,
  deployBlock: number
): Promise<number | null> {
  try {
    if (Number(await rpc(url, "eth_chainId", [])) !== chainId) return null;
    const head = Number(await rpc(url, "eth_blockNumber", []));

    // estimate the block ~90 days ago from recent block times
    const sampleDepth = Math.min(head - 1, 10_000);
    const [headBlock, oldSample] = (await Promise.all([
      rpc(url, "eth_getBlockByNumber", ["0x" + head.toString(16), false]),
      rpc(url, "eth_getBlockByNumber", ["0x" + (head - sampleDepth).toString(16), false]),
    ])) as { timestamp: string }[];
    const secPerBlock =
      (Number(headBlock.timestamp) - Number(oldSample.timestamp)) / sampleDepth;
    const backfillStart = Math.max(
      deployBlock,
      Math.max(0, head - Math.round((90 * 86400) / Math.max(secPerBlock, 0.01)))
    );

    for (const span of PROBE_SPANS) {
      try {
        await rpc(url, "eth_getLogs", [
          {
            address,
            fromBlock: "0x" + backfillStart.toString(16),
            toBlock: "0x" + Math.min(head, backfillStart + span - 1).toString(16),
          },
        ]);
        return span;
      } catch {
        // range too large for this RPC — try a smaller span
      }
    }
    return null;
  } catch {
    return null;
  }
}

async function pickRpc(
  name: string,
  chainId: number,
  address: string,
  deployBlock: number
): Promise<{ url: string; logRange: number } | null> {
  const candidates: string[] = [];
  const configPath = join(ETHEREUM_DIR, `${name}.json`);
  if (existsSync(configPath)) {
    candidates.push(JSON.parse(readFileSync(configPath, "utf8")).url);
  }
  candidates.push(...(PUBLIC_FALLBACKS[chainId] ?? []));
  const subdomain = ALCHEMY_SUBDOMAINS[chainId];
  if (subdomain) {
    candidates.push(`https://${subdomain}.g.alchemy.com/v2/${process.env.ALCHEMY_API_KEY}`);
  }

  let best: { url: string; logRange: number } | null = null;
  for (const url of candidates) {
    const logRange = await probe(url, chainId, address, deployBlock);
    if (logRange === PROBE_SPANS[0]) return { url, logRange };
    if (logRange !== null) {
      if (!best || logRange > best.logRange) best = { url, logRange };
      continue;
    }
    console.warn(`  ${name}: ${url.replace(process.env.ALCHEMY_API_KEY!, "***")} failed verification`);
  }
  return best;
}

async function main() {
  if (!process.env.ALCHEMY_API_KEY) throw new Error("ALCHEMY_API_KEY not set");

  const chains: Chain[] = [];
  const skipped: string[] = [];

  for (const name of readdirSync(DEPLOYMENTS_DIR).sort()) {
    if (EXCLUDE.test(name)) continue;
    const dir = join(DEPLOYMENTS_DIR, name);
    const artifact = ["ExchangeV2.json", "ExchangeMetaV2.json"]
      .map((f) => join(dir, f))
      .find(existsSync);
    if (!artifact) continue;

    const chainId = Number(readFileSync(join(dir, ".chainId"), "utf8").trim());
    const { address, receipt } = JSON.parse(readFileSync(artifact, "utf8"));
    const picked = await pickRpc(name, chainId, address, receipt?.blockNumber ?? 0);
    if (!picked) {
      skipped.push(`${name} (${chainId})`);
      continue;
    }
    chains.push({
      name,
      chainId,
      exchangeAddress: address,
      deployBlock: receipt?.blockNumber ?? 0,
      rpcUrl: picked.url,
      logRange: picked.logRange,
    });
    console.log(`  ${name} (${chainId}): ok (logRange ${picked.logRange})`);
  }

  mkdirSync(join(import.meta.dirname, "../config"), { recursive: true });
  writeFileSync(OUT_FILE, JSON.stringify(chains, null, 2) + "\n");
  console.log(`\nwrote ${chains.length} chains to config/chains.json`);
  if (skipped.length) console.log(`skipped (no working RPC): ${skipped.join(", ")}`);
}

main();
