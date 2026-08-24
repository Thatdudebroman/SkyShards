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
const MAX_CANDIDATES_PER_RECIPE = 36;
const MAX_RECURSION = 32;
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
    if (!BazaarArbitrageService.instance) BazaarArbitrageService.instance = new BazaarArbitrageService();
    return BazaarArbitrageService.instance;
  }

  /** Immediate-buy cost: consume cheapest live sell offers first, including depth. */
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

  /** Immediate-sell revenue: consume highest live buy orders first, including depth. */
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

  /** Compare direct immediate purchase with recursive fusion at the exact quantity. */
  private getBestAcquisition(
    shardId: string,
    quantity: number,
    data: Data,
    products: Record<string, { sellSummary: BazaarLevel[] }>,
    shardsById: Map<string, Shard>,
    memo: Map<string, AcquisitionResult>,
    visiting: Set<string>,
    depth: number
  ): AcquisitionResult {
    if (quantity <= EPSILON) return { cost: 0, rawMaterials: new Map() };
    if (depth > MAX_RECURSION || visiting.has(shardId)) return { cost: Infinity, rawMaterials: new Map() };

    const requested = Math.ceil(quantity - EPSILON);
    const memoKey = `${shardId}:${requested}`;
    const cached = memo.get(memoKey);
    if (cached) return { cost: cached.cost, rawMaterials: new Map(cached.rawMaterials) };

    const shard = shardsById.get(shardId);
    const product = shard ? products[shard.internal_id] : undefined;
    let bestCost = product ? this.getInstantBuyCost(product.sellSummary, requested) : Infinity;
    let bestMaterials: QuantityMap = Number.isFinite(bestCost) ? new Map([[shardId, requested]]) : new Map();

    const nextVisiting = new Set(visiting);
    nextVisiting.add(shardId);

    for (const recipe of data.recipes[shardId] ?? []) {
      if (recipe.outputQuantity <= 0) continue;
      const crafts = Math.ceil(requested / recipe.outputQuantity - EPSILON);
      const [inputA, inputB] = recipe.inputs;
      const shardA = data.shards[inputA];
      const shardB = data.shards[inputB];
      if (!shardA || !shardB) continue;

      const costA = this.getBestAcquisition(inputA, shardA.fuse_amount * crafts, data, products, shardsById, memo, nextVisiting, depth + 1);
      if (!Number.isFinite(costA.cost)) continue;
      const costB = this.getBestAcquisition(inputB, shardB.fuse_amount * crafts, data, products, shardsById, memo, nextVisiting, depth + 1);
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

    const result: AcquisitionResult = { cost: bestCost, rawMaterials: new Map(bestMaterials) };
    memo.set(memoKey, result);
    return { cost: result.cost, rawMaterials: new Map(result.rawMaterials) };
  }

  private buildPurchaseLegs(
    rawMaterials: QuantityMap,
    products: Record<string, { sellSummary: BazaarLevel[] }>,
    shardsById: Map<string, Shard>
  ): ArbitrageLeg[] {
    return [...rawMaterials.entries()]
      .map(([shardId, quantity]) => {
        const shard = shardsById.get(shardId);
        const levels = shard ? (products[shard.internal_id]?.sellSummary ?? []) : [];
        const totalCost = this.getInstantBuyCost(levels, quantity);
        return {
          shardId,
          quantity,
          unitCost: quantity > EPSILON ? totalCost / quantity : Infinity,
          totalCost,
          instantBuyUnitPrice: levels[0]?.pricePerUnit ?? Infinity,
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
    products: Record<string, { sellSummary: BazaarLevel[]; buySummary: BazaarLevel[] }>,
    shardsById: Map<string, Shard>,
    saleTaxRate: number,
    capitalBudget: number,
    inventoryCapacityUnits: number,
    memo: Map<string, AcquisitionResult>
  ): BatchEvaluation {
    const outputQuantity = recipe.outputQuantity * crafts;
    const [inputA, inputB] = recipe.inputs;
    const shardA = data.shards[inputA];
    const shardB = data.shards[inputB];
    if (!shardA || !shardB) return { crafts, outputQuantity, rawMaterials: new Map(), inputCost: Infinity, grossRevenue: 0, saleTax: 0, netRevenue: -Infinity, profit: -Infinity, roi: -Infinity, peakInventoryUnits: Infinity, feasible: false };

    const acquisitionA = this.getBestAcquisition(inputA, shardA.fuse_amount * crafts, data, products, shardsById, memo, new Set(), 0);
    const acquisitionB = this.getBestAcquisition(inputB, shardB.fuse_amount * crafts, data, products, shardsById, memo, new Set(), 0);
    if (!Number.isFinite(acquisitionA.cost) || !Number.isFinite(acquisitionB.cost)) return { crafts, outputQuantity, rawMaterials: new Map(), inputCost: Infinity, grossRevenue: 0, saleTax: 0, netRevenue: -Infinity, profit: -Infinity, roi: -Infinity, peakInventoryUnits: Infinity, feasible: false };

    const rawMaterials: QuantityMap = new Map();
    this.mergeQuantities(rawMaterials, acquisitionA.rawMaterials);
    this.mergeQuantities(rawMaterials, acquisitionB.rawMaterials);

    const inputCost = acquisitionA.cost + acquisitionB.cost;
    if (!Number.isFinite(inputCost) || inputCost > capitalBudget + EPSILON) return { crafts, outputQuantity, rawMaterials, inputCost, grossRevenue: 0, saleTax: 0, netRevenue: -inputCost, profit: -Infinity, roi: -Infinity, peakInventoryUnits: this.estimatePeakRawInventory(rawMaterials), feasible: false };

    const output = products[shardsById.get(targetShardId)?.internal_id ?? ""];
    if (!output) return { crafts, outputQuantity, rawMaterials, inputCost, grossRevenue: 0, saleTax: 0, netRevenue: -inputCost, profit: -Infinity, roi: -Infinity, peakInventoryUnits: this.estimatePeakRawInventory(rawMaterials), feasible: false };

    const grossRevenue = this.getInstantSellRevenue(output.buySummary, outputQuantity);
    if (!Number.isFinite(grossRevenue)) return { crafts, outputQuantity, rawMaterials, inputCost, grossRevenue: 0, saleTax: 0, netRevenue: -inputCost, profit: -Infinity, roi: -Infinity, peakInventoryUnits: this.estimatePeakRawInventory(rawMaterials), feasible: false };

    const saleTax = grossRevenue * saleTaxRate;
    const netRevenue = grossRevenue - saleTax;
    const profit = netRevenue - inputCost;
    return {
      crafts,
      outputQuantity,
      rawMaterials,
      inputCost,
      grossRevenue,
      saleTax,
      netRevenue,
      profit,
      roi: inputCost > EPSILON ? profit / inputCost : Infinity,
      peakInventoryUnits: this.estimatePeakRawInventory(rawMaterials),
      feasible: inventoryCapacityUnits > 0,
    };
  }

  /** Build a small candidate set around real order-book depth changes. */
  private buildCandidateCraftCounts(
    recipe: Recipe,
    targetQuote: { sellSummary: BazaarLevel[]; buySummary: BazaarLevel[] },
    data: Data,
    products: Record<string, { sellSummary: BazaarLevel[] }>,
    shardsById: Map<string, Shard>,
    inventoryCapacityUnits: number,
    capitalBudget: number
  ): number[] {
    const values = new Set<number>([1]);

    const addThresholds = (levels: BazaarLevel[], unitsPerCraft: number) => {
      if (unitsPerCraft <= 0) return;
      let cumulative = 0;
      for (const level of levels) {
        cumulative += Math.max(0, level.amount);
        const crafts = Math.floor(cumulative / unitsPerCraft);
        if (crafts >= 1) {
          values.add(crafts);
          values.add(crafts + 1);
        }
      }
    };

    addThresholds(targetQuote.buySummary, recipe.outputQuantity);
    for (const input of recipe.inputs) {
      const shard = data.shards[input];
      const product = shard ? products[shard.internal_id] : undefined;
      if (shard && product) addThresholds(product.sellSummary, shard.fuse_amount);
    }

    const rawUnitsPerCraft = recipe.inputs.reduce((sum, input) => sum + (data.shards[input]?.fuse_amount ?? 0), 0);
    if (rawUnitsPerCraft > 0 && inventoryCapacityUnits > 0) {
      const inventoryCrafts = Math.max(1, Math.floor(inventoryCapacityUnits / rawUnitsPerCraft));
      for (const multiplier of [1, 2, 3, 4]) {
        const point = inventoryCrafts * multiplier;
        values.add(point);
        values.add(Math.max(1, point - 1));
      }
    }

    const roughCapitalPerCraft = recipe.inputs.reduce((sum, input) => {
      const shard = data.shards[input];
      const product = shard ? products[shard.internal_id] : undefined;
      return sum + ((shard?.fuse_amount ?? 0) * (product?.sellSummary?.[0]?.pricePerUnit ?? 0));
    }, 0);
    if (roughCapitalPerCraft > 0 && Number.isFinite(roughCapitalPerCraft)) {
      const maxByCapital = Math.floor(capitalBudget / roughCapitalPerCraft);
      for (const fraction of [0.25, 0.5, 0.75, 1]) {
        const point = Math.floor(maxByCapital * fraction);
        if (point >= 1) values.add(point);
        if (point > 1) values.add(point - 1);
      }
    }

    for (const value of [2, 4, 8, 16, 32, 64, 128, 256, 512, 1024]) values.add(value);

    return [...values]
      .filter((value) => Number.isFinite(value) && value >= 1)
      .sort((a, b) => a - b)
      .slice(0, MAX_CANDIDATES_PER_RECIPE);
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

    // Inputs are ALWAYS priced from the live sell-offer side. We never use
    // quick_status.buyPrice or the buy-order side as an input price.
    const instantBuyUnitPrices: Record<string, number> = {};
    for (const shard of shards) {
      const price = snapshot.products[shard.internal_id]?.sellSummary?.[0]?.pricePerUnit;
      if (price !== undefined) instantBuyUnitPrices[shard.id] = price;
    }

    // Reuse SkyShards' canonical recipe/Shard graph.
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

      const candidateCounts = recipes.map((recipe) => this.buildCandidateCraftCounts(
        recipe,
        targetQuote,
        data,
        snapshot.products,
        shardById,
        inventoryCapacityUnits,
        capitalBudget
      ));

      for (let index = 0; index < recipes.length; index += 1) {
        const recipe = recipes[index];
        const candidates = candidateCounts[index] ?? [];
        if (!recipe) continue;

        const memo = new Map<string, AcquisitionResult>();
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
            memo
          );
          if (!evaluated.feasible || evaluated.profit <= EPSILON) continue;
          if (!best || evaluated.profit > best.profit || (Math.abs(evaluated.profit - best.profit) < EPSILON && evaluated.roi > best.roi)) best = evaluated;
        }

        if (best) {
          const acquisitionPath = this.buildPurchaseLegs(best.rawMaterials, snapshot.products, shardById);
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
            acquisitionPath,
            sellLiquidity: targetQuote.buySummary.reduce((sum, level) => sum + Math.max(0, level.amount), 0),
            peakInventoryUnits: best.peakInventoryUnits,
            peakInventoryStacks: best.peakInventoryUnits / stackSize,
            capitalBudget,
            inventoryCapacityUnits,
            fetchedAt: snapshot.fetchedAt,
          });
        }

        processedRecipes += 1;
        if (processedRecipes % 12 === 0) await new Promise<void>((resolve) => setTimeout(resolve, 0));
      }
    }

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
