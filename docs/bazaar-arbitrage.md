# Bazaar Arbitrage Optimizer

The arbitrage dashboard is available at `/arbitrage`.

## Execution model

- Input materials are priced using the cheapest live sell offers, so the optimizer assumes immediate Bazaar purchases.
- The default exit is an immediate sale into live buy orders.
- The optimizer walks multiple order-book levels when calculating executable prices instead of assuming infinite top-of-book liquidity.
- A 1% sale-tax assumption is used by default for the conservative instant-sell model and can be changed in the service options.

The calculation engine from SkyShards remains the source of truth for fusion recipes and recursive acquisition paths.
