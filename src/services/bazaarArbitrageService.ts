import { CalculationService } from "./calculationService";
import { DataService } from "./dataService";
import type {
  ArbitrageLeg,
  ArbitrageOpportunity,
  ArbitrageOptions,
  BazaarLevel,
} from "../types/bazaarArbitrage";
import type { CalculationParams, Data, Recipe } from "../types/types";

const DEFAULT_SALE_TAX = 0.01;
const EPSILON = 1e-9;

export class BazaarArbitrageService {
  private static instance: BazaarArbitrageService;

  public static getInstance(): BazaarArbitrageService {
    if (!BazaarArbitrageService.instance) {
      BazaarArbitrageService.instance = new BazaarArbitrageService();
    }
    return BazaarArbitrageService.instance;
  }

  /**
   * Returns the exact cost of instantly buying `quantity` units by walking the live
   * sell-order book from cheapest to most expensive. This deliberately never uses a
   * buy order / waiting strategy.
   */
  public getInstantBuyCost(levels: BazaarLevel[], quantity: number): number {
    let remaining = quantity;
    let total = 0;

    for (const level of levels) {
      if (remaining <= EPSILON) break;
      if (level.amount <= 0 || level.pricePerUnit < 0) continue;

      const filled = Math.min(remaining, level.amount);
      total += filled * level.pricePerUnit;
      remaining -= filled;
    }

    return remaining > EPSILON ? Infinity : total;
  }

