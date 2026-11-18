// End-to-end demo on one PC: a scheduler, three nodes and a builder.
//   node A  discrete GPU (high-performance), honest
//   node B  integrated GPU (low-power), honest   -> spot-checks cross GPU vendors
//   node C  discrete GPU, CHEATS (returns tampered pixels)
// The builder submits jobs; spot-checks catch node C, which is slashed and drops below the
// 100 USD stake. Epochs are 25 s so you can watch settlement, sealing and rewards.
//
//   npm run demo          (open http://localhost:8787 while it runs)
import { rmSync } from "node:fs";
import { CONFIG, startScheduler } from "./scheduler.ts";
import { loadOrCreateKey, runNode } from "./node-client.ts";
import { submitJobs } from "./builder.ts";
import { fmtUnits } from "./protocol.ts";

const dataDir = "data/demo";
rmSync(dataDir, { recursive: true, force: true });
const cfg = { ...CONFIG, dataDir, epochSeconds: 25, spotRate: 0.3, probationJobs: 2, closeGrace: 20, dev: true };
const sched = startScheduler(cfg);
const url = `http://localhost:${cfg.port}`;
const stop = new AbortController();

// 100 USD at 0.01 USDG = 10,000 $IDLEX. A and B stake 15k; C stakes 12k and loses half when caught.
const nodes = [
  runNode({ scheduler: url, keyFile: `${dataDir}/keys/node-a.json`, gpu: "high", stake: 15_000, label: "A", signal: stop.signal }),
  runNode({ scheduler: url, keyFile: `${dataDir}/keys/node-b.json`, gpu: "low", stake: 15_000, label: "B", signal: stop.signal }),
  runNode({ scheduler: url, keyFile: `${dataDir}/keys/node-c.json`, gpu: "high", stake: 12_000, cheat: true, label: "C", signal: stop.signal }),
];
await new Promise((r) => setTimeout(r, 6000)); // let the nodes boot Chrome and register

const count = Number(process.env.JOBS ?? 12);
await submitJobs({ scheduler: url, keyFile: `${dataDir}/keys/builder.json`, count, size: 1024, iter: 2000, credits: 5, outDir: `${dataDir}/images`, label: "1" });

// Wait until every epoch that holds work has closed.
const lastWorkEpoch = Math.max(...[...sched.jobs.values()].flatMap((j) => j.results.map((r) => r.epoch)));
console.log(`\nall jobs done; waiting for epoch ${lastWorkEpoch} to close…`);
while (!sched.ledger.s.epochs.some((e) => e.epoch >= lastWorkEpoch)) await new Promise((r) => setTimeout(r, 1000));

const s = sched.ledger.s;
const row = (cells: string[]) => console.log(cells.map((c, i) => c.padEnd([8, 22, 14, 10, 12, 16][i] ?? 12)).join(""));
console.log("\n=== Result ===");
row(["node", "gpu", "stake left", "eligible", "jobs/chk", "$IDLEX reward"]);
for (const label of ["A", "B", "C"]) {
  const n = sched.ledger.node(loadOrCreateKey(`${dataDir}/keys/node-${label.toLowerCase()}.json`).address);
  row([label, n.gpu, fmtUnits(n.stake, 18, 0), String(sched.ledger.isEligible(n.address)), `${n.jobsDone}/${n.checksDone}`, fmtUnits(n.rewardIdlex, 18, 0)]);
}
const b = Object.values(s.builders)[0];
console.log(`\nbuilder spent ${fmtUnits(b.spent, 6, 4)} USDG; all of it to the Holder Vault (${fmtUnits(s.vault.usdg, 6, 4)} USDG) + ${fmtUnits(s.vault.idlex, 18, 0)} $IDLEX slashed into the vault`);
for (const e of s.epochs.filter((e) => e.receipts > 0)) {
  console.log(`epoch ${e.epoch}: ${e.settledJobs} jobs settled, ${e.receipts} receipts, root ${e.root}`);
}
const statuses = [...sched.jobs.values()].reduce<Record<string, number>>((a, j) => ((a[j.status] = (a[j.status] ?? 0) + 1), a), {});
console.log(`jobs: ${JSON.stringify(statuses)}; images in ${dataDir}/images`);

stop.abort();
await Promise.race([Promise.allSettled(nodes), new Promise((r) => setTimeout(r, 25_000))]);
process.exit(0);
