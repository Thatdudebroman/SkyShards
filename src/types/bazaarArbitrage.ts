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
  outputQuantity: number;
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
  fetchedAt: number;
}

export interface ArbitrageOptions {
  saleTaxRate?: number;
  minOutputLiquidity?: number;
  limit?: number;
}