  /**
   * Returns the exact revenue from instantly selling `quantity` units by walking the
   * live buy-order book from highest to lowest. This is the conservative, immediately
   * executable exit price used by the default optimizer.
   */
  public getInstantSellRevenue(levels: BazaarLevel[], quantity: number): number {
    let remaining = quantity;
    let total = 0;

    for (const level of levels) {
      if (remaining <= EPSILON) break;
      if (level.amount <= 0 || level.pricePerUnit < 0) continue;

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

  private buildAcquisitionLegs(
    shardId: string,
    quantity: number,
    data: Data,
    choices: Map<string, { recipe: Recipe | null }>,
    seen: Set<string> = new Set()
  ): ArbitrageLeg[] {
    if (quantity <= EPSILON) return [];
    if (seen.has(shardId)) {
      return [{ shardId, quantity, unitCost: Infinity, totalCost: Infinity, method: "bazaar" }];
    }

    const choice = choices.get(shardId)?.recipe;
    if (!choice) {
      const unitCost = data.shards[shardId]?.rate ?? Infinity;
      return [{ shardId, quantity, unitCost, totalCost: unitCost * quantity, method: "bazaar" }];
    }

    const [inputA, inputB] = choice.inputs;
    const outputQuantity = choice.outputQuantity;
    const craftsNeeded = Math.ceil(quantity / outputQuantity);
    const nextSeen = new Set(seen);
    nextSeen.add(shardId);

    return [
      {
        shardId,
        quantity: outputQuantity * craftsNeeded,
        unitCost: 0,
        totalCost: 0,
        method: "craft",
        recipe: { inputs: choice.inputs, outputQuantity },
      },
      ...this.buildAcquisitionLegs(
        inputA,
        data.shards[inputA].fuse_amount * craftsNeeded,
        data,
        choices,
        nextSeen
      ),
      ...this.buildAcquisitionLegs(
        inputB,
        data.shards[inputB].fuse_amount * craftsNeeded,
        data,
        choices,
        nextSeen
      ),
    ];
  }

  /**
   * Rank craft opportunities using current Bazaar data. The candidate recipe itself is
   * forced to be crafted; its inputs may be direct-bought or recursively crafted at the
   * cheapest available unit cost.
   */
  public async findOpportunities(options: ArbitrageOptions = {}): Promise<ArbitrageOpportunity[]> {
    const saleTaxRate = options.saleTaxRate ?? DEFAULT_SALE_TAX;
    const minOutputLiquidity = options.minOutputLiquidity ?? 1;
    const limit = options.limit ?? 50;

    const dataService = DataService.getInstance();
    const [snapshot, fusionJson, defaultRates, shards] = await Promise.all([
      dataService.loadBazaarSnapshot(true),
      dataService.loadFusionJson(),
      dataService.loadDefaultRates(),
      dataService.loadShards(),
    ]);

    // Unit prices used by the existing fusion optimizer are explicitly the cost of
    // immediate acquisition: the cheapest live sell offer for each product.
    const instantBuyUnitPrices: Record<string, number> = {};
    const shardById = new Map(shards.map((shard) => [shard.id, shard]));
    for (const shard of shards) {
      const quote = snapshot.products[shard.internal_id];
      const price = quote?.instantBuy?.pricePerUnit;
      if (price !== undefined) instantBuyUnitPrices[shard.id] = price;
    }

    const params = this.makeMarketParams(instantBuyUnitPrices);
    const calculationService = CalculationService.getInstance();
    const data = calculationService.buildData(fusionJson, defaultRates, params);
    const { minCosts, choices } = calculationService.computeMinCosts(data, params);

    const opportunities: ArbitrageOpportunity[] = [];

    for (const shard of shards) {
      const recipes = data.recipes[shard.id] ?? [];
      if (recipes.length === 0) continue;

      const quote = snapshot.products[shard.internal_id];
      if (!quote?.instantSell) continue;

      for (const recipe of recipes) {
        const [inputA, inputB] = recipe.inputs;
        const inputAUnitCost = minCosts.get(inputA) ?? Infinity;
        const inputBUnitCost = minCosts.get(inputB) ?? Infinity;
        const fuseA = data.shards[inputA].fuse_amount;
        const fuseB = data.shards[inputB].fuse_amount;
        const craftOutput = recipe.outputQuantity;
        const inputCost = inputAUnitCost * fuseA + inputBUnitCost * fuseB;

        if (!Number.isFinite(inputCost) || craftOutput <= 0) continue;

        const saleCapacity = quote.buySummary.reduce((sum, level) => sum + Math.max(0, level.amount), 0);
        if (saleCapacity + EPSILON < minOutputLiquidity) continue;

        // Evaluate one complete craft. Quantity scaling can then be simulated from the
        // live order book without pretending that one top-of-book quote has infinite depth.
        const executableQuantity = Math.min(craftOutput, saleCapacity);
        const sellRevenue = this.getInstantSellRevenue(quote.buySummary, executableQuantity);
        if (!Number.isFinite(sellRevenue)) continue;

        const proportionalInputCost = inputCost * (executableQuantity / craftOutput);
        const grossRevenue = sellRevenue;
        const saleTax = grossRevenue * saleTaxRate;
        const netRevenue = grossRevenue - saleTax;
        const profit = netRevenue - proportionalInputCost;
        if (profit <= EPSILON) continue;

        const roi = proportionalInputCost > 0 ? profit / proportionalInputCost : Infinity;
        const legs = this.buildAcquisitionLegs(inputA, fuseA, data, choices);
        legs.push(...this.buildAcquisitionLegs(inputB, fuseB, data, choices));

        opportunities.push({
          shardId: shard.id,
          shardName: shard.name,
          rarity: shard.rarity,
          recipe: { inputs: recipe.inputs, outputQuantity: recipe.outputQuantity },
          outputQuantity: executableQuantity,
          inputCost: proportionalInputCost,
          resaleUnitPrice: grossRevenue / executableQuantity,
          grossRevenue,
          saleTax,
          netRevenue,
          profit,
          roi,
          profitPerOutput: profit / executableQuantity,
          capitalRequired: proportionalInputCost,
          acquisitionPath: legs,
          sellLiquidity: saleCapacity,
          fetchedAt: snapshot.fetchedAt,
        });
      }
    }

    opportunities.sort((a, b) => {
      if (b.profitPerOutput !== a.profitPerOutput) return b.profitPerOutput - a.profitPerOutput;
      return b.roi - a.roi;
    });

    return opportunities.slice(0, limit);
  }
}
