// The scheduler's live dashboard at "/": polls /api/state every 2 s. Plain HTML, no build step.
export const DASHBOARD_HTML = /* html */ `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Idlex scheduler · prototype</title>
<style>
:root{--ink:#080a09;--soft:#4b524e;--muted:#7a817c;--line:#e6e9e4;--bg:#f6f7f4;--card:#fff;--lime:#c8f25a;--sky:#a9d8ff;--pink:#ffbcd9;--bad:#b8407e}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--ink);font:14px/1.45 ui-sans-serif,system-ui,-apple-system,"Segoe UI",sans-serif}
main{max-width:1200px;margin:0 auto;padding:24px 16px 48px}
h1{font-size:20px;margin:0}h2{font-size:13px;font-family:ui-monospace,monospace;letter-spacing:.08em;text-transform:uppercase;color:var(--muted);margin:28px 0 10px}
.top{display:flex;flex-wrap:wrap;gap:12px;align-items:center;justify-content:space-between}
.tag{display:inline-flex;gap:6px;align-items:center;border-radius:999px;background:var(--card);box-shadow:0 0 0 1px var(--line);padding:3px 10px;font-size:12px}
.dot{width:7px;height:7px;border-radius:50%;background:var(--muted)}.on{background:#5aad2a}.warn{background:var(--pink)}
.grid{display:grid;gap:12px;grid-template-columns:repeat(auto-fill,minmax(230px,1fr))}
.card{background:var(--card);border-radius:12px;box-shadow:0 0 0 1px var(--line),0 1px 2px #0000000a;padding:14px}
.k{font:11px ui-monospace,monospace;letter-spacing:.06em;text-transform:uppercase;color:var(--muted)}.v{font-size:18px;font-weight:600;margin-top:2px}
table{width:100%;border-collapse:collapse;background:var(--card);border-radius:12px;overflow:hidden;box-shadow:0 0 0 1px var(--line)}
th,td{text-align:left;padding:8px 10px;border-bottom:1px solid var(--line);font-size:13px;vertical-align:middle}th{font-weight:500;color:var(--muted);font-size:12px}
.mono{font-family:ui-monospace,monospace;font-size:12px}.pill{border-radius:999px;padding:2px 8px;font-size:12px;background:#eef0ec}
.verified{background:#e6f7c4}.verifying{background:#e3f1ff}.disputed,.refunded{background:#ffe3ef}.running,.queued{background:#f1f2ef}
.jobs{display:grid;gap:10px;grid-template-columns:repeat(auto-fill,minmax(170px,1fr))}.job img{width:100%;aspect-ratio:4/3;object-fit:cover;border-radius:8px;background:var(--ink);display:block}
.log{background:var(--ink);color:#d7dcd8;border-radius:12px;padding:12px 14px;font:12px/1.6 ui-monospace,monospace;max-height:320px;overflow:auto;white-space:pre-wrap}
.bad{color:var(--bad)}
</style></head><body><main>
<div class="top"><div><h1>Idlex scheduler</h1><div style="color:var(--muted)">Local prototype · simulated ledger, no chain, no real tokens</div></div><div id="epoch" class="tag"></div></div>
<h2>Network</h2><div class="grid" id="cards"></div>
<h2>Nodes</h2><table><thead><tr><th>Node</th><th>GPU</th><th>Stake</th><th>Jobs / checks</th><th>$IDLEX rewards</th><th>Slashed</th></tr></thead><tbody id="nodes"></tbody></table>
<h2>Jobs</h2><div class="jobs" id="jobs"></div>
<h2>Epochs</h2><table><thead><tr><th>Epoch</th><th>Jobs settled</th><th>USDG</th><th>To vault</th><th>Receipt root</th><th>Rewards</th></tr></thead><tbody id="epochs"></tbody></table>
<h2>Log</h2><div class="log" id="log"></div>
</main><script>
const $=(id)=>document.getElementById(id);
const u=(v,d,f=2)=>{v=BigInt(v);const b=10n**BigInt(d);const w=v/b;const fr=(v%b).toString().padStart(d,"0").slice(0,f);return w.toLocaleString("en-US")+(f?"."+fr:"")};
const s=(a)=>a.slice(0,6)+"…"+a.slice(-4);
async function tick(){
  const r=await fetch("/api/state");const st=await r.json();
  $("epoch").innerHTML='<span class="dot on"></span>Epoch '+st.epoch+' · closes in '+st.epochEndsIn+'s';
  const online=st.nodes.filter(n=>n.online).length;
  $("cards").innerHTML=[["Nodes online",online+" / "+st.nodes.length],["Queue",st.queue+" waiting · "+st.running+" running"],["Min stake","100 USD = "+u(st.requiredStake,18,0)+" $IDLEX"],["Holder Vault",u(st.vault.usdg,6)+" USDG · "+u(st.vault.idlex,18,0)+" $IDLEX"]].map(([k,v])=>'<div class="card"><div class="k">'+k+'</div><div class="v">'+v+'</div></div>').join("");
  $("nodes").innerHTML=st.nodes.map(n=>'<tr><td class="mono"><span class="dot '+(n.online?"on":"")+'" style="display:inline-block;margin-right:6px"></span>'+s(n.address)+'</td><td>'+(n.gpu||"-")+'</td><td>'+u(n.stake,18,0)+' <span class="pill '+(n.eligible?"verified":"disputed")+'">'+(n.eligible?"eligible":"below 100 USD")+'</span></td><td>'+n.jobsDone+' / '+n.checksDone+'</td><td>'+u(n.rewardIdlex,18,0)+'</td><td class="'+(n.caught?"bad":"")+'">'+(n.caught?u(n.slashed,18,0)+" ("+n.caught+"x)":"-")+'</td></tr>').join("");
  $("jobs").innerHTML=st.jobs.map(j=>'<div class="card job">'+(j.status==="verified"?'<img loading="lazy" src="/api/jobs/'+j.id+'/output.png">':'<div style="aspect-ratio:4/3;border-radius:8px;background:#eef0ec"></div>')+'<div style="margin-top:8px;display:flex;justify-content:space-between;gap:6px"><span class="mono">'+j.id.slice(0,10)+'</span><span class="pill '+j.status+'">'+j.status+'</span></div><div style="color:var(--muted);font-size:12px;margin-top:4px">'+j.params.width+'×'+j.params.height+' · '+u(j.credits,6,4)+' USDG'+(j.checked?' · checked':'')+'</div></div>').join("");
  $("epochs").innerHTML=st.epochs.map(e=>'<tr><td>'+e.epoch+'</td><td>'+e.settledJobs+'</td><td>'+u(e.settledCredits,6,4)+'</td><td>'+u(e.feeToVault,6,4)+'</td><td class="mono">'+e.root.slice(0,14)+'… ('+e.receipts+')</td><td>'+e.rewards.map(r=>s(r.node)+": "+u(r.idlex,18,0)).join("<br>")+'</td></tr>').join("");
  $("log").textContent=st.log.join("\\n");
}
tick();setInterval(()=>tick().catch(()=>{}),2000);
</script></body></html>`;
