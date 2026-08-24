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
const EPSILON = 1e-9;

type RecipeChoiceMap = Map<string, { recipe: Recipe | null }>;
type QuantityMap = Map<string, number>;

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

interface InventorySimulation {
  requiredQuantity: number;
  producedQuantity: number;
  peakUnits: number;
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

  private addQuantity(target: QuantityMap, shardId: string, quantity: number): void {
    if (quantity <= EPSILON) return;
    target.set(shardId, (target.get(shardId) ?? 0) + quantity);
  }

  /** Expand one requested quantity into the cheapest recursive acquisition path. */
  private collectRawMaterials(
    shardId: string,
    quantity: number,
    data: Data,
    choices: RecipeChoiceMap,
    output: QuantityMap,
    seen: Set<string> = new Set()
  ): boolean {
    if (quantity <= EPSILON) return true;
    if (seen.has(shardId)) return false;

    const choice = choices.get(shardId)?.recipe;
    if (!choice) {
      this.addQuantity(output, shardId, quantity);
      return true;
    }

    const outputQuantity = choice.outputQuantity;
    if (outputQuantity <= EPSILON) return false;

    const craftsNeeded = Math.ceil(quantity / outputQuantity - EPSILON);
    const nextSeen = new Set(seen);
    nextSeen.add(shardId);

    const [inputA, inputB] = choice.inputs;
    const shardA = data.shards[inputA];
    const shardB = data.shards[inputB];
    if (!shardA || !shardB) return false;

    return (
      this.collectRawMaterials(inputA, shardA.fuse_amount * craftsNeeded, data, choices, output, nextSeen) &&
      this.collectRawMaterials(inputB, shardB.fuse_amount * craftsNeeded, data, choices, output, nextSeen)
    );
  }

  /** Simulate crafting branches and estimate the exact peak shard count held. */
  private simulateProduction(
    shardId: string,
    quantity: number,
    data: Data,
    choices: RecipeChoiceMap,
    seen: Set<string> = new Set()
  ): InventorySimulation {
    if (quantity <= EPSILON) return { requiredQuantity: 0, producedQuantity: 0, peakUnits: 0, feasible: true };
    if (seen.has(shardId)) return { requiredQuantity: quantity, producedQuantity: 0, peakUnits: Infinity, feasible: false };

    const choice = choices.get(shardId)?.recipe;
    if (!choice) {
      return { requiredQuantity: quantity, producedQuantity: quantity, peakUnits: quantity, feasible: true };
    }

    const outputQuantity = choice.outputQuantity;
    if (outputQuantity <= EPSILON) return { requiredQuantity: quantity, producedQuantity: 0, peakUnits: Infinity, feasible: false };

    const craftsNeeded = Math.ceil(quantity / outputQuantity - EPSILON);
    const [inputA, inputB] = choice.inputs;
    const shardA = data.shards[inputA];
    const shardB = data.shards[inputB];
    if (!shardA || !shardB) return { requiredQuantity: quantity, producedQuantity: 0, peakUnits: Infinity, feasible: false };

    const requiredA = shardA.fuse_amount * craftsNeeded;
    const requiredB = shardB.fuse_amount * craftsNeeded;
    const nextSeen = new Set(seen);
    nextSeen.add(shardId);

    const a = this.simulateProduction(inputA, requiredA, data, choices, nextSeen);
    const b = this.simulateProduction(inputB, requiredB, data, choices, nextSeen);
    if (!a.feasible || !b.feasible) return { requiredQuantity: quantity, producedQuantity: 0, peakUnits: Infinity, feasible: false };

    const peakAB = Math.max(a.peakUnits, a.producedQuantity + b.peakUnits, a.producedQuantity + b.producedQuantity - requiredA - requiredB + outputQuantity * craftsNeeded);
    const peakBA = Math.max(b.peakUnits, b.producedQuantity + a.peakUnits, b.producedQuantity + a.producedQuantity - requiredA - requiredB + outputQuantity * craftsNeeded);

    return {
      requiredQuantity: quantity,
      producedQuantity: outputQuantity * craftsNeeded,
      peakUnits: Math.min(peakAB, peakBA),
      feasible: true,
    };
  }

