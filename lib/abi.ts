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

// ExchangeV2 trade entrypoints (see exchange-v2 ExchangeV2Core/LibDirectTransfer).
// Used to decode the payment leg of Match events from tx calldata — including
// calls embedded in router/ERC-4337 calldata (see matchPayments in index-events).
export const exchangeAbi = parseAbi([
  "struct AssetType { bytes4 assetClass; bytes data; }",
  "struct Asset { AssetType assetType; uint256 value; }",
  "struct Order { address maker; Asset makeAsset; address taker; Asset takeAsset; uint256 salt; uint256 start; uint256 end; bytes4 dataType; bytes data; }",
  "function matchOrders(Order orderLeft, bytes signatureLeft, Order orderRight, bytes signatureRight) payable",
  "struct Purchase { address sellOrderMaker; uint256 sellOrderNftAmount; bytes4 nftAssetClass; bytes nftData; uint256 sellOrderPaymentAmount; address paymentToken; uint256 sellOrderSalt; uint256 sellOrderStart; uint256 sellOrderEnd; bytes4 sellOrderDataType; bytes sellOrderData; bytes sellOrderSignature; uint256 buyOrderPaymentAmount; uint256 buyOrderNftAmount; bytes buyOrderData; }",
  "function directPurchase(Purchase direct) payable",
  "struct AcceptBid { address bidMaker; uint256 bidNftAmount; bytes4 nftAssetClass; bytes nftData; uint256 bidPaymentAmount; address paymentToken; uint256 bidSalt; uint256 bidStart; uint256 bidEnd; bytes4 bidDataType; bytes bidData; bytes bidSignature; uint256 sellOrderPaymentAmount; uint256 sellOrderNftAmount; bytes sellOrderData; }",
  "function directAcceptBid(AcceptBid direct) payable",
]);

// bytes4(keccak256("ETH")) / bytes4(keccak256("ERC20")) — LibAsset asset classes
export const ETH_ASSET_CLASS = "0xaaaebeba";
export const ERC20_ASSET_CLASS = "0x8ae85d84";

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
