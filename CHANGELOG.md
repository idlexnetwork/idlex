# Changelog

## 2026-11-20

### Added

- **GPU rental (beta).** `agent.ts start --rent 0.25` puts your node up for rent at an hourly rate in USDG
  (0.05 to 5). While a builder's booking runs, the node takes only their jobs. The agent prints its rate, and the
  booking's end time when it is booked.
- **Builder rental commands.** `net-builder.ts gpus`, `rent --node 0x… --hours N`, `rental --id …` and
  `end-rental --id …`. Jobs submitted during a booking run on the booked GPU.
- **Reputation tier at start.** The agent prints the node's tier (New, Steady or Trusted), its verified count and
  what the next tier needs.
- **Proof checker.** `verify-proofs.ts` recomputes receipt leaves, epoch Merkle roots and hourly reward draws from
  the published receipts, and checks them against the contracts on Robinhood Chain. `proof-math.ts` holds the
  same math with only viem, and the checker confirms it matches `protocol.ts` and `merkle.ts`.

### Changed

- README: reward amounts are no longer quoted. The per-job range and the hourly cap are set onchain before each
  hour, and `verify-proofs.ts` prints them.
- README: new sections on reputation tiers, renting out your GPU, checking the network yourself, and builder
  commands. Known limits now state that checks are sampled.

## 2026-11-19

### Added

- **Open market asks.** `agent.ts start --ask 0.9`, or per model with `--ask sd15=0.8,qwen2.5-3b=1.1`: your price as
  a multiple of the listed price, from 0.5 to 2.

## 2026-11-18

- First public release: node agent, AI runners, output checks, installers for Windows and Linux, and a local
  prototype of the network. MIT license.
