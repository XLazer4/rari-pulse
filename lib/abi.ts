import { parseAbiItem } from "viem";

// ExchangeV2Core events (see rarible-protocol-contracts/projects/exchange-v2)
export const matchEvent = parseAbiItem(
  "event Match(bytes32 leftHash, bytes32 rightHash, uint256 newLeftFill, uint256 newRightFill)"
);
export const cancelEvent = parseAbiItem("event Cancel(bytes32 hash)");
