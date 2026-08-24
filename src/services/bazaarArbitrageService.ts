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

  /**
   * Exact immediate-purchase cost for a quantity. Hypixel's sell_summary is the live
   * sell-offer ladder; consuming it from cheapest to most expensive is the correct
   * model for an instant buy. We never use buy_summary for input acquisition.
   */
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

  /**
   * Exact immediate-sale revenue for a quantity. buy_summary is the live buy-order
   * ladder; consuming it from highest to lowest is the executable instant-sell model.
   */
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
    for (const [shardId, quantity] of source) {
      this.addQuantity(target, shardId, quantity);
    }
  }

  /**
   * Depth-aware recursive acquisition optimizer.
   *
   * For a requested quantity, compare:
   *   1) buying that exact quantity immediately from the sell-offer ladder; and
   *   2) every legal fusion recipe, priced at the exact child quantities needed.
   *
   * This deliberately does not use quick_status, the lowest buy order, or a single
   * top-of-book quote extrapolated to the whole batch.
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

    const roundedQuantity = Math.ceil(quantity - EPSILON);
    const memoKey = `${shardId}:${roundedQuantity}`;
    const cached = memo.get(memoKey);
    if (cached) {
      return { cost: cached.cost, rawMaterials: new Map(cached.rawMaterials) };
    }

    if (visiting.has(shardId)) {
      return { cost: Infinity, rawMaterials: new Map() };
    }

    const shard = shardsById.get(shardId);
    const product = shard ? snapshotProducts[shard.internal_id] : undefined;
    let bestCost = product ? this.getInstantBuyCost(product.sellSummary, roundedQuantity) : Infinity;
    let bestMaterials: QuantityMap = product && Number.isFinite(bestCost)
      ? new Map([[shardId, roundedQuantity]])
      : new Map();

    const recipes = data.recipes[shardId] ?? [];
    const nextVisiting = new Set(visiting);
    nextVisiting.add(shardId);

    for (const recipe of recipes) {
      if (recipe.outputQuantity <= 0) continue;

      const crafts = Math.ceil(roundedQuantity / recipe.outputQuantity - EPSILON);
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
        const totalCost = product ? this.getInstantBuyCost(product.sellSummary, quantity) : Infinity;
        const unitCost = quantity > EPSILON ? totalCost / quantity : Infinity;
        return {
          shardId,
          quantity,
          unitCost,
          totalCost,
          method: "bazaar" as const,
        };
      })
      .filter((leg) => leg.quantity > 0)
      .sort((a, b) => b.totalCost - a.totalCost);
  }

  /**
   * Estimate the peak number of shards simultaneously needed for a batch. This is a
   * conservative raw-material view; the UI can still split a batch into buy/craft waves.
   */
  private estimatePeakRawInventory(rawMaterials: QuantityMap): number {
    let total = 0;
    for (const quantity of rawMaterials.values()) total += quantity;
    return total;
  }

  private evaluateBatch(
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
    const rawMaterials = new Map<string, number>();

    const inputA = data.shards[recipe.inputs[0]];
    const inputB = data.shards[recipe.inputs[1]];
    if (!inputA || !inputB) {
      return {
        crafts,
        outputQuantity,
        rawMaterials,
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

    const acquisitionA = this.getBestAcquisition(
      recipe.inputs[0],
      inputA.fuse_amount * crafts,
      data,
      snapshotProducts,
      shardsById,
      acquisitionMemo,
      new Set()
    );
    const acquisitionB = this.getBestAcquisition(
      recipe.inputs[1],
      inputB.fuse_amount * crafts,
      data,
      snapshotProducts,
      shardsById,
      acquisitionMemo,
      new Set()
    );

    if (!Number.isFinite(acquisitionA.cost) || !Number.isFinite(acquisitionB.cost)) {
      return {
        crafts,
        outputQuantity,
        rawMaterials,
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

    this.mergeQuantities(rawMaterials, acquisitionA.rawMaterials);
    this.mergeQuantities(rawMaterials, acquisitionB.rawMaterials);

    const inputCost = acquisitionA.cost + acquisitionB.cost;
    if (!Number.isFinite(inputCost) || inputCost > capitalBudget + EPSILON) {
      return {
        crafts,
        outputQuantity,
        rawMaterials,
        inputCost,
        grossRevenue: 0,
        saleTax: 0,
        netRevenue: -inputCost,
        profit: -Infinity,
        roi: -Infinity,
        peakInventoryUnits: this.estimatePeakRawInventory(rawMaterials),
        feasible: false,
      };
    }

    const outputShard = shardsById.get(data.shards[recipe.inputs[0]] ? recipe.inputs[0] : "");
    void outputShard;

    const targetShardId = Object.entries(data.recipes).find(([, recipes]) => recipes.includes(recipe))?.[0];
    const targetShard = targetShardId ? shardsById.get(targetShardId) : undefined;
    const outputProduct = targetShard ? snapshotProducts[targetShard.internal_id] : undefined;
    if (!outputProduct) {
      return {
        crafts,
        outputQuantity,
        rawMaterials,
        inputCost,
        grossRevenue: 0,
        saleTax: 0,
        netRevenue: -inputCost,
        profit: -Infinity,
        roi: -Infinity,
        peakInventoryUnits: this.estimatePeakRawInventory(rawMaterials),
        feasible: false,
      };
    }

    const grossRevenue = this.getInstantSellRevenue(outputProduct.buySummary, outputQuantity);
    if (!Number.isFinite(grossRevenue)) {
      return {
        crafts,
        outputQuantity,
        rawMaterials,
        inputCost,
        grossRevenue: 0,
        saleTax: 0,
        netRevenue: -inputCost,
        profit: -Infinity,
        roi: -Infinity,
        peakInventoryUnits: this.estimatePeakRawInventory(rawMaterials),
        feasible: false,
      };
    }

    const peakInventoryUnits = this.estimatePeakRawInventory(rawMaterials);
    // A batch may be larger than the physical inventory because it can be executed in
    // waves. The UI exposes those waves. Keep the capacity as a warning rather than
    // discarding otherwise profitable market-depth opportunities.
    const saleTax = grossRevenue * saleTaxRate;
    const netRevenue = grossRevenue - saleTax;
    const profit = netRevenue - inputCost;
    const roi = inputCost > EPSILON ? profit / inputCost : Infinity;

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
      feasible: peakInventoryUnits > 0 || inventoryCapacityUnits > 0,
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

    // quick_status is intentionally not used. It is a weighted summary, not an
    // executable price for an arbitrary quantity. The input price source is the
    // lowest current sell-offer level in sell_summary.
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
      let maxCrafts = Math.floor(MAX_CRAFT_SEARCH / Math.max(1, recipes.reduce((min, recipe) => Math.min(min, recipe.outputQuantity), Infinity)));
      maxCrafts = Math.max(1, maxCrafts);

      for (const recipe of recipes) {
        if (recipe.outputQuantity <= 0) continue;

        let maxFeasibleCrafts = Math.min(maxCrafts, Math.floor(inventoryCapacityUnits / Math.max(1, recipe.outputQuantity)) * 4 + 1);
        maxFeasibleCrafts = Math.max(1, maxFeasibleCrafts);

        let best: BatchEvaluation | null = null;
        // Scan every craft count in the practical range. This is intentional: order-book
        // depth creates discontinuities whenever a sell-offer level is exhausted, so a
        // coarse ROI sample can miss the best executable batch.
        for (let crafts = 1; crafts <= maxFeasibleCrafts; crafts++) {
          const evaluated = this.evaluateBatch(
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

    // Remove mirrored recipe entries (A+B and B+A are economically identical).
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