  private buildAcquisitionLegs(
    shardId: string,
    quantity: number,
    data: Data,
    choices: RecipeChoiceMap,
    seen: Set<string> = new Set()
  ): ArbitrageLeg[] {
    if (quantity <= EPSILON) return [];
    if (seen.has(shardId)) return [{ shardId, quantity, unitCost: Infinity, totalCost: Infinity, method: "bazaar" }];

    const choice = choices.get(shardId)?.recipe;
    if (!choice) {
      const unitCost = data.shards[shardId]?.rate ?? Infinity;
      return [{ shardId, quantity, unitCost, totalCost: unitCost * quantity, method: "bazaar" }];
    }

    const craftsNeeded = Math.ceil(quantity / choice.outputQuantity - EPSILON);
    const nextSeen = new Set(seen);
    nextSeen.add(shardId);
    const [inputA, inputB] = choice.inputs;

    return [
      {
        shardId,
        quantity: choice.outputQuantity * craftsNeeded,
        unitCost: 0,
        totalCost: 0,
        method: "craft",
        recipe: { inputs: choice.inputs, outputQuantity: choice.outputQuantity },
      },
      ...this.buildAcquisitionLegs(inputA, data.shards[inputA].fuse_amount * craftsNeeded, data, choices, nextSeen),
      ...this.buildAcquisitionLegs(inputB, data.shards[inputB].fuse_amount * craftsNeeded, data, choices, nextSeen),
    ];
  }

  private getOrderBookThresholdCraftCounts(levels: BazaarLevel[], unitsPerCraft: number, maxCrafts: number): number[] {
    if (unitsPerCraft <= EPSILON || maxCrafts <= 0) return [];
    const thresholds: number[] = [];
    let cumulative = 0;
    for (const level of levels) {
      cumulative += Math.max(0, level.amount);
      const craftThreshold = Math.floor(cumulative / unitsPerCraft);
      if (craftThreshold >= 1 && craftThreshold <= maxCrafts) {
        thresholds.push(craftThreshold);
        if (craftThreshold + 1 <= maxCrafts) thresholds.push(craftThreshold + 1);
      }
    }
    return thresholds;
  }

  private buildCandidateCraftCounts(maxCrafts: number, thresholdCounts: number[]): number[] {
    const values = new Set<number>([1, maxCrafts]);
    const powers = [1, 2, 4, 8, 16, 32, 64, 128, 256, 512, 1024, 2048, 4096, 8192];
    for (const value of powers) if (value <= maxCrafts) values.add(value);
    for (const fraction of [0.1, 0.25, 0.5, 0.75, 0.9]) {
      const value = Math.floor(maxCrafts * fraction);
      if (value >= 1) values.add(value);
    }
    for (const threshold of thresholdCounts) values.add(threshold);
    return [...values].filter((value) => value >= 1 && value <= maxCrafts).sort((a, b) => a - b);
  }

