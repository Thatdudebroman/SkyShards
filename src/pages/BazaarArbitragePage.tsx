import React, { useCallback, useEffect, useMemo, useState } from "react";
import { RefreshCw, TrendingUp, ShoppingCart, ArrowDownUp, Boxes, ChevronDown, ChevronRight } from "lucide-react";
import { BazaarArbitrageService, DataService } from "../services";
import type { ArbitrageLeg, ArbitrageOpportunity } from "../types/bazaarArbitrage";

const DEFAULT_CAPITAL = 100_000_000;
const DEFAULT_STACKS = 35;
const STACK_SIZE = 64;

const formatCoins = (value: number) => {
  if (!Number.isFinite(value)) return "∞";
  return new Intl.NumberFormat("en-US", { maximumFractionDigits: 0 }).format(value);
};

const formatPct = (value: number) => `${(value * 100).toFixed(1)}%`;

interface PurchaseLine {
  shardId: string;
  name: string;
  quantity: number;
  totalCost: number;
  unitCost: number;
}

interface ExecutionWave {
  crafts: number;
  units: number;
  buys: PurchaseLine[];
}

export const BazaarArbitragePage: React.FC = () => {
  const [opportunities, setOpportunities] = useState<ArbitrageOpportunity[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [lastUpdated, setLastUpdated] = useState<number | null>(null);
  const [capitalMillions, setCapitalMillions] = useState(DEFAULT_CAPITAL / 1_000_000);
  const [inventoryStacks, setInventoryStacks] = useState(DEFAULT_STACKS);
  const [shardNames, setShardNames] = useState<Record<string, string>>({});
  const [expandedRows, setExpandedRows] = useState<Set<string>>(new Set());

  const capitalBudget = useMemo(() => Math.max(0, capitalMillions) * 1_000_000, [capitalMillions]);
  const inventoryCapacityUnits = inventoryStacks * STACK_SIZE;

  const displayOpportunities = useMemo(() => {
    const unique = new Map<string, ArbitrageOpportunity>();
    for (const opportunity of opportunities) {
      const canonicalInputs = [...opportunity.recipe.inputs].sort().join("|");
      const key = `${opportunity.shardId}|${opportunity.recipe.outputQuantity}|${canonicalInputs}`;
      const existing = unique.get(key);
      if (!existing || opportunity.profit > existing.profit) {
        unique.set(key, opportunity);
      }
    }
    return [...unique.values()].sort((a, b) => b.profit - a.profit);
  }, [opportunities]);

  const refresh = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [results, shards] = await Promise.all([
        BazaarArbitrageService.getInstance().findOpportunities({
          saleTaxRate: 0.01,
          minOutputLiquidity: 1,
          limit: 100,
          capitalBudget,
          maxInventoryStacks: inventoryStacks,
          stackSize: STACK_SIZE,
        }),
        DataService.getInstance().loadShards(),
      ]);

      setOpportunities(results);
      setShardNames(Object.fromEntries(shards.map((shard) => [shard.id, shard.name])));
      setExpandedRows(new Set());
      setLastUpdated(results[0]?.fetchedAt ?? Date.now());
    } catch (err) {
      console.error(err);
      setError(err instanceof Error ? err.message : "Failed to load Bazaar data");
    } finally {
      setLoading(false);
    }
  }, [capitalBudget, inventoryStacks]);

  useEffect(() => {
    void refresh();
    const interval = window.setInterval(() => void refresh(), 30_000);
    return () => window.clearInterval(interval);
  }, [refresh]);

  const formatPurchasePlan = useCallback((opportunity: ArbitrageOpportunity): PurchaseLine[] => {
    const seen = new Set<string>();
    return opportunity.acquisitionPath
      .filter((leg) => leg.method === "bazaar")
      .filter((leg) => {
        if (seen.has(leg.shardId)) return false;
        seen.add(leg.shardId);
        return true;
      })
      .map((leg) => ({
        shardId: leg.shardId,
        name: shardNames[leg.shardId] ?? leg.shardId,
        quantity: leg.quantity,
        totalCost: leg.totalCost,
        unitCost: leg.unitCost,
      }))
      .sort((a, b) => b.totalCost - a.totalCost);
  }, [shardNames]);

  const buildExecutionWaves = useCallback((opportunity: ArbitrageOpportunity, purchases: PurchaseLine[]): ExecutionWave[] => {
    if (opportunity.batchCrafts <= 0 || purchases.length === 0) return [];

    const totalRawUnits = purchases.reduce((sum, purchase) => sum + purchase.quantity, 0);
    const rawUnitsPerCraft = totalRawUnits / opportunity.batchCrafts;
    if (!Number.isFinite(rawUnitsPerCraft) || rawUnitsPerCraft <= 0) return [];

    const craftsPerWave = Math.floor(inventoryCapacityUnits / rawUnitsPerCraft);
    if (craftsPerWave < 1) return [];

    const waves: ExecutionWave[] = [];
    const remaining = new Map(purchases.map((purchase) => [purchase.shardId, purchase.quantity]));
    let remainingCrafts = opportunity.batchCrafts;

    while (remainingCrafts > 0) {
      const crafts = Math.min(craftsPerWave, remainingCrafts);
      const isLastWave = crafts === remainingCrafts;

      const buys = purchases.map((purchase) => {
        const available = remaining.get(purchase.shardId) ?? 0;
        const quantity = isLastWave
          ? available
          : Math.floor((purchase.quantity * crafts) / opportunity.batchCrafts);
        remaining.set(purchase.shardId, Math.max(0, available - quantity));

        return {
          ...purchase,
          quantity,
          totalCost: quantity * purchase.unitCost,
        };
      }).filter((purchase) => purchase.quantity > 0);

      waves.push({
        crafts,
        units: buys.reduce((sum, purchase) => sum + purchase.quantity, 0),
        buys,
      });

      remainingCrafts -= crafts;
    }

    return waves;
  }, [inventoryCapacityUnits]);

  const toggleRow = (key: string) => {
    setExpandedRows((current) => {
      const next = new Set(current);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  };

  return (
    <div className="min-h-screen bg-slate-950 text-slate-100 p-4 sm:p-6">
      <div className="max-w-screen-2xl mx-auto space-y-5">
        <div className="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
          <div>
            <div className="flex items-center gap-2 text-emerald-300 text-sm font-semibold uppercase tracking-wide">
              <TrendingUp className="w-4 h-4" />
              Bazaar Arbitrage
            </div>
            <h1 className="text-2xl sm:text-3xl font-bold mt-1">Best executable shard batches right now</h1>
            <p className="text-slate-400 mt-1 max-w-5xl">
              Each row is an executable batch under your capital limit. The <strong>Buy</strong> column is the total raw-shard shopping list.
              Expand a row for the inventory-safe purchase/craft waves.
            </p>
          </div>
          <button
            onClick={() => void refresh()}
            disabled={loading}
            className="inline-flex items-center justify-center gap-2 rounded-md bg-slate-800 hover:bg-slate-700 disabled:opacity-50 px-4 py-2 text-sm font-medium"
          >
            <RefreshCw className={`w-4 h-4 ${loading ? "animate-spin" : ""}`} />
            Refresh
          </button>
        </div>

        <div className="grid grid-cols-1 lg:grid-cols-4 gap-3">
          <label className="rounded-lg border border-slate-800 bg-slate-900/70 p-4 block">
            <div className="text-sm font-medium text-sky-300">Capital available</div>
            <div className="flex items-center gap-2 mt-2">
              <input
                type="number"
                min={0}
                step={1}
                value={capitalMillions}
                onChange={(event) => setCapitalMillions(Number(event.target.value) || 0)}
                className="w-full rounded-md bg-slate-950 border border-slate-700 px-3 py-2 text-lg font-semibold"
              />
              <span className="text-slate-400">m</span>
            </div>
            <div className="text-xs text-slate-500 mt-1">Hard ceiling: {formatCoins(capitalBudget)} coins per recommended batch.</div>
          </label>

          <label className="rounded-lg border border-slate-800 bg-slate-900/70 p-4 block">
            <div className="flex items-center gap-2 text-violet-300 text-sm font-medium"><Boxes className="w-4 h-4" /> Inventory</div>
            <div className="flex items-center gap-2 mt-2">
              <input
                type="number"
                min={1}
                max={1000}
                step={1}
                value={inventoryStacks}
                onChange={(event) => setInventoryStacks(Math.max(1, Number(event.target.value) || 1))}
                className="w-full rounded-md bg-slate-950 border border-slate-700 px-3 py-2 text-lg font-semibold"
              />
              <span className="text-slate-400">stacks</span>
            </div>
            <div className="text-xs text-slate-500 mt-1">{inventoryStacks} × {STACK_SIZE} = {inventoryCapacityUnits.toLocaleString()} simultaneous shard slots.</div>
          </label>

          <div className="rounded-lg border border-slate-800 bg-slate-900/70 p-4">
            <div className="flex items-center gap-2 text-amber-300 text-sm font-medium"><ShoppingCart className="w-4 h-4" /> Input strategy</div>
            <div className="text-lg font-semibold mt-1">Instant Buy</div>
            <div className="text-xs text-slate-500 mt-1">Consumes the live sell book, walking deeper levels when necessary.</div>
          </div>

          <div className="rounded-lg border border-slate-800 bg-slate-900/70 p-4">
            <div className="flex items-center gap-2 text-emerald-300 text-sm font-medium"><ArrowDownUp className="w-4 h-4" /> Output strategy</div>
            <div className="text-lg font-semibold mt-1">Instant Sell</div>
            <div className="text-xs text-slate-500 mt-1">
              {lastUpdated ? `Snapshot ${new Date(lastUpdated).toLocaleTimeString()}` : "Waiting for first snapshot"}
            </div>
          </div>
        </div>

        {error && <div className="rounded-lg border border-red-500/30 bg-red-500/10 p-4 text-red-200">{error}</div>}

        <div className="overflow-x-auto rounded-lg border border-slate-800 bg-slate-900/60">
          <table className="min-w-full text-sm">
            <thead className="bg-slate-900">
              <tr className="text-left text-slate-400">
                <th className="px-4 py-3">#</th>
                <th className="px-4 py-3">Shard</th>
                <th className="px-4 py-3">Buy — total batch</th>
                <th className="px-4 py-3">Batch</th>
                <th className="px-4 py-3">Recipe</th>
                <th className="px-4 py-3 text-right">Capital</th>
                <th className="px-4 py-3 text-right">Profit</th>
                <th className="px-4 py-3 text-right">ROI</th>
                <th className="px-4 py-3 text-right">Execution</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-800">
              {displayOpportunities.map((opportunity, index) => {
                const purchases = formatPurchasePlan(opportunity);
                const waves = buildExecutionWaves(opportunity, purchases);
                const key = `${opportunity.shardId}|${opportunity.recipe.outputQuantity}|${[...opportunity.recipe.inputs].sort().join("|")}`;
                const expanded = expandedRows.has(key);

                return (
                  <React.Fragment key={key}>
                    <tr className="align-top hover:bg-slate-800/40">
                      <td className="px-4 py-3 text-slate-500 font-mono">{index + 1}</td>
                      <td className="px-4 py-3">
                        <div className="font-semibold">{opportunity.shardName}</div>
                        <div className="text-xs text-slate-500">{opportunity.rarity}</div>
                      </td>
                      <td className="px-4 py-3 min-w-[320px]">
                        <div className="space-y-0.5">
                          {purchases.map((purchase) => (
                            <div key={purchase.shardId} className="flex items-center justify-between gap-4 font-mono text-xs">
                              <span className="text-slate-200">{purchase.quantity.toLocaleString()} × {purchase.name}</span>
                              <span className="text-slate-500 whitespace-nowrap">{formatCoins(purchase.totalCost)}</span>
                            </div>
                          ))}
                        </div>
                        <div className="text-xs text-slate-500 mt-2">Total instant-buy cost: {formatCoins(opportunity.inputCost)}</div>
                      </td>
                      <td className="px-4 py-3 font-mono whitespace-nowrap">
                        <div>{opportunity.batchCrafts} crafts</div>
                        <div className="text-xs text-slate-500">→ {opportunity.outputQuantity.toLocaleString()} shards</div>
                      </td>
                      <td className="px-4 py-3 text-slate-300 whitespace-nowrap">{opportunity.recipe.inputs.join(" + ")} → ×{opportunity.recipe.outputQuantity}</td>
                      <td className="px-4 py-3 text-right font-mono whitespace-nowrap">{formatCoins(opportunity.capitalRequired)}</td>
                      <td className="px-4 py-3 text-right font-mono text-emerald-300 whitespace-nowrap">{formatCoins(opportunity.profit)}</td>
                      <td className="px-4 py-3 text-right font-mono text-emerald-300 whitespace-nowrap">{formatPct(opportunity.roi)}</td>
                      <td className="px-4 py-3 text-right">
                        <button
                          onClick={() => toggleRow(key)}
                          className="inline-flex items-center gap-1 rounded-md bg-slate-800 hover:bg-slate-700 px-2 py-1 text-xs font-medium"
                        >
                          {expanded ? <ChevronDown className="w-3.5 h-3.5" /> : <ChevronRight className="w-3.5 h-3.5" />}
                          {waves.length} {waves.length === 1 ? "wave" : "waves"}
                        </button>
                      </td>
                    </tr>

                    {expanded && (
                      <tr>
                        <td colSpan={9} className="px-6 py-4 bg-slate-950/70">
                          <div className="space-y-3">
                            <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-2">
                              <div>
                                <div className="font-semibold text-slate-200">Inventory-safe execution plan</div>
                                <div className="text-xs text-slate-500">Buy only the listed wave, craft it through the chain, immediately sell the finished shard, then repeat.</div>
                              </div>
                              <div className="text-xs font-mono text-slate-400">Capacity: {inventoryCapacityUnits.toLocaleString()} shards</div>
                            </div>

                            {waves.length > 0 ? waves.map((wave, waveIndex) => (
                              <div key={`${key}-wave-${waveIndex}`} className="rounded-md border border-slate-800 bg-slate-900/70 p-3">
                                <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-2 mb-2">
                                  <div className="font-medium">Wave {waveIndex + 1}: {wave.crafts} crafts → {wave.crafts * opportunity.recipe.outputQuantity} {opportunity.shardName}</div>
                                  <div className="text-xs font-mono text-slate-500">{wave.units.toLocaleString()} shards = {(wave.units / STACK_SIZE).toFixed(1)} stacks</div>
                                </div>
                                <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-1">
                                  {wave.buys.map((purchase) => (
                                    <div key={`${waveIndex}-${purchase.shardId}`} className="flex justify-between gap-3 rounded bg-slate-950/60 px-2 py-1 text-xs font-mono">
                                      <span>{purchase.quantity.toLocaleString()} × {purchase.name}</span>
                                      <span className="text-slate-500 whitespace-nowrap">{formatCoins(purchase.totalCost)}</span>
                                    </div>
                                  ))}
                                </div>
                              </div>
                            )) : (
                              <div className="rounded-md border border-red-500/20 bg-red-500/5 p-3 text-sm text-red-200">
                                One final craft would require more than the configured inventory capacity.
                              </div>
                            )}
                          </div>
                        </td>
                      </tr>
                    )}
                  </React.Fragment>
                );
              })}

              {!loading && displayOpportunities.length === 0 && !error && (
                <tr>
                  <td colSpan={9} className="px-4 py-10 text-center text-slate-500">No profitable executable batch was found within the current constraints.</td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
};

export default BazaarArbitragePage;
