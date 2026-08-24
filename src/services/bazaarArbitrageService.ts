import { CalculationService } from "./calculationService";
import { DataService } from "./dataService";
import type { ArbitrageLeg, ArbitrageOpportunity, ArbitrageOptions, BazaarLevel } from "../types/bazaarArbitrage";
import type { CalculationParams, Data, Recipe, Shard } from "../types/types";

const DEFAULT_SALE_TAX = 0.01;
const DEFAULT_CAPITAL_BUDGET = 100_000_000;
const DEFAULT_INVENTORY_STACKS = 35;
const DEFAULT_STACK_SIZE = 64;
const MAX_CRAFT_SEARCH = 1_200;
const EPSILON = 1e-9;

type QuantityMap = Map<string, number>;

interface AcquisitionResult {
  cost: number;
  rawMaterials: QuantityMap;
}

interface BatchEvaluation {
  crafts: number;
  outputQuantity: number;
  rawMaterials: QuantityMap;
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

  /** Immediate-buy cost from the live sell-offer ladder. */
  public getInstantBuyCost(levels: BazaarLevel[], quantity: number): number {
    if (quantity <= EPSILON) return 0;
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

  /** Immediate-sell revenue from the live buy-order ladder. */
  public getInstantSellRevenue(levels: BazaarLevel[], quantity: number): number {
    if (quantity <= EPSILON) return 0;
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

  private addQuantity(target: QuantityMap, shardId: string, quantity: number): void {
    if (quantity <= EPSILON) return;
    target.set(shardId, (target.get(shardId) ?? 0) + quantity);
  }

  private mergeQuantities(target: QuantityMap, source: QuantityMap): void {
    for (const [shardId, quantity] of source) this.addQuantity(target, shardId, quantity);
  }

  /**
   * Compare direct immediate purchase vs every legal recursive fusion path at the
   * exact requested quantity. This is depth-aware: every direct purchase walks the
   * sell-offer ladder and therefore scales with actual order-book liquidity.
   */
  private getBestAcquisition(
    shardId: string,
    quantity: number,
    data: Data,
    snapshotProducts: Record<string, { sellSummary: BazaarLevel[] }>,
    shardsById: Map<string, Shard>,
    memo: Map<string, AcquisitionResult>,
    visiting: Set<string>
  ): AcquisitionResult {
    if (quantity <= EPSILON) return { cost: 0, rawMaterials: new Map() };

    const requested = Math.ceil(quantity - EPSILON);
    const memoKey = `${shardId}:${requested}`;
    const cached = memo.get(memoKey);
    if (cached) return { cost: cached.cost, rawMaterials: new Map(cached.rawMaterials) };

    if (visiting.has(shardId)) return { cost: Infinity, rawMaterials: new Map() };

    const shard = shardsById.get(shardId);
    const product = shard ? snapshotProducts[shard.internal_id] : undefined;
    let bestCost = product ? this.getInstantBuyCost(product.sellSummary, requested) : Infinity;
    let bestMaterials: QuantityMap = Number.isFinite(bestCost)
      ? new Map([[shardId, requested]])
      : new Map();

    const nextVisiting = new Set(visiting);
    nextVisiting.add(shardId);

    for (const recipe of data.recipes[shardId] ?? []) {
      if (recipe.outputQuantity <= 0) continue;
      const crafts = Math.ceil(requested / recipe.outputQuantity - EPSILON);
      const [inputA, inputB] = recipe.inputs;
      const shardA = data.shards[inputA];
      const shardB = data.shards[inputB];
      if (!shardA || !shardB) continue;

      const costA = this.getBestAcquisition(
        inputA,
        shardA.fuse_amount * crafts,
        data,
        snapshotProducts,
        shardsById,
        memo,
        nextVisiting
      );
      if (!Number.isFinite(costA.cost)) continue;

      const costB = this.getBestAcquisition(
        inputB,
        shardB.fuse_amount * crafts,
        data,
        snapshotProducts,
        shardsById,
        memo,
        nextVisiting
      );
      if (!Number.isFinite(costB.cost)) continue;

      const recipeCost = costA.cost + costB.cost;
      if (recipeCost + EPSILON < bestCost) {
        const materials: QuantityMap = new Map();
        this.mergeQuantities(materials, costA.rawMaterials);
        this.mergeQuantities(materials, costB.rawMaterials);
        bestCost = recipeCost;
        bestMaterials = materials;
      }
    }

    const result = { cost: bestCost, rawMaterials: new Map(bestMaterials) };
    memo.set(memoKey, result);
    return { cost: result.cost, rawMaterials: new Map(result.rawMaterials) };
  }

  private buildPurchaseLegs(
    rawMaterials: QuantityMap,
    snapshotProducts: Record<string, { sellSummary: BazaarLevel[] }>,
    shardsById: Map<string, Shard>
  ): ArbitrageLeg[] {
    return [...rawMaterials.entries()]
      .map(([shardId, quantity]) => {
        const shard = shardsById.get(shardId);
        const product = shard ? snapshotProducts[shard.internal_id] : undefined;
        const levels = product?.sellSummary ?? [];
        const totalCost = this.getInstantBuyCost(levels, quantity);
        const unitCost = quantity > EPSILON ? totalCost / quantity : Infinity;
        const instantBuyUnitPrice = levels[0]?.pricePerUnit ?? Infinity;
        return {
          shardId,
          quantity,
          unitCost,
          totalCost,
          instantBuyUnitPrice,
          method: "bazaar" as const,
        };
      })
      .filter((leg) => leg.quantity > 0)
      .sort((a, b) => b.totalCost - a.totalCost);
  }

  private estimatePeakRawInventory(rawMaterials: QuantityMap): number {
    let total = 0;
    for (const quantity of rawMaterials.values()) total += quantity;
    return total;
  }

  private evaluateBatch(
    targetShardId: string,
    recipe: Recipe,
    crafts: number,
    data: Data,
    snapshotProducts: Record<string, { sellSummary: BazaarLevel[]; buySummary: BazaarLevel[] }>,
    shardsById: Map<string, Shard>,
    saleTaxRate: number,
    capitalBudget: number,
    inventoryCapacityUnits: number,
    acquisitionMemo: Map<string, AcquisitionResult>
  ): BatchEvaluation {
    const outputQuantity = recipe.outputQuantity * crafts;
    const rawMaterials: QuantityMap = new Map();
    const inputA = data.shards[recipe.inputs[0]];
    const inputB = data.shards[recipe.inputs[1]];

    if (!inputA || !inputB) {
      return { crafts, outputQuantity, rawMaterials, inputCost: Infinity, grossRevenue: 0, saleTax: 0, netRevenue: -Infinity, profit: -Infinity, roi: -Infinity, peakInventoryUnits: Infinity, feasible: false };
    }

    const acquisitionA = this.getBestAcquisition(recipe.inputs[0], inputA.fuse_amount * crafts, data, snapshotProducts, shardsById, acquisitionMemo, new Set());
    const acquisitionB = this.getBestAcquisition(recipe.inputs[1], inputB.fuse_amount * crafts, data, snapshotProducts, shardsById, acquisitionMemo, new Set());

    if (!Number.isFinite(acquisitionA.cost) || !Number.isFinite(acquisitionB.cost)) {
      return { crafts, outputQuantity, rawMaterials, inputCost: Infinity, grossRevenue: 0, saleTax: 0, netRevenue: -Infinity, profit: -Infinity, roi: -Infinity, peakInventoryUnits: Infinity, feasible: false };
    }

    this.mergeQuantities(rawMaterials, acquisitionA.rawMaterials);
    this.mergeQuantities(rawMaterials, acquisitionB.rawMaterials);

    const inputCost = acquisitionA.cost + acquisitionB.cost;
    if (!Number.isFinite(inputCost) || inputCost > capitalBudget + EPSILON) {
      return { crafts, outputQuantity, rawMaterials, inputCost, grossRevenue: 0, saleTax: 0, netRevenue: -inputCost, profit: -Infinity, roi: -Infinity, peakInventoryUnits: this.estimatePeakRawInventory(rawMaterials), feasible: false };
    }

    const outputProduct = snapshotProducts[shardsById.get(targetShardId)?.internal_id ?? ""];
    if (!outputProduct) {
      return { crafts, outputQuantity, rawMaterials, inputCost, grossRevenue: 0, saleTax: 0, netRevenue: -inputCost, profit: -Infinity, roi: -Infinity, peakInventoryUnits: this.estimatePeakRawInventory(rawMaterials), feasible: false };
    }

    const grossRevenue = this.getInstantSellRevenue(outputProduct.buySummary, outputQuantity);
    if (!Number.isFinite(grossRevenue)) {
      return { crafts, outputQuantity, rawMaterials, inputCost, grossRevenue: 0, saleTax: 0, netRevenue: -inputCost, profit: -Infinity, roi: -Infinity, peakInventoryUnits: this.estimatePeakRawInventory(rawMaterials), feasible: false };
    }

    const saleTax = grossRevenue * saleTaxRate;
    const netRevenue = grossRevenue - saleTax;
    const profit = netRevenue - inputCost;
    const roi = inputCost > EPSILON ? profit / inputCost : Infinity;
    const peakInventoryUnits = this.estimatePeakRawInventory(rawMaterials);

    // The full batch can be executed in waves when raw materials exceed one inventory.
    // Inventory capacity therefore informs the displayed wave plan rather than falsely
    // forcing the total shopping list below 35 stacks.
    return {
      crafts,
      outputQuantity,
      rawMaterials,
      inputCost,
      grossRevenue,
      saleTax,
      netRevenue,
      profit,
      roi,
      peakInventoryUnits,
      feasible: inventoryCapacityUnits > 0,
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

    // IMPORTANT: do not use quick_status buyPrice or any current buy order as the input
    // price. The true immediate purchase starts at sell_summary[0], and batch costs walk
    // all subsequent sell-offer levels needed for the requested quantity.
    const instantBuyUnitPrices: Record<string, number> = {};
    for (const shard of shards) {
      const quote = snapshot.products[shard.internal_id];
      const price = quote?.sellSummary?.[0]?.pricePerUnit;
      if (price !== undefined) instantBuyUnitPrices[shard.id] = price;
    }

    const params = this.makeMarketParams(instantBuyUnitPrices);
    const calculationService = CalculationService.getInstance();
    const data = calculationService.buildData(fusionJson, defaultRates, params);
    const shardById = new Map(shards.map((shard) => [shard.id, shard]));
    const opportunities: ArbitrageOpportunity[] = [];

    for (const shard of shards) {
      const recipes = data.recipes[shard.id] ?? [];
      if (recipes.length === 0) continue;
      const quote = snapshot.products[shard.internal_id];
      if (!quote?.buySummary?.length) continue;

      const acquisitionMemo = new Map<string, AcquisitionResult>();
      const minOutput = Math.max(1, recipes.reduce((min, r) => Math.min(min, r.outputQuantity), Infinity));
      const maxCrafts = Math.max(1, Math.min(MAX_CRAFT_SEARCH, Math.floor(inventoryCapacityUnits / minOutput) * 8 + 64));

      for (const recipe of recipes) {
        if (recipe.outputQuantity <= 0) continue;

        let best: BatchEvaluation | null = null;
        for (let crafts = 1; crafts <= maxCrafts; crafts++) {
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
            acquisitionMemo
          );

          if (!evaluated.feasible || evaluated.profit <= EPSILON) continue;
          if (!best || evaluated.profit > best.profit || (Math.abs(evaluated.profit - best.profit) < EPSILON && evaluated.roi > best.roi)) {
            best = evaluated;
          }
        }

        if (!best) continue;

        const acquisitionPath = this.buildPurchaseLegs(best.rawMaterials, snapshot.products, shardById);
        const saleUnit = best.outputQuantity > 0 ? best.grossRevenue / best.outputQuantity : 0;

        opportunities.push({
          shardId: shard.id,
          shardName: shard.name,
          rarity: shard.rarity,
          recipe: { inputs: recipe.inputs, outputQuantity: recipe.outputQuantity },
          outputQuantity: best.outputQuantity,
          batchCrafts: best.crafts,
          inputCost: best.inputCost,
          resaleUnitPrice: saleUnit,
          grossRevenue: best.grossRevenue,
          saleTax: best.saleTax,
          netRevenue: best.netRevenue,
          profit: best.profit,
          roi: best.roi,
          profitPerOutput: best.profit / best.outputQuantity,
          capitalRequired: best.inputCost,
          acquisitionPath,
          sellLiquidity: quote.buySummary.reduce((sum, level) => sum + Math.max(0, level.amount), 0),
          peakInventoryUnits: best.peakInventoryUnits,
          peakInventoryStacks: best.peakInventoryUnits / stackSize,
          capitalBudget,
          inventoryCapacityUnits,
          fetchedAt: snapshot.fetchedAt,
        });
      }
    }

    // A+B and B+A are the same economic recipe.
    const unique = new Map<string, ArbitrageOpportunity>();
    for (const opportunity of opportunities) {
      const inputs = [...opportunity.recipe.inputs].sort().join("|");
      const key = `${opportunity.shardId}|${opportunity.recipe.outputQuantity}|${inputs}`;
      const existing = unique.get(key);
      if (!existing || opportunity.profit > existing.profit) unique.set(key, opportunity);
    }

    return [...unique.values()]
      .sort((a, b) => {
        if (b.profit !== a.profit) return b.profit - a.profit;
        if (b.roi !== a.roi) return b.roi - a.roi;
        return b.profitPerOutput - a.profitPerOutput;
      })
      .slice(0, limit);
  }
}
