import React, { useCallback, useEffect, useMemo, useState } from "react";
import { RefreshCw, TrendingUp, ShoppingCart, ArrowDownUp, Boxes } from "lucide-react";
import { BazaarArbitrageService } from "../services";
import type { ArbitrageOpportunity } from "../types/bazaarArbitrage";

const DEFAULT_CAPITAL = 100_000_000;
const DEFAULT_STACKS = 35;
const STACK_SIZE = 64;

const formatCoins = (value: number) => {
  if (!Number.isFinite(value)) return "∞";
  return new Intl.NumberFormat("en-US", { maximumFractionDigits: 0 }).format(value);
};

const formatPct = (value: number) => `${(value * 100).toFixed(1)}%`;

export const BazaarArbitragePage: React.FC = () => {
  const [opportunities, setOpportunities] = useState<ArbitrageOpportunity[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [lastUpdated, setLastUpdated] = useState<number | null>(null);
  const [capitalMillions, setCapitalMillions] = useState(DEFAULT_CAPITAL / 1_000_000);
  const [inventoryStacks, setInventoryStacks] = useState(DEFAULT_STACKS);

  const capitalBudget = useMemo(() => Math.max(0, capitalMillions) * 1_000_000, [capitalMillions]);

  const refresh = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const results = await BazaarArbitrageService.getInstance().findOpportunities({
        saleTaxRate: 0.01,
        minOutputLiquidity: 1,
        limit: 50,
        capitalBudget,
        maxInventoryStacks: inventoryStacks,
        stackSize: STACK_SIZE,
      });
      setOpportunities(results);
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
            <p className="text-slate-400 mt-1 max-w-4xl">
              The ranking now optimizes the <strong>total profit of an actual batch</strong>. Raw materials are
              always bought immediately from the live sell side; completed shards are immediately sold into live buy orders.
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
            <div className="text-xs text-slate-500 mt-1">Hard ceiling: {formatCoins(capitalBudget)} coins per batch.</div>
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
            <div className="text-xs text-slate-500 mt-1">Assumes {STACK_SIZE} shards per stack = {inventoryStacks * STACK_SIZE.toLocaleString()} units.</div>
          </label>

          <div className="rounded-lg border border-slate-800 bg-slate-900/70 p-4">
            <div className="flex items-center gap-2 text-amber-300 text-sm font-medium"><ShoppingCart className="w-4 h-4" /> Input strategy</div>
            <div className="text-lg font-semibold mt-1">Instant Buy</div>
            <div className="text-xs text-slate-500 mt-1">Consumes multiple sell-book levels when necessary.</div>
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
                <th className="px-4 py-3">Batch</th>
                <th className="px-4 py-3">Recipe</th>
                <th className="px-4 py-3 text-right">Capital</th>
                <th className="px-4 py-3 text-right">Profit</th>
                <th className="px-4 py-3 text-right">ROI</th>
                <th className="px-4 py-3 text-right">Peak inventory</th>
                <th className="px-4 py-3 text-right">Sell liquidity</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-800">
              {opportunities.map((opportunity, index) => (
                <tr key={`${opportunity.shardId}-${index}`} className="hover:bg-slate-800/40">
                  <td className="px-4 py-3 text-slate-500 font-mono">{index + 1}</td>
                  <td className="px-4 py-3">
                    <div className="font-semibold">{opportunity.shardName}</div>
                    <div className="text-xs text-slate-500">{opportunity.rarity}</div>
                  </td>
                  <td className="px-4 py-3 font-mono">
                    <div>{opportunity.batchCrafts} crafts</div>
                    <div className="text-xs text-slate-500">→ {opportunity.outputQuantity.toLocaleString()} shards</div>
                  </td>
                  <td className="px-4 py-3 text-slate-300">{opportunity.recipe.inputs.join(" + ")} → ×{opportunity.recipe.outputQuantity}</td>
                  <td className="px-4 py-3 text-right font-mono">{formatCoins(opportunity.capitalRequired)}</td>
                  <td className="px-4 py-3 text-right font-mono text-emerald-300">{formatCoins(opportunity.profit)}</td>
                  <td className="px-4 py-3 text-right font-mono text-emerald-300">{formatPct(opportunity.roi)}</td>
                  <td className="px-4 py-3 text-right font-mono">{opportunity.peakInventoryStacks.toFixed(1)} stacks</td>
                  <td className="px-4 py-3 text-right font-mono">{formatCoins(opportunity.sellLiquidity)}+</td>
                </tr>
              ))}
              {!loading && opportunities.length === 0 && !error && (
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
