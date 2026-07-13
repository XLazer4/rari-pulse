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

// chainId -> Alchemy subdomain. Unsupported/wrong guesses are caught by the
// eth_chainId verification and fall back to ~/.ethereum.
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
};

async function rpcChainId(url: string): Promise<number | null> {
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_chainId", params: [] }),
      signal: AbortSignal.timeout(10_000),
    });
    const body = (await res.json()) as { result?: string };
    return body.result ? Number(body.result) : null;
  } catch {
    return null;
  }
}

async function pickRpc(name: string, chainId: number): Promise<string | null> {
  const subdomain = ALCHEMY_SUBDOMAINS[chainId];
  if (subdomain) {
    const url = `https://${subdomain}.g.alchemy.com/v2/${process.env.ALCHEMY_API_KEY}`;
    if ((await rpcChainId(url)) === chainId) return url;
    console.warn(`  ${name}: alchemy ${subdomain} failed verification, trying ~/.ethereum`);
  }
  const configPath = join(ETHEREUM_DIR, `${name}.json`);
  if (existsSync(configPath)) {
    const { url } = JSON.parse(readFileSync(configPath, "utf8"));
    if ((await rpcChainId(url)) === chainId) return url;
    console.warn(`  ${name}: ~/.ethereum RPC ${url} failed verification`);
  }
  return null;
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
    const rpcUrl = await pickRpc(name, chainId);
    if (!rpcUrl) {
      skipped.push(`${name} (${chainId})`);
      continue;
    }
    chains.push({
      name,
      chainId,
      exchangeAddress: address,
      deployBlock: receipt?.blockNumber ?? 0,
      rpcUrl,
    });
    console.log(`  ${name} (${chainId}): ok`);
  }

  mkdirSync(join(import.meta.dirname, "../config"), { recursive: true });
  writeFileSync(OUT_FILE, JSON.stringify(chains, null, 2) + "\n");
  console.log(`\nwrote ${chains.length} chains to config/chains.json`);
  if (skipped.length) console.log(`skipped (no working RPC): ${skipped.join(", ")}`);
}

main();
