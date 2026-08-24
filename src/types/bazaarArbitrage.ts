export type BazaarExecutionSide = "instant_buy" | "instant_sell";

export interface BazaarLevel {
  amount: number;
  pricePerUnit: number;
  orders: number;
}

export interface BazaarProductQuote {
  productId: string;
  instantBuy: BazaarLevel | null;
  instantSell: BazaarLevel | null;
  sellSummary: BazaarLevel[];
  buySummary: BazaarLevel[];
}

export interface BazaarSnapshot {
  fetchedAt: number;
  products: Record<string, BazaarProductQuote>;
}

export interface ArbitrageLeg {
  shardId: string;
  quantity: number;
  unitCost: number;
  totalCost: number;
  method: "bazaar" | "craft";
  recipe?: {
    inputs: [string, string];
    outputQuantity: number;
  };
}

export interface ArbitrageOpportunity {
  shardId: string;
  shardName: string;
  rarity: string;
  recipe: {
    inputs: [string, string];
    outputQuantity: number;
  };
  /** Number of final shard units actually produced in the recommended batch. */
  outputQuantity: number;
  /** Number of final crafts in the recommended batch. */
  batchCrafts: number;
  inputCost: number;
  resaleUnitPrice: number;
  grossRevenue: number;
  saleTax: number;
  netRevenue: number;
  profit: number;
  roi: number;
  profitPerOutput: number;
  capitalRequired: number;
  acquisitionPath: ArbitrageLeg[];
  sellLiquidity: number;
  /** Peak simultaneous shard units held while executing the recommended batch. */
  peakInventoryUnits: number;
  /** Peak simultaneous shard stacks held, using the configured stack size. */
  peakInventoryStacks: number;
  capitalBudget: number;
  inventoryCapacityUnits: number;
  fetchedAt: number;
}

export interface ArbitrageOptions {
  saleTaxRate?: number;
  minOutputLiquidity?: number;
  limit?: number;
  /** Maximum coins allowed for one executable batch. */
  capitalBudget?: number;
  /** Maximum simultaneously-held shard stacks. */
  maxInventoryStacks?: number;
  /** Stack size used for shard inventory accounting. */
  stackSize?: number;
}
