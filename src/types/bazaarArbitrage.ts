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
  /** Average executable cost for this quantity across sell-offer levels. */
  unitCost: number;
  totalCost: number;
  /** Cheapest current sell-offer price: the true instant-buy price at snapshot time. */
  instantBuyUnitPrice: number;
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
  outputQuantity: number;
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
  peakInventoryUnits: number;
  peakInventoryStacks: number;
  capitalBudget: number;
  inventoryCapacityUnits: number;
  fetchedAt: number;
}

export interface ArbitrageOptions {
  saleTaxRate?: number;
  minOutputLiquidity?: number;
  limit?: number;
  capitalBudget?: number;
  maxInventoryStacks?: number;
  stackSize?: number;
}
