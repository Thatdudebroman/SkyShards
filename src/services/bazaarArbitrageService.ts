import { CalculationService } from "./calculationService";
import { DataService } from "./dataService";
import type {
  ArbitrageLeg,
  ArbitrageOpportunity,
  ArbitrageOptions,
  BazaarLevel,
} from "../types/bazaarArbitrage";
import type { CalculationParams, Data, Recipe, Shard } from "../types/types";

const DEFAULT_SALE_TAX = 0.01;
const DEFAULT_CAPITAL_BUDGET = 100_000_000;
const DEFAULT_INVENTORY_STACKS = 35;
const DEFAULT_STACK_SIZE = 64;
const MAX_CANDIDATES_PER_RECIPE = 32;
const EPSILON = 1e-9;

type MarketProduct = {
  sellSummary: BazaarLevel[];
  buySummary: BazaarLevel[];
};

interface BatchEvaluation {
  crafts: number;
  outputQuantity: number;
  inputQuantities: [number, number];
  inputCost: number;
  grossRevenue: number;
  saleTax: number;
  netRevenue: number;
  profit: number;
  roi: number;
  peakInventoryUnits: number;
  feasible: boolean;
}

export class BazaarArbitrageService {
  private static instance: BazaarArbitrageService;

  public static getInstance(): BazaarArbitrageService {
    if (!BazaarArbitrageService.instance) {
      BazaarArbitrageService.instance = new BazaarArbitrageService();
    }
    return BazaarArbitrageService.instance;
  }

  /**
   * Normalize the live sell side for immediate purchases. Cheapest offer first.
   * This is deliberately independent of quick_status and buy-order prices.
   */
  private sortedSellLevels(levels: BazaarLevel[]): BazaarLevel[] {
    return levels
      .filter((level) => level.amount > 0 && level.pricePerUnit >= 0)
      .slice()
      .sort((a, b) => a.pricePerUnit - b.pricePerUnit);
  }

  /** Normalize the live buy side for immediate sales. Highest bid first. */
  private sortedBuyLevels(levels: BazaarLevel[]): BazaarLevel[] {
    return levels
      .filter((level) => level.amount > 0 && level.pricePerUnit >= 0)
      .slice()
      .sort((a, b) => b.pricePerUnit - a.pricePerUnit);
  }

  /** Immediate-buy cost from the actual live sell-offer depth. */
  public getInstantBuyCost(levels: BazaarLevel[], quantity: number): number {
    if (quantity <= EPSILON) return 0;

    let remaining = quantity;
    let total = 0;
    for (const level of this.sortedSellLevels(levels)) {
      if (remaining <= EPSILON) break;
      const filled = Math.min(remaining, level.amount);
      total += filled * level.pricePerUnit;
      remaining -= filled;
    }

    return remaining > EPSILON ? Infinity : total;
  }

  /** Immediate-sell revenue from the actual live buy-order depth. */
  public getInstantSellRevenue(levels: BazaarLevel[], quantity: number): number {
    if (quantity <= EPSILON) return 0;

    let remaining = quantity;
    let total = 0;
    for (const level of this.sortedBuyLevels(levels)) {
      if (remaining <= EPSILON) break;
      const filled = Math.min(remaining, level.amount);
      total += filled * level.pricePerUnit;
      remaining -= filled;
    }

    return remaining > EPSILON ? -Infinity : total;
  }

  private makeMarketParams(prices: Record<string, number>): CalculationParams {
    return {
      customRates: prices,
      hunterFortune: 0,
      excludeChameleon: true,
      frogBonus: false,
      newtLevel: 0,
      salamanderLevel: 0,
      lizardKingLevel: 0,
      leviathanLevel: 0,
      pythonLevel: 0,
      kingCobraLevel: 0,
      seaSerpentLevel: 0,
      tiamatLevel: 0,
      crocodileLevel: 0,
      kuudraTier: "none",
      moneyPerHour: null,
      customKuudraTime: false,
      kuudraTimeSeconds: null,
      noWoodenBait: false,
      rateAsCoinValue: true,
      craftPenalty: 0,
    };
  }

