import React, { useCallback, useEffect, useState } from "react";
import { RefreshCw, TrendingUp, ShoppingCart, ArrowDownUp } from "lucide-react";
import { BazaarArbitrageService } from "../services";
import type { ArbitrageOpportunity } from "../types/bazaarArbitrage";

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

  const refresh = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const results = await BazaarArbitrageService.getInstance().findOpportunities({
        saleTaxRate: 0.01,
        minOutputLiquidity: 1,
        limit: 50,
      });
      setOpportunities(results);
      setLastUpdated(results[0]?.fetchedAt ?? Date.now());
    } catch (err) {
      console.error(err);
      setError(err instanceof Error ? err.message : "Failed to load Bazaar data");
    } finally {
      setLoading(false);
    }
  }, []);

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
            <h1 className="text-2xl sm:text-3xl font-bold mt-1">Best shards to craft right now</h1>
            <p className="text-slate-400 mt-1 max-w-3xl">
              Inputs are priced from live sell offers, meaning this model assumes you buy materials immediately.
              The default exit is an immediate sell into the current buy-order book.
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

        <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
          <div className="rounded-lg border border-slate-800 bg-slate-900/70 p-4">
            <div className="flex items-center gap-2 text-sky-300 text-sm font-medium"><ShoppingCart className="w-4 h-4" /> Input strategy</div>
            <div className="text-lg font-semibold mt-1">Instant Buy</div>
            <div className="text-xs text-slate-500 mt-1">Consumes the cheapest live sell offers; no buy-order waiting.</div>
          </div>
          <div className="rounded-lg border border-slate-800 bg-slate-900/70 p-4">
            <div className="flex items-center gap-2 text-amber-300 text-sm font-medium"><ArrowDownUp className="w-4 h-4" /> Exit strategy</div>
            <div className="text-lg font-semibold mt-1">Instant Sell</div>
            <div className="text-xs text-slate-500 mt-1">Consumes live buy orders so reported profit is immediately executable.</div>
          </div>
          <div className="rounded-lg border border-slate-800 bg-slate-900/70 p-4">
            <div className="text-sm font-medium text-violet-300">Refresh cadence</div>
            <div className="text-lg font-semibold mt-1">Every 30 seconds</div>
            <div className="text-xs text-slate-500 mt-1">
              {lastUpdated ? `Last snapshot ${new Date(lastUpdated).toLocaleTimeString()}` : "Waiting for first snapshot"}
            </div>
          </div>
        </div>

        {error && (
          <div className="rounded-lg border border-red-500/30 bg-red-500/10 p-4 text-red-200">{error}</div>
        )}

        <div className="overflow-x-auto rounded-lg border border-slate-800 bg-slate-900/60">
          <table className="min-w-full text-sm">
            <thead className="bg-slate-900">
              <tr className="text-left text-slate-400">
                <th className="px-4 py-3">#</th>
                <th className="px-4 py-3">Shard</th>
                <th className="px-4 py-3">Recipe</th>
                <th className="px-4 py-3 text-right">Capital</th>
                <th className="px-4 py-3 text-right">Profit</th>
                <th className="px-4 py-3 text-right">ROI</th>
                <th className="px-4 py-3 text-right">Profit / output</th>
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
                  <td className="px-4 py-3 text-slate-300">
                    {opportunity.recipe.inputs.join(" + ")} → ×{opportunity.recipe.outputQuantity}
                  </td>
                  <td className="px-4 py-3 text-right font-mono">{formatCoins(opportunity.capitalRequired)}</td>
                  <td className="px-4 py-3 text-right font-mono text-emerald-300">{formatCoins(opportunity.profit)}</td>
                  <td className="px-4 py-3 text-right font-mono text-emerald-300">{formatPct(opportunity.roi)}</td>
                  <td className="px-4 py-3 text-right font-mono">{formatCoins(opportunity.profitPerOutput)}</td>
                  <td className="px-4 py-3 text-right font-mono">{formatCoins(opportunity.sellLiquidity)}</td>
                </tr>
              ))}
              {!loading && opportunities.length === 0 && !error && (
                <tr>
                  <td colSpan={8} className="px-4 py-10 text-center text-slate-500">
                    No profitable craft was found at the current executable prices.
                  </td>
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