  private async evaluateBatch(
    recipe: Recipe,
    crafts: number,
    data: Data,
    choices: RecipeChoiceMap,
    snapshotProducts: Record<string, { sellSummary: BazaarLevel[]; buySummary: BazaarLevel[] }>,
    shardsById: Map<string, Shard>,
    saleTaxRate: number,
    capitalBudget: number,
    inventoryCapacityUnits: number,
    outputProduct: { buySummary: BazaarLevel[] }
  ): Promise<BatchEvaluation> {
    const outputQuantity = recipe.outputQuantity * crafts;
    const rawMaterials: QuantityMap = new Map();
    const inputA = data.shards[recipe.inputs[0]];
    const inputB = data.shards[recipe.inputs[1]];
    if (!inputA || !inputB) return { crafts, outputQuantity, rawMaterials, inputCost: Infinity, grossRevenue: 0, saleTax: 0, netRevenue: -Infinity, profit: -Infinity, roi: -Infinity, peakInventoryUnits: Infinity, feasible: false };

    const okA = this.collectRawMaterials(recipe.inputs[0], inputA.fuse_amount * crafts, data, choices, rawMaterials);
    const okB = this.collectRawMaterials(recipe.inputs[1], inputB.fuse_amount * crafts, data, choices, rawMaterials);
    if (!okA || !okB) return { crafts, outputQuantity, rawMaterials, inputCost: Infinity, grossRevenue: 0, saleTax: 0, netRevenue: -Infinity, profit: -Infinity, roi: -Infinity, peakInventoryUnits: Infinity, feasible: false };

    let inputCost = 0;
    for (const [leafShardId, quantity] of rawMaterials) {
      const marketShard = shardsById.get(leafShardId);
      const product = marketShard ? snapshotProducts[marketShard.internal_id] : undefined;
      if (!product) return { crafts, outputQuantity, rawMaterials, inputCost: Infinity, grossRevenue: 0, saleTax: 0, netRevenue: -Infinity, profit: -Infinity, roi: -Infinity, peakInventoryUnits: Infinity, feasible: false };
      const cost = this.getInstantBuyCost(product.sellSummary, quantity);
      if (!Number.isFinite(cost)) return { crafts, outputQuantity, rawMaterials, inputCost: Infinity, grossRevenue: 0, saleTax: 0, netRevenue: -Infinity, profit: -Infinity, roi: -Infinity, peakInventoryUnits: Infinity, feasible: false };
      inputCost += cost;
    }

    if (inputCost > capitalBudget + EPSILON) {
      return { crafts, outputQuantity, rawMaterials, inputCost, grossRevenue: 0, saleTax: 0, netRevenue: -inputCost, profit: -Infinity, roi: -Infinity, peakInventoryUnits: Infinity, feasible: false };
    }

    const peak = this.simulateProductionForRecipe(recipe, crafts, data, choices);
    if (!peak.feasible || peak.peakUnits > inventoryCapacityUnits + EPSILON) {
      return { crafts, outputQuantity, rawMaterials, inputCost, grossRevenue: 0, saleTax: 0, netRevenue: -inputCost, profit: -Infinity, roi: -Infinity, peakInventoryUnits: peak.peakUnits, feasible: false };
    }

    const grossRevenue = this.getInstantSellRevenue(outputProduct.buySummary, outputQuantity);
    if (!Number.isFinite(grossRevenue)) {
      return { crafts, outputQuantity, rawMaterials, inputCost, grossRevenue: 0, saleTax: 0, netRevenue: -inputCost, profit: -Infinity, roi: -Infinity, peakInventoryUnits: peak.peakUnits, feasible: false };
    }

    const saleTax = grossRevenue * saleTaxRate;
    const netRevenue = grossRevenue - saleTax;
    const profit = netRevenue - inputCost;
    const roi = inputCost > EPSILON ? profit / inputCost : Infinity;

    return { crafts, outputQuantity, rawMaterials, inputCost, grossRevenue, saleTax, netRevenue, profit, roi, peakInventoryUnits: peak.peakUnits, feasible: true };
  }

  private simulateProductionForRecipe(recipe: Recipe, crafts: number, data: Data, choices: RecipeChoiceMap): InventorySimulation {
    const rootQuantity = recipe.outputQuantity * crafts;
    const inputA = data.shards[recipe.inputs[0]];
    const inputB = data.shards[recipe.inputs[1]];
    if (!inputA || !inputB) return { requiredQuantity: rootQuantity, producedQuantity: 0, peakUnits: Infinity, feasible: false };

    const requiredA = inputA.fuse_amount * crafts;
    const requiredB = inputB.fuse_amount * crafts;
    const a = this.simulateProduction(recipe.inputs[0], requiredA, data, choices);
    const b = this.simulateProduction(recipe.inputs[1], requiredB, data, choices);
    if (!a.feasible || !b.feasible) return { requiredQuantity: rootQuantity, producedQuantity: 0, peakUnits: Infinity, feasible: false };

    const peakAB = Math.max(a.peakUnits, a.producedQuantity + b.peakUnits, a.producedQuantity + b.producedQuantity - requiredA - requiredB + rootQuantity);
    const peakBA = Math.max(b.peakUnits, b.producedQuantity + a.peakUnits, b.producedQuantity + a.producedQuantity - requiredA - requiredB + rootQuantity);

    return { requiredQuantity: rootQuantity, producedQuantity: rootQuantity, peakUnits: Math.min(peakAB, peakBA), feasible: true };
  }