  private buildPurchaseLeg(
    shardId: string,
    quantity: number,
    product: MarketProduct | undefined,
  ): ArbitrageLeg {
    const levels = product?.sellSummary ?? [];
    const totalCost = this.getInstantBuyCost(levels, quantity);
    const sorted = this.sortedSellLevels(levels);
    return {
      shardId,
      quantity,
      unitCost: quantity > EPSILON ? totalCost / quantity : Infinity,
      totalCost,
      instantBuyUnitPrice: sorted[0]?.pricePerUnit ?? Infinity,
      method: "bazaar",
    };
  }

  private buildCandidateCraftCounts(
    recipe: Recipe,
    targetQuote: MarketProduct,
    inputQuotes: [MarketProduct | undefined, MarketProduct | undefined],
    inputFuseAmounts: [number, number],
    inventoryCapacityUnits: number,
    capitalBudget: number,
  ): number[] {
    const values = new Set<number>([1, 2, 4, 8, 16, 32]);

    const addDepthBreakpoints = (levels: BazaarLevel[], unitsPerCraft: number) => {
      if (unitsPerCraft <= 0) return;
      let cumulative = 0;
      for (const level of levels) {
        cumulative += Math.max(0, level.amount);
        const craftsAtBoundary = Math.floor(cumulative / unitsPerCraft);
        if (craftsAtBoundary >= 1) {
          values.add(craftsAtBoundary);
          values.add(craftsAtBoundary + 1);
        }
      }
    };

    addDepthBreakpoints(inputQuotes[0]?.sellSummary ?? [], inputFuseAmounts[0]);
    addDepthBreakpoints(inputQuotes[1]?.sellSummary ?? [], inputFuseAmounts[1]);
    addDepthBreakpoints(targetQuote.buySummary, recipe.outputQuantity);

    const rawPerCraft = inputFuseAmounts[0] + inputFuseAmounts[1];
    if (rawPerCraft > 0 && inventoryCapacityUnits > 0) {
      const oneWave = Math.max(1, Math.floor(inventoryCapacityUnits / rawPerCraft));
      for (const multiplier of [1, 2, 3, 4]) {
        const point = oneWave * multiplier;
        values.add(point);
        if (point > 1) values.add(point - 1);
      }
    }

    const roughCostPerCraft = inputFuseAmounts.reduce((sum, fuseAmount, index) => {
      const firstLevel = this.sortedSellLevels(inputQuotes[index]?.sellSummary ?? [])[0];
      return sum + fuseAmount * (firstLevel?.pricePerUnit ?? 0);
    }, 0);

    if (roughCostPerCraft > 0 && Number.isFinite(roughCostPerCraft)) {
      const maxByCapital = Math.floor(capitalBudget / roughCostPerCraft);
      for (const fraction of [0.25, 0.5, 0.75, 1]) {
        const point = Math.floor(maxByCapital * fraction);
        if (point >= 1) values.add(point);
        if (point > 1) values.add(point - 1);
      }
    }

    return [...values]
      .filter((value) => Number.isFinite(value) && value >= 1)
      .sort((a, b) => a - b)
      .slice(0, MAX_CANDIDATES_PER_RECIPE);
  }

