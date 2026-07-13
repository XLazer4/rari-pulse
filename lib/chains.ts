import { readFileSync } from "node:fs";
import { join } from "node:path";

export type Chain = {
  name: string;
  chainId: number;
  exchangeAddress: `0x${string}`;
  deployBlock: number;
  rpcUrl: string;
  logRange: number; // max eth_getLogs block range the RPC serves
};

export function loadChains(): Chain[] {
  const path = join(import.meta.dirname, "../config/chains.json");
  return JSON.parse(readFileSync(path, "utf8"));
}
