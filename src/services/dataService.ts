import type { BazaarData } from "../types/hypixelApiTypes.ts";
import type { BazaarSnapshot, BazaarLevel, BazaarProductQuote } from "../types/bazaarArbitrage";
import type { FusionJson, Shard } from "../types/types";
import { sortShardsByNameWithPrefixAwareness, filterShards, BASIC_FILTER_CONFIG, NAME_ONLY_FILTER_CONFIG } from "../utilities";

export class DataService {
  private static instance: DataService;
  private shardsCache: Shard[] | null = null;
  private shardNameToKeyCache: Record<string, string> | null = null;
  private fusionJsonCache: Promise<FusionJson> | null = null;
  private defaultRatesCache: Promise<Record<string, number>> | null = null;
  private bazaarPriceCache: Record<string, Record<string, number>> | null = null;
  private bazaarSnapshotCache: { snapshot: BazaarSnapshot; expiresAt: number } | null = null;

  public static getInstance(): DataService {
    if (!DataService.instance) {
      DataService.instance = new DataService();
    }
    return DataService.instance;
  }

  private async fetchJson<T>(filename: string): Promise<T> {
    try {
      const response = await fetch(`${import.meta.env.BASE_URL}${filename}`);
      if (!response.ok) {
        throw new Error(`HTTP error! status: ${response.status}`);
      }
      return await response.json();
    } catch (error) {
      throw new Error(`Failed to load ${filename}: ${error}`);
    }
  }

  private async fetchApi<T>(endpoint: string): Promise<T> {
    try {
      const response = await fetch(
        `https://api.hypixel.net/v2/skyblock${endpoint}`
      );
      if (!response.ok) {
        throw new Error(`HTTP error! status: ${response.status}`);
      }
      return await response.json();
    } catch (error) {
      throw new Error(`Failed to fetch API endpoint ${endpoint}: ${error}`);
    }
  }

  async loadBazaarSnapshot(forceRefresh = false): Promise<BazaarSnapshot> {
    const now = Date.now();
    if (!forceRefresh && this.bazaarSnapshotCache && this.bazaarSnapshotCache.expiresAt > now) {
      return this.bazaarSnapshotCache.snapshot;
    }

    const bazaarData = await this.fetchApi<BazaarData>("/bazaar");
    const products: Record<string, BazaarProductQuote> = {};

    for (const [productId, product] of Object.entries(bazaarData.products)) {
      const toLevels = (entries: { amount: number; pricePerUnit: number; orders: number }[]): BazaarLevel[] =>
        entries.map((entry) => ({
          amount: entry.amount,
          pricePerUnit: entry.pricePerUnit,
          orders: entry.orders,
        }));

      const sellSummary = toLevels(Object.values(product.sell_summary ?? {}));
      const buySummary = toLevels(Object.values(product.buy_summary ?? {}));

      products[productId] = {
        productId: product.productId,
        // `sell_summary` contains sell offers: these are the orders you consume when
        // buying instantly. `buy_summary` contains buy orders: these are the orders
        // you consume when selling instantly.
        instantBuy: sellSummary[0] ?? null,
        instantSell: buySummary[0] ?? null,
        sellSummary,
        buySummary,
      };
    }

    const snapshot: BazaarSnapshot = { fetchedAt: now, products };
    this.bazaarSnapshotCache = { snapshot, expiresAt: now + 5_000 };
    return snapshot;
  }

  async loadShards(): Promise<Shard[]> {
    if (this.shardsCache) {
      return this.shardsCache;
    }

    const [fusionData, defaultRates] = await Promise.all([this.loadFusionJson(), this.loadDefaultRates()]);

    this.shardsCache = Object.entries(fusionData.shards).map(([id, shard]: [string, Shard]) => ({
        ...shard,
        id,
        rate: defaultRates[id] || 0,
    }));

    return this.shardsCache;
  }

  async getShardNameToKeyMap(): Promise<Record<string, string>> {
    if (this.shardNameToKeyCache) {
      return this.shardNameToKeyCache;
    }

    const shards = await this.loadShards();
    this.shardNameToKeyCache = shards.reduce((acc, shard) => {
      acc[shard.name.toLowerCase()] = shard.id;
      return acc;
    }, {} as Record<string, string>);

    return this.shardNameToKeyCache;
  }

  async loadFusionJson(): Promise<FusionJson> {
    if (!this.fusionJsonCache) {
      this.fusionJsonCache = this.fetchJson<FusionJson>("fusion-data.json").catch((error) => {
        this.fusionJsonCache = null;
        throw error;
      });
    }
    return this.fusionJsonCache;
  }

  async loadDefaultRates(): Promise<Record<string, number>> {
    if (!this.defaultRatesCache) {
      this.defaultRatesCache = this.fetchJson<Record<string, number>>("rates.json").catch((error) => {
        this.defaultRatesCache = null;
        throw error;
      });
    }
    return this.defaultRatesCache;
  }

  async loadShardCosts(useInstantBuyPrices: boolean): Promise<Record<string, number>> {
    const cacheKey = useInstantBuyPrices ? "instant_buy" : "buy_offer";
  
    if (this.bazaarPriceCache?.[cacheKey]) {
      return this.bazaarPriceCache[cacheKey];
    }

    const bazaarData = await this.loadBazaarSnapshot();
    const shards = await this.loadShards();
    this.bazaarPriceCache = this.bazaarPriceCache ?? {};
    this.bazaarPriceCache[cacheKey] = {};

    for (const shard of shards) {
      const product = bazaarData.products[shard.internal_id];
      const price = useInstantBuyPrices
        ? product?.instantBuy?.pricePerUnit
        : product?.instantSell?.pricePerUnit;
      if (price !== undefined) {
        this.bazaarPriceCache[cacheKey][shard.id] = price;
      }
    }
  
    return this.bazaarPriceCache[cacheKey];
  }

  private sortShardsByQuery(shards: Shard[], query: string): Shard[] {
    const lowerQuery = query.toLowerCase();
    return shards.sort((a, b) => {
      const aName = a.name.toLowerCase();
      const bName = b.name.toLowerCase();
      const aKey = a.id.toLowerCase();
      const bKey = b.id.toLowerCase();
      const aStarts = aName.startsWith(lowerQuery) || aKey.startsWith(lowerQuery);
      const bStarts = bName.startsWith(lowerQuery) || bKey.startsWith(lowerQuery);
      
      if (aStarts && !bStarts) return -1;
      if (!aStarts && bStarts) return 1;
      return sortShardsByNameWithPrefixAwareness(a, b);
    });
  }

  async searchShards(query: string): Promise<Shard[]> {
    const shards = await this.loadShards();
    const filtered = filterShards(shards, {
      query,
      searchConfig: BASIC_FILTER_CONFIG,
    });

    return this.sortShardsByQuery(filtered, query);
  }

  async searchShardsByNameOnly(query: string): Promise<Shard[]> {
    const shards = await this.loadShards();
    const filtered = filterShards(shards, {
      query,
      searchConfig: NAME_ONLY_FILTER_CONFIG,
    });

    if (filtered.length === 0) {
      const fallbackConfig = {
        name: false,
        id: false,
        family: false,
        type: false,
        title: true,
        description: true,
      };

      const fallbackFiltered = filterShards(shards, {
        query,
        searchConfig: fallbackConfig,
      });

      return this.sortShardsByQuery(fallbackFiltered, query);
    }

    return this.sortShardsByQuery(filtered, query);
  }
}