  private evaluateBatch(
    targetShardId: string,
    recipe: Recipe,
    crafts: number,
    data: Data,
    products: Record<string, MarketProduct>,
    shardsById: Map<string, Shard>,
    saleTaxRate: number,
    capitalBudget: number,
    inventoryCapacityUnits: number,
  ): BatchEvaluation {
    const [inputA, inputB] = recipe.inputs;
    const shardA = data.shards[inputA];
    const shardB = data.shards[inputB];
    if (!shardA || !shardB) {
      return {
        crafts,
        outputQuantity: 0,
        inputQuantities: [0, 0],
        inputCost: Infinity,
        grossRevenue: 0,
        saleTax: 0,
        netRevenue: -Infinity,
        profit: -Infinity,
        roi: -Infinity,
        peakInventoryUnits: Infinity,
        feasible: false,
      };
    }

    const inputQuantities: [number, number] = [
      shardA.fuse_amount * crafts,
      shardB.fuse_amount * crafts,
    ];

    const quoteA = products[shardA.internal_id];
    const quoteB = products[shardB.internal_id];
    const outputQuote = products[shardsById.get(targetShardId)?.internal_id ?? ""];

    if (!quoteA || !quoteB || !outputQuote) {
      return {
        crafts,
        outputQuantity: recipe.outputQuantity * crafts,
        inputQuantities,
        inputCost: Infinity,
        grossRevenue: 0,
        saleTax: 0,
        netRevenue: -Infinity,
        profit: -Infinity,
        roi: -Infinity,
        peakInventoryUnits: Infinity,
        feasible: false,
      };
    }

    const costA = this.getInstantBuyCost(quoteA.sellSummary, inputQuantities[0]);
    const costB = this.getInstantBuyCost(quoteB.sellSummary, inputQuantities[1]);
    const inputCost = costA + costB;
    const outputQuantity = recipe.outputQuantity * crafts;
    const peakInventoryUnits = inputQuantities[0] + inputQuantities[1];

    if (!Number.isFinite(inputCost) || inputCost > capitalBudget + EPSILON || peakInventoryUnits > inventoryCapacityUnits + EPSILON) {
      return {
        crafts,
        outputQuantity,
        inputQuantities,
        inputCost,
        grossRevenue: 0,
        saleTax: 0,
        netRevenue: -inputCost,
        profit: -Infinity,
        roi: -Infinity,
        peakInventoryUnits,
        feasible: false,
      };
    }

    const grossRevenue = this.getInstantSellRevenue(outputQuote.buySummary, outputQuantity);
    if (!Number.isFinite(grossRevenue)) {
      return {
        crafts,
        outputQuantity,
        inputQuantities,
        inputCost,
        grossRevenue: 0,
        saleTax: 0,
        netRevenue: -inputCost,
        profit: -Infinity,
        roi: -Infinity,
        peakInventoryUnits,
        feasible: false,
      };
    }

    const saleTax = grossRevenue * saleTaxRate;
    const netRevenue = grossRevenue - saleTax;
    const profit = netRevenue - inputCost;

    return {
      crafts,
      outputQuantity,
      inputQuantities,
      inputCost,
      grossRevenue,
      saleTax,
      netRevenue,
      profit,
      roi: inputCost > EPSILON ? profit / inputCost : Infinity,
      peakInventoryUnits,
      feasible: true,
    };
  }

