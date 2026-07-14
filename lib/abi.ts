import { parseAbi, parseAbiItem } from "viem";

// ExchangeV2Core events (see rarible-protocol-contracts/projects/exchange-v2)
export const matchEvent = parseAbiItem(
  "event Match(bytes32 leftHash, bytes32 rightHash, uint256 newLeftFill, uint256 newRightFill)"
);
export const cancelEvent = parseAbiItem("event Cancel(bytes32 hash)");

// RaribleExchangeWrapper: one Execution per purchase leg, no market/amount data —
// attribution requires decoding the tx calldata (see rarible-protocol-contracts/projects/exchange-wrapper)
export const executionEvent = parseAbiItem("event Execution(bool result)");
export const wrapperAbi = parseAbi([
  "struct PurchaseDetails { uint8 marketId; uint256 amount; uint256 fees; bytes data; }",
  "function singlePurchase(PurchaseDetails purchaseDetails, address feeRecipientFirst, address feeRecipientSecond) payable",
  "function bulkPurchase(PurchaseDetails[] purchaseDetails, address feeRecipientFirst, address feeRecipientSecond, bool allowFail) payable",
]);

// enum RaribleExchangeWrapper.Markets — index == marketId
export const MARKETS = [
  "ExchangeV2",
  "WyvernExchange",
  "SeaPort_1_1",
  "X2Y2",
  "LooksRareOrders",
  "SudoSwap",
  "SeaPort_1_4",
  "LooksRareV2",
  "Blur",
  "SeaPort_1_5",
  "SeaPort_1_6",
];
