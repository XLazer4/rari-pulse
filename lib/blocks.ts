import type { PublicClient } from "viem";

// Binary search for the first block at or after the given unix timestamp.
export async function findBlockByTimestamp(
  client: PublicClient,
  timestamp: number,
  minBlock: bigint = 0n
): Promise<bigint> {
  let lo = minBlock;
  let hi = await client.getBlockNumber();
  const latest = await client.getBlock({ blockNumber: hi });
  if (Number(latest.timestamp) <= timestamp) return hi;

  while (lo < hi) {
    const mid = (lo + hi) / 2n;
    const block = await client.getBlock({ blockNumber: mid });
    if (Number(block.timestamp) < timestamp) lo = mid + 1n;
    else hi = mid;
  }
  return lo;
}