  public async findOpportunities(options: ArbitrageOptions = {}): Promise<ArbitrageOpportunity[]> {
    const saleTaxRate = options.saleTaxRate ?? DEFAULT_SALE_TAX;
    const limit = options.limit ?? 50;
    const capitalBudget = options.capitalBudget ?? DEFAULT_CAPITAL_BUDGET;
    const maxInventoryStacks = options.maxInventoryStacks ?? DEFAULT_INVENTORY_STACKS;
    const stackSize = options.stackSize ?? DEFAULT_STACK_SIZE;
    const inventoryCapacityUnits = maxInventoryStacks * stackSize;

    const dataService = DataService.getInstance();
    const [snapshot, fusionJson, defaultRates, shards] = await Promise.all([
      dataService.loadBazaarSnapshot(true),
      dataService.loadFusionJson(),
      dataService.loadDefaultRates(),
      dataService.loadShards(),
    ]);

    // The only input price used by this optimizer is the live sell-side order book.
    // quick_status.buyPrice and buy-summary prices are never used to acquire inputs.
    const instantBuyUnitPrices: Record<string, number> = {};
    for (const shard of shards) {
      const sellLevels = snapshot.products[shard.internal_id]?.sellSummary ?? [];
      const startPrice = this.sortedSellLevels(sellLevels)[0]?.pricePerUnit;
      if (startPrice !== undefined) instantBuyUnitPrices[shard.id] = startPrice;
    }

    const params = this.makeMarketParams(instantBuyUnitPrices);
    const calculationService = CalculationService.getInstance();
    const data = calculationService.buildData(fusionJson, defaultRates, params);
    const shardById = new Map(shards.map((shard) => [shard.id, shard]));
    const opportunities: ArbitrageOpportunity[] = [];

    let processedRecipes = 0;
    for (const shard of shards) {
      const recipes = data.recipes[shard.id] ?? [];
      const targetQuote = snapshot.products[shard.internal_id];
      if (recipes.length === 0 || !targetQuote?.buySummary?.length) continue;

      for (const recipe of recipes) {
        const inputA = data.shards[recipe.inputs[0]];
        const inputB = data.shards[recipe.inputs[1]];
        if (!inputA || !inputB) continue;

        const inputQuotes: [MarketProduct | undefined, MarketProduct | undefined] = [
          snapshot.products[inputA.internal_id],
          snapshot.products[inputB.internal_id],
        ];

        const candidates = this.buildCandidateCraftCounts(
          recipe,
          targetQuote,
          inputQuotes,
          [inputA.fuse_amount, inputB.fuse_amount],
          inventoryCapacityUnits,
          capitalBudget,
        );

        let best: BatchEvaluation | null = null;
        for (const crafts of candidates) {
          const evaluated = this.evaluateBatch(
            shard.id,
            recipe,
            crafts,
            data,
            snapshot.products,
            shardById,
            saleTaxRate,
            capitalBudget,
            inventoryCapacityUnits,
          );

          if (!evaluated.feasible || evaluated.profit <= EPSILON) continue;
          if (!best || evaluated.profit > best.profit || (Math.abs(evaluated.profit - best.profit) < EPSILON && evaluated.roi > best.roi)) {
            best = evaluated;
          }
        }

        if (best) {
          const quoteA = snapshot.products[inputA.internal_id];
          const quoteB = snapshot.products[inputB.internal_id];
          const purchaseA = this.buildPurchaseLeg(inputA.id, best.inputQuantities[0], quoteA);
          const purchaseB = this.buildPurchaseLeg(inputB.id, best.inputQuantities[1], quoteB);

          opportunities.push({
            shardId: shard.id,
            shardName: shard.name,
            rarity: shard.rarity,
            recipe: { inputs: recipe.inputs, outputQuantity: recipe.outputQuantity },
            outputQuantity: best.outputQuantity,
            batchCrafts: best.crafts,
            inputCost: best.inputCost,
            resaleUnitPrice: best.outputQuantity > 0 ? best.grossRevenue / best.outputQuantity : 0,
            grossRevenue: best.grossRevenue,
            saleTax: best.saleTax,
            netRevenue: best.netRevenue,
            profit: best.profit,
            roi: best.roi,
            profitPerOutput: best.profit / best.outputQuantity,
            capitalRequired: best.inputCost,
            acquisitionPath: [purchaseA, purchaseB].sort((a, b) => b.totalCost - a.totalCost),
            sellLiquidity: this.sortedBuyLevels(targetQuote.buySummary).reduce((sum, level) => sum + level.amount, 0),
            peakInventoryUnits: best.peakInventoryUnits,
            peakInventoryStacks: best.peakInventoryUnits / stackSize,
            capitalBudget,
            inventoryCapacityUnits,
            fetchedAt: snapshot.fetchedAt,
          });
        }

        processedRecipes += 1;
        if (processedRecipes % 16 === 0) {
          await new Promise<void>((resolve) => setTimeout(resolve, 0));
        }
      }
    }

    // Treat A+B and B+A as the same economic recipe.
    const unique = new Map<string, ArbitrageOpportunity>();
    for (const opportunity of opportunities) {
      const inputs = [...opportunity.recipe.inputs].sort().join("|");
      const key = `${opportunity.shardId}|${opportunity.recipe.outputQuantity}|${inputs}`;
      const existing = unique.get(key);
      if (!existing || opportunity.profit > existing.profit) unique.set(key, opportunity);
    }

    return [...unique.values()]
      .sort((a, b) => b.profit - a.profit || b.roi - a.roi || b.profitPerOutput - a.profitPerOutput)
      .slice(0, limit);
  }
}
