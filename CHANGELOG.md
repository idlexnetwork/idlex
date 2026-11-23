# Changelog

## 2026-11-23

### Added

- **Embedding jobs.** Nodes run nomic-embed-text v1.5 (768 dimensions) through llama.cpp. Two results match when
  every vector pair has a cosine similarity of at least 0.99. The installers fetch the model (140 MB);
  `--no-embed` leaves it out.
- **Qwen2.5 7B.** `agent.ts model list` shows the text models on disk and what this GPU can offer, and
  `agent.ts model add qwen2.5-7b` downloads 7B in two resumable, SHA-256 checked parts (`src/models.ts`). The node
  offers each text model that fits its VRAM, and says when one needs `--no-image`. The installers fetch 7B on
  cards with 10.5 GB or more.
- **NVDA payout checks.** `verify-proofs.ts --payout N` checks one epoch's NVDA payout to holders: the wallets
  paid, the amounts against the published split, and the team devices against the onchain whitelist and the
  published multiplier. `--deep` rebuilds every holding from the $IDLEX transfers.
- **Extend a booking.** `net-builder.ts extend-rental --id r_… --hours N` adds hours to a running booking at its
  own rate.
- **Builder API keys.** `net-builder.ts --api-key idx_…` (or `IDLEX_API_KEY`) sends jobs with a key from
  idlex.network/build instead of a signature.

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
