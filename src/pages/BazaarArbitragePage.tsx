import React, { useCallback, useEffect, useRef, useState } from "react";
import { ArrowDownUp, Boxes, ChevronDown, ChevronRight, RefreshCw, ShoppingCart, TrendingUp } from "lucide-react";
import { BazaarArbitrageService, DataService } from "../services";
import type { ArbitrageOpportunity } from "../types/bazaarArbitrage";

const DEFAULT_CAPITAL = 100_000_000;
const DEFAULT_STACKS = 35;
const STACK_SIZE = 64;

const formatCoins = (value: number) => Number.isFinite(value)
  ? new Intl.NumberFormat("en-US", { maximumFractionDigits: 0 }).format(value)
  : "∞";
const formatPct = (value: number) => `${(value * 100).toFixed(1)}%`;

interface PurchaseLine {
  shardId: string;
  name: string;
  quantity: number;
  totalCost: number;
  unitCost: number;
  instantBuyUnitPrice: number;
}

export const BazaarArbitragePage: React.FC = () => {
  const [opportunities, setOpportunities] = useState<ArbitrageOpportunity[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [lastUpdated, setLastUpdated] = useState<number | null>(null);
  const [capitalMillions, setCapitalMillions] = useState(100);
  const [inventoryStacks, setInventoryStacks] = useState(DEFAULT_STACKS);
  const [shardNames, setShardNames] = useState<Record<string, string>>({});
  const [expandedRows, setExpandedRows] = useState<Set<string>>(new Set());
  const runningRef = useRef(false);
  const timerRef = useRef<number | null>(null);

  const capitalBudget = Math.max(0, capitalMillions) * 1_000_000;
  const inventoryCapacityUnits = inventoryStacks * STACK_SIZE;

  const refresh = useCallback(async () => {
    if (runningRef.current) return;
    runningRef.current = true;
    setLoading(true);
    setError(null);

    try {
      const [results, shards] = await Promise.all([
        BazaarArbitrageService.getInstance().findOpportunities({
          saleTaxRate: 0.01,
          minOutputLiquidity: 1,
          limit: 50,
          capitalBudget,
          maxInventoryStacks: inventoryStacks,
          stackSize: STACK_SIZE,
        }),
        DataService.getInstance().loadShards(),
      ]);

      setOpportunities(results);
      setShardNames(Object.fromEntries(shards.map((shard) => [shard.id, shard.name])));
      setLastUpdated(results[0]?.fetchedAt ?? Date.now());
      setExpandedRows(new Set());
    } catch (err) {
      console.error(err);
      setError(err instanceof Error ? err.message : "Failed to load Bazaar data");
    } finally {
      runningRef.current = false;
      setLoading(false);
      timerRef.current = window.setTimeout(() => {
        void refresh();
      }, 30_000);
    }
  }, [capitalBudget, inventoryStacks]);

  useEffect(() => {
    void refresh();
    return () => {
      if (timerRef.current !== null) window.clearTimeout(timerRef.current);
    };
  }, [refresh]);

  const purchaseLines = useCallback((opportunity: ArbitrageOpportunity): PurchaseLine[] => opportunity.acquisitionPath
    .filter((leg) => leg.method === "bazaar")
    .map((leg) => ({
      shardId: leg.shardId,
      name: shardNames[leg.shardId] ?? leg.shardId,
      quantity: leg.quantity,
      totalCost: leg.totalCost,
      unitCost: leg.unitCost,
      instantBuyUnitPrice: leg.instantBuyUnitPrice,
    }))
    .sort((a, b) => b.totalCost - a.totalCost), [shardNames]);

  const toggle = (key: string) => setExpandedRows((current) => {
    const next = new Set(current);
    if (next.has(key)) next.delete(key); else next.add(key);
    return next;
  });

  return (
    <div className="min-h-screen bg-slate-950 text-slate-100 p-4 sm:p-6">
      <div className="max-w-screen-2xl mx-auto space-y-5">
        <header className="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
          <div>
            <div className="flex items-center gap-2 text-emerald-300 text-sm font-semibold uppercase tracking-wide">
              <TrendingUp className="w-4 h-4" /> Bazaar Arbitrage
            </div>
            <h1 className="text-2xl sm:text-3xl font-bold mt-1">Best executable shard batches</h1>
            <p className="text-slate-400 mt-1 max-w-5xl">
              Inputs use the live <strong>sell-offer</strong> book for true instant buys. Large purchases consume deeper sell levels; outputs use the live buy-order book for immediate sales.
            </p>
          </div>
          <button
            onClick={() => void refresh()}
            disabled={loading}
            className="inline-flex items-center justify-center gap-2 rounded-md bg-slate-800 hover:bg-slate-700 disabled:opacity-50 px-4 py-2 text-sm font-medium"
          >
            <RefreshCw className={`w-4 h-4 ${loading ? "animate-spin" : ""}`} /> Refresh
          </button>
        </header>

        <div className="grid grid-cols-1 lg:grid-cols-4 gap-3">
          <label className="rounded-lg border border-slate-800 bg-slate-900/70 p-4">
            <div className="text-sm font-medium text-sky-300">Capital available</div>
            <div className="flex items-center gap-2 mt-2">
              <input type="number" min={0} step={1} value={capitalMillions} onChange={(event) => setCapitalMillions(Number(event.target.value) || 0)} className="w-full rounded-md bg-slate-950 border border-slate-700 px-3 py-2 text-lg font-semibold" />
              <span className="text-slate-400">m</span>
            </div>
            <div className="text-xs text-slate-500 mt-1">Hard ceiling: {formatCoins(capitalBudget)} coins.</div>
          </label>

          <label className="rounded-lg border border-slate-800 bg-slate-900/70 p-4">
            <div className="flex items-center gap-2 text-violet-300 text-sm font-medium"><Boxes className="w-4 h-4" /> Inventory</div>
            <div className="flex items-center gap-2 mt-2">
              <input type="number" min={1} max={1000} step={1} value={inventoryStacks} onChange={(event) => setInventoryStacks(Math.max(1, Number(event.target.value) || 1))} className="w-full rounded-md bg-slate-950 border border-slate-700 px-3 py-2 text-lg font-semibold" />
              <span className="text-slate-400">stacks</span>
            </div>
            <div className="text-xs text-slate-500 mt-1">{inventoryCapacityUnits.toLocaleString()} simultaneous shard slots.</div>
          </label>

          <div className="rounded-lg border border-slate-800 bg-slate-900/70 p-4">
            <div className="flex items-center gap-2 text-amber-300 text-sm font-medium"><ShoppingCart className="w-4 h-4" /> Input</div>
            <div className="text-lg font-semibold mt-1">Instant Buy</div>
            <div className="text-xs text-slate-500 mt-1">Cheapest live sell offer, then deeper sell levels as needed.</div>
          </div>

          <div className="rounded-lg border border-slate-800 bg-slate-900/70 p-4">
            <div className="flex items-center gap-2 text-emerald-300 text-sm font-medium"><ArrowDownUp className="w-4 h-4" /> Output</div>
            <div className="text-lg font-semibold mt-1">Instant Sell</div>
            <div className="text-xs text-slate-500 mt-1">{lastUpdated ? new Date(lastUpdated).toLocaleTimeString() : "Waiting for snapshot"}</div>
          </div>
        </div>

        {loading && <div className="rounded-lg border border-slate-800 bg-slate-900/60 p-3 text-sm text-slate-400">Scanning live Bazaar depth…</div>}
        {error && <div className="rounded-lg border border-red-500/30 bg-red-500/10 p-4 text-red-200">{error}</div>}

        <div className="overflow-x-auto rounded-lg border border-slate-800 bg-slate-900/60">
          <table className="min-w-full text-sm">
            <thead className="bg-slate-900">
              <tr className="text-left text-slate-400">
                <th className="px-4 py-3">#</th><th className="px-4 py-3">Shard</th><th className="px-4 py-3">What to buy</th>
                <th className="px-4 py-3">Batch</th><th className="px-4 py-3">Recipe</th><th className="px-4 py-3 text-right">Capital</th>
                <th className="px-4 py-3 text-right">Profit</th><th className="px-4 py-3 text-right">ROI</th><th className="px-4 py-3 text-right">Details</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-800">
              {opportunities.map((opportunity, index) => {
                const key = `${opportunity.shardId}|${opportunity.recipe.outputQuantity}|${[...opportunity.recipe.inputs].sort().join("|")}`;
                const expanded = expandedRows.has(key);
                const purchases = purchaseLines(opportunity);
                return (
                  <React.Fragment key={key}>
                    <tr className="align-top hover:bg-slate-800/40">
                      <td className="px-4 py-3 text-slate-500 font-mono">{index + 1}</td>
                      <td className="px-4 py-3"><div className="font-semibold">{opportunity.shardName}</div><div className="text-xs text-slate-500">{opportunity.rarity}</div></td>
                      <td className="px-4 py-3 min-w-[400px]">
                        <div className="space-y-1">
                          {purchases.map((purchase) => (
                            <div key={purchase.shardId} className="rounded bg-slate-950/60 px-2 py-1">
                              <div className="flex justify-between gap-3 font-mono text-xs">
                                <span>{purchase.quantity.toLocaleString()} × {purchase.name}</span>
                                <span className="text-slate-400">{formatCoins(purchase.totalCost)}</span>
                              </div>
                              <div className="text-[11px] text-slate-500">Instant-buy start: {formatCoins(purchase.instantBuyUnitPrice)}/unit · depth-weighted batch avg: {formatCoins(purchase.unitCost)}/unit</div>
                            </div>
                          ))}
                        </div>
                        <div className="text-xs text-slate-500 mt-2">Total executable input cost: {formatCoins(opportunity.inputCost)}</div>
                      </td>
                      <td className="px-4 py-3 font-mono whitespace-nowrap"><div>{opportunity.batchCrafts} crafts</div><div className="text-xs text-slate-500">→ {opportunity.outputQuantity.toLocaleString()} shards</div></td>
                      <td className="px-4 py-3 text-slate-300 whitespace-nowrap">{opportunity.recipe.inputs.join(" + ")} → ×{opportunity.recipe.outputQuantity}</td>
                      <td className="px-4 py-3 text-right font-mono whitespace-nowrap">{formatCoins(opportunity.capitalRequired)}</td>
                      <td className="px-4 py-3 text-right font-mono text-emerald-300 whitespace-nowrap">{formatCoins(opportunity.profit)}</td>
                      <td className="px-4 py-3 text-right font-mono text-emerald-300 whitespace-nowrap">{formatPct(opportunity.roi)}</td>
                      <td className="px-4 py-3 text-right">
                        <button onClick={() => toggle(key)} className="inline-flex items-center gap-1 rounded-md bg-slate-800 hover:bg-slate-700 px-2 py-1 text-xs font-medium">
                          {expanded ? <ChevronDown className="w-3.5 h-3.5" /> : <ChevronRight className="w-3.5 h-3.5" />} Details
                        </button>
                      </td>
                    </tr>
                    {expanded && (
                      <tr>
                        <td colSpan={9} className="px-6 py-4 bg-slate-950/70">
                          <div className="space-y-2 text-sm">
                            <div className="font-semibold">Execution details</div>
                            <div className="text-slate-400">The displayed purchase list is the complete batch. The scanner itself is bounded and never performs recursive acquisition during the live pass.</div>
                            <div className="text-slate-400">Input costs consume the actual sell-offer depth; output revenue consumes the actual buy-order depth.</div>
                            <div className="text-slate-400">The configured inventory capacity is {inventoryCapacityUnits.toLocaleString()} shards ({inventoryStacks} stacks).</div>
                          </div>
                        </td>
                      </tr>
                    )}
                  </React.Fragment>
                );
              })}
              {!loading && opportunities.length === 0 && !error && <tr><td colSpan={9} className="px-4 py-10 text-center text-slate-500">No profitable executable batch found.</td></tr>}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
};

export default BazaarArbitragePage;
