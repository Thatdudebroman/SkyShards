export type BazaarExecutionSide = "instant_buy" | "instant_sell";

export interface BazaarLevel {
  amount: number;
  pricePerUnit: number;
  orders: number;
}

export interface BazaarProductQuote {
  productId: string;
  /** Cheapest currently executable price to BUY units immediately from sell offers. */
  instantBuy: BazaarLevel | null;
  /** Highest currently executable price to SELL units immediately into buy orders. */
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
  /** Coins charged on Bazaar sell transactions. Default 1.25%. */
  saleTaxRate?: number;
  /** Only report opportunities that can be executed against this many output units. */
  minOutputLiquidity?: number;
  /** Maximum number of ranked opportunities to return. */
  limit?: number;
}
