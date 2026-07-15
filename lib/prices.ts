import { formatUnits } from "viem";

// Native-coin metadata per chain. decimals = the unit of amounts in exchange
// calldata on that chain's EVM — not always 18 (hedera orders use tinybars).
// Chains absent here get usd_value NULL; raw amounts are still stored.
export const NATIVE: Record<number, { coingeckoId: string; decimals: number }> = {
  1: { coingeckoId: "ethereum", decimals: 18 },
  137: { coingeckoId: "polygon-ecosystem-token", decimals: 18 },
  295: { coingeckoId: "hedera-hashgraph", decimals: 8 },
  2741: { coingeckoId: "ethereum", decimals: 18 }, // abstract
  8453: { coingeckoId: "ethereum", decimals: 18 }, // base
};

// Known ERC20 payment tokens per chain (lowercase address). Unknown tokens get
// usd_value NULL; raw token + amount are still stored.
export const ERC20: Record<number, Record<string, { coingeckoId: string; decimals: number }>> = {
  1: { "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48": { coingeckoId: "usd-coin", decimals: 6 } },
  2741: { "0x84a71ccd554cc1b02749b35d22f684cc8ec987e1": { coingeckoId: "usd-coin", decimals: 6 } },
  8453: { "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913": { coingeckoId: "usd-coin", decimals: 6 } },
};

// One batched spot-price call per indexer run. Fail-soft: on any error returns
// an empty map so indexing proceeds with usd_value NULL.
export async function fetchPrices(coinIds: string[]): Promise<Map<string, number>> {
  const ids = [...new Set(coinIds)];
  if (ids.length === 0) return new Map();
  try {
    const res = await fetch(
      `https://api.coingecko.com/api/v3/simple/price?ids=${ids.join(",")}&vs_currencies=usd`
    );
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const body = (await res.json()) as Record<string, { usd?: number }>;
    return new Map(ids.flatMap((id) => (body[id]?.usd ? [[id, body[id].usd!] as const] : [])));
  } catch (e) {
    console.warn(`price fetch failed — usd_value will be NULL: ${(e as Error).message}`);
    return new Map();
  }
}

export function priceIdsForChain(chainId: number): string[] {
  return [
    ...(NATIVE[chainId] ? [NATIVE[chainId].coingeckoId] : []),
    ...Object.values(ERC20[chainId] ?? {}).map((t) => t.coingeckoId),
  ];
}

// token: 'native' or lowercase ERC20 address. Returns null when the token or
// its price is unknown.
export function usdValue(
  chainId: number,
  token: string,
  rawAmount: bigint,
  prices: Map<string, number>
): number | null {
  const meta = token === "native" ? NATIVE[chainId] : ERC20[chainId]?.[token];
  const price = meta && prices.get(meta.coingeckoId);
  if (!meta || price === undefined) return null;
  return Number(formatUnits(rawAmount, meta.decimals)) * price;
}