  /** Find the most profitable executable batch under the requested capital/inventory limits. */
  public async findOpportunities(options: ArbitrageOptions = {}): Promise<ArbitrageOpportunity[]> {
    const saleTaxRate = options.saleTaxRate ?? DEFAULT_SALE_TAX;
    const minOutputLiquidity = options.minOutputLiquidity ?? 1;
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
    const { choices } = calculationService.computeMinCosts(data, params);
    const opportunities: ArbitrageOpportunity[] = [];

    for (const shard of shards) {
      const recipes = data.recipes[shard.id] ?? [];
      if (recipes.length === 0) continue;

      const quote = snapshot.products[shard.internal_id];
      if (!quote?.buySummary?.length) continue;
      const totalSellLiquidity = quote.buySummary.reduce((sum, level) => sum + Math.max(0, level.amount), 0);
      if (totalSellLiquidity + EPSILON < minOutputLiquidity) continue;

      for (const recipe of recipes) {
        if (recipe.outputQuantity <= 0) continue;

        let upper = 1;
        while (upper < 1_000_000) {
          const candidate = await this.evaluateBatch(recipe, upper, data, choices, snapshot.products, shardById, saleTaxRate, capitalBudget, inventoryCapacityUnits, quote);
          if (!candidate.feasible) break;
          upper *= 2;
        }

        let low = 1;
        let high = Math.max(1, upper);
        let maxFeasible = 0;
        while (low <= high) {
          const mid = Math.floor((low + high) / 2);
          const candidate = await this.evaluateBatch(recipe, mid, data, choices, snapshot.products, shardById, saleTaxRate, capitalBudget, inventoryCapacityUnits, quote);
          if (candidate.feasible) {
            maxFeasible = mid;
            low = mid + 1;
          } else {
            high = mid - 1;
          }
        }

        if (maxFeasible <= 0) continue;

        const inputUnitsPerCraft = new Map<string, number>();
        for (const input of recipe.inputs) {
          const temp: QuantityMap = new Map();
          if (this.collectRawMaterials(input, data.shards[input].fuse_amount, data, choices, temp)) {
            for (const [leafId, units] of temp) inputUnitsPerCraft.set(leafId, (inputUnitsPerCraft.get(leafId) ?? 0) + units);
          }
        }

        const thresholds: number[] = [];
        for (const [leafId, unitsPerCraft] of inputUnitsPerCraft) {
          const marketShard = shardById.get(leafId);
          const product = marketShard ? snapshot.products[marketShard.internal_id] : undefined;
          if (product) thresholds.push(...this.getOrderBookThresholdCraftCounts(product.sellSummary, unitsPerCraft, maxFeasible));
        }
        thresholds.push(...this.getOrderBookThresholdCraftCounts(quote.buySummary, recipe.outputQuantity, maxFeasible));

        const candidateCraftCounts = this.buildCandidateCraftCounts(maxFeasible, thresholds);
        let best: BatchEvaluation | null = null;

        for (const crafts of candidateCraftCounts) {
          const evaluated = await this.evaluateBatch(recipe, crafts, data, choices, snapshot.products, shardById, saleTaxRate, capitalBudget, inventoryCapacityUnits, quote);
          if (!evaluated.feasible || evaluated.profit <= EPSILON) continue;
          if (!best || evaluated.profit > best.profit || (Math.abs(evaluated.profit - best.profit) < EPSILON && evaluated.roi > best.roi)) {
            best = evaluated;
          }
        }

        if (!best) continue;

        const acquisitionPath = [...best.rawMaterials.entries()].map(([leafId, quantity]) => {
          const product = snapshot.products[shardById.get(leafId)?.internal_id ?? ""];
          const totalCost = product ? this.getInstantBuyCost(product.sellSummary, quantity) : Infinity;
          const unitCost = quantity > EPSILON ? totalCost / quantity : Infinity;
          return { shardId: leafId, quantity, unitCost, totalCost, method: "bazaar" as const };
        });
        acquisitionPath.push(...this.buildAcquisitionLegs(recipe.inputs[0], data.shards[recipe.inputs[0]].fuse_amount * best.crafts, data, choices));
        acquisitionPath.push(...this.buildAcquisitionLegs(recipe.inputs[1], data.shards[recipe.inputs[1]].fuse_amount * best.crafts, data, choices));

        opportunities.push({
          shardId: shard.id,
          shardName: shard.name,
          rarity: shard.rarity,
          recipe: { inputs: recipe.inputs, outputQuantity: recipe.outputQuantity },
          outputQuantity: best.outputQuantity,
          batchCrafts: best.crafts,
          inputCost: best.inputCost,
          resaleUnitPrice: best.grossRevenue / best.outputQuantity,
          grossRevenue: best.grossRevenue,
          saleTax: best.saleTax,
          netRevenue: best.netRevenue,
          profit: best.profit,
          roi: best.roi,
          profitPerOutput: best.profit / best.outputQuantity,
          capitalRequired: best.inputCost,
          acquisitionPath,
          sellLiquidity: totalSellLiquidity,
          peakInventoryUnits: best.peakInventoryUnits,
          peakInventoryStacks: best.peakInventoryUnits / stackSize,
          capitalBudget,
          inventoryCapacityUnits,
          fetchedAt: snapshot.fetchedAt,
        });
      }
    }

    opportunities.sort((a, b) => {
      if (b.profit !== a.profit) return b.profit - a.profit;
      if (b.roi !== a.roi) return b.roi - a.roi;
      return b.profitPerOutput - a.profitPerOutput;
    });

    return opportunities.slice(0, limit);
  }
}
