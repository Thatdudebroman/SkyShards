import { describe, expect, it } from "vitest";
import { BazaarArbitrageService } from "../services/bazaarArbitrageService";
import type { ArbitrageOptions, BazaarLevel } from "../types/bazaarArbitrage";

const service = BazaarArbitrageService.getInstance();

describe("BazaarArbitrageService order-book execution", () => {
  const levels: BazaarLevel[] = [
    { amount: 2, pricePerUnit: 10, orders: 1 },
    { amount: 3, pricePerUnit: 12, orders: 2 },
    { amount: 5, pricePerUnit: 15, orders: 4 },
  ];

  it("calculates instant-buy cost across multiple sell-offer levels", () => {
    expect(service.getInstantBuyCost(levels, 1)).toBe(10);
    expect(service.getInstantBuyCost(levels, 4)).toBe(44);
    expect(service.getInstantBuyCost(levels, 8)).toBe(110);
  });

  it("returns infinity when instant-buy liquidity is insufficient", () => {
    expect(service.getInstantBuyCost(levels, 11)).toBe(Infinity);
  });

  it("calculates instant-sell revenue across multiple buy-order levels", () => {
    expect(service.getInstantSellRevenue(levels, 1)).toBe(10);
    expect(service.getInstantSellRevenue(levels, 4)).toBe(44);
    expect(service.getInstantSellRevenue(levels, 8)).toBe(110);
  });

  it("returns negative infinity when instant-sell liquidity is insufficient", () => {
    expect(service.getInstantSellRevenue(levels, 11)).toBe(-Infinity);
  });

  it("supports the requested 100m / 35-stack constraint defaults", () => {
    const defaults: Required<Pick<ArbitrageOptions, "capitalBudget" | "maxInventoryStacks" | "stackSize">> = {
      capitalBudget: 100_000_000,
      maxInventoryStacks: 35,
      stackSize: 64,
    };

    expect(defaults.capitalBudget).toBe(100_000_000);
    expect(defaults.maxInventoryStacks * defaults.stackSize).toBe(2_240);
  });
});
