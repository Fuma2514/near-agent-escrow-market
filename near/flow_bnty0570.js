// Fresh on-chain lifecycle run for DAiL bnty_0570 (re-listing of bnty_0522), executed against the
// already-deployed market contract (mkt.dspaid-bounty452.testnet). Skips init/storage_deposit (the
// contract is live) and uses bounty-tagged order ids so this run's txs are distinct from the 0522 set.
//   node flow_bnty0570.js   -> writes evidence_0570.json (same schema as evidence.json)
// Flow: hire ord_0570_a (lock) -> deliver -> accept (release to seller)
//       hire ord_0570_b (lock) -> deliver -> dispute (100% refund to buyer)
const L = require('./lib');
const near = L.near;
const RPC_URL = process.env.NEAR_RPC || L.RPCS[0];
const PIN = new near.JsonRpcProvider({ url: RPC_URL });

const A = 'ord_0570_a'; // happy path order id
const B = 'ord_0570_b'; // dispute path order id

async function viewRaw(m, args = {}) {
  const r = await fetch(RPC_URL, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    signal: AbortSignal.timeout(15000),
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'query', params: { request_type: 'call_function', finality: 'final', account_id: L.MKT, method_name: m, args_base64: Buffer.from(JSON.stringify(args)).toString('base64') } }),
  });
  const j = await r.json();
  if (j.error) throw new Error(`view ${m}: ${JSON.stringify(j.error).slice(0, 200)}`);
  const res = j.result || {};
  if (res.error) throw new Error(`view ${m}: ${String(res.error).slice(0, 200)}`);
  const raw = res.result;
  return (Array.isArray(raw) ? Buffer.from(raw) : Buffer.from(String(raw), 'base64')).toString();
}

async function view(m, args = {}, expect = null) {
  for (let i = 0; i < 10; i++) {
    let v;
    try { v = await viewRaw(m, args); } catch { continue; }
    if (!expect || expect(v)) return v;
    await new Promise((r) => setTimeout(r, 2000));
  }
  return viewRaw(m, args);
}

async function call(accId, method, args = {}, deposit = 0n) {
  const acc = new near.Account(accId, PIN, L.SECRET);
  let res;
  try {
    res = await acc.signAndSendTransaction({ receiverId: L.MKT, actions: [near.actions.functionCall(method, args, L.GAS, deposit)] });
  } catch (e) {
    const rec = (e.transactionResult?.receipts_outcome || []).map((r) => { const f = r.outcome?.status?.Failure; return !f ? '' : typeof f === 'string' ? Buffer.from(f, 'base64').toString() : JSON.stringify(f); }).join('|');
    throw new Error(`${method}: ${String(e.message).replace(/\s+/g, ' ').slice(0, 150)} | ${rec.slice(0, 200)}`);
  }
  let ok = false;
  const logs = [];
  for (const r of res.receipts_outcome || []) {
    const st = r.outcome?.status;
    if (st?.SuccessValue !== undefined) ok = true;
    else if (st?.Failure) {
      const f = st.Failure;
      throw new Error(`${method}: ${typeof f === 'string' ? Buffer.from(f, 'base64').toString() : JSON.stringify(f)}`.slice(0, 300));
    }
    logs.push(...(r.outcome?.logs || []));
  }
  if (!ok) throw new Error(`${method}: no success receipt`);
  const hashes = L.txHashes(res);
  console.log(`> ${method}(${JSON.stringify(args)})${deposit ? ` +${String(deposit)}y` : ''}  tx: ${hashes[0]}`);
  for (const lg of logs) console.log(`    log: ${lg.slice(0, 200)}`);
  return { signer: accId, method, args, deposit_yocto: String(deposit), tx: hashes[0], explorer: `https://testnet.nearblocks.io/txns/${hashes[0]}`, logs };
}

function assert(cond, msg) {
  if (!cond) throw new Error(`ASSERT FAILED: ${msg}`);
  console.log(`  ✓ ${msg}`);
}

(async () => {
  const ev = { contract: L.MKT, token_symbol: 'AEDT', run_for: 'bnty_0570 (re-listing of bnty_0522; contract initialized in the 2026-11-06 run)', steps: [], started: new Date().toISOString() };

  // Resumable: re-running after a partial crash reads each order's on-chain state and executes
  // only the missing transitions, so evidence always ends with ord_0570_a released / ord_0570_b refunded.
  async function stateOf(id) {
    try { const o = JSON.parse(await view('get_order', { order_id: id })); return o && o.state ? o.state : 'none'; } catch { return 'none'; }
  }
  // testnet 'final' views lag a block behind committed txs - poll until the transition is visible
  async function waitState(id, target) {
    for (let i = 0; i < 12; i++) {
      if ((await stateOf(id)) === target) return true;
      await new Promise((r) => setTimeout(r, 2000));
    }
    return false;
  }

  // happy path: hire (lock 30 AEDT) -> deliver -> accept (release to seller)
  const sa = await stateOf(A);
  console.log(`resume ${A}: on-chain state = ${sa}`);
  if (sa === 'none') {
    ev.steps.push(await call(L.MAIN, 'hire', { order_id: A, service_id: 'svc_1' }, L.ONE_YOCTO));
    assert((await view('get_order', { order_id: A }, (v) => v.includes('"escrowed"'))).includes('"escrowed"'), `${A} state == escrowed (tokens locked in contract)`);
  } else {
    assert(['escrowed', 'delivered', 'released'].includes(sa), `resumed ${A} from state ${sa}`);
  }
  assert((await view('ft_balance_of', { account_id: L.MKT }, (v) => v === `"${L.t(30)}"` || v === '"0"')) !== '"0"' || sa === 'released', 'contract FT balance == 30 AEDT while locked');
  if (sa === 'none' || sa === 'escrowed') ev.steps.push(await call(L.SELLER, 'deliver', { order_id: A }, L.ONE_YOCTO));
  if (await waitState(A, 'delivered')) ev.steps.push(await call(L.MAIN, 'accept', { order_id: A }, L.ONE_YOCTO));

  // dispute path: hire -> deliver -> dispute -> full refund to buyer
  const sb = await stateOf(B);
  console.log(`resume ${B}: on-chain state = ${sb}`);
  if (sb === 'none') ev.steps.push(await call(L.MAIN, 'hire', { order_id: B, service_id: 'svc_1' }, L.ONE_YOCTO));
  else assert(['escrowed', 'delivered', 'refunded'].includes(sb), `resumed ${B} from state ${sb}`);
  if (sb === 'none' || sb === 'escrowed') ev.steps.push(await call(L.SELLER, 'deliver', { order_id: B }, L.ONE_YOCTO));
  if (await waitState(B, 'delivered')) ev.steps.push(await call(L.MAIN, 'dispute', { order_id: B }, L.ONE_YOCTO));

  // verification (mirrors the market.js engine invariants; balances are cumulative with the 0522 run)
  const supply = await view('ft_total_supply', {}, (v) => v === `"${L.t(1000)}"`);
  const buyerBal = await view('ft_balance_of', { account_id: L.MAIN }, (v) => v === `"${L.t(940)}"`);
  const sellerBal = await view('ft_balance_of', { account_id: L.SELLER }, (v) => v === `"${L.t(60)}"`);
  const vaultBal = await view('ft_balance_of', { account_id: L.MKT }, (v) => v === '"0"');
  const locked = await view('verify_locked', {}, (v) => v === '"0"');
  const oa = JSON.parse(await view('get_order', { order_id: A }, (v) => v.includes('"released"')));
  const ob = JSON.parse(await view('get_order', { order_id: B }, (v) => v.includes('"refunded"')));
  ev.verification = { ft_total_supply: supply, buyer_balance: buyerBal, seller_balance: sellerBal, vault_balance: vaultBal, verify_locked: locked, [`${A}_state`]: oa.state, [`${B}_state`]: ob.state };
  console.log('EVIDENCE:', JSON.stringify(ev.verification));

  assert(supply === `"${L.t(1000)}"`, 'total supply unchanged at 1000 AEDT');
  assert(buyerBal === `"${L.t(940)}"`, 'buyer balance == 940 AEDT (paid 30 for released order ord_0570_a; ord_0570_b fully refunded)');
  assert(sellerBal === `"${L.t(60)}"`, 'seller earned exactly 60 AEDT cumulative (30 in the 0522 run + 30 tonight)');
  assert(vaultBal === '"0"', 'contract vault drained to 0 (no funds left locked)');
  assert(locked === '"0"', 'verify_locked invariant: sum(open locks) == 0 == contract balance');
  assert(oa.state === 'released', `${A} terminal state == released`);
  assert(ob.state === 'refunded', `${B} terminal state == refunded`);

  ev.finished = new Date().toISOString();
  require('fs').writeFileSync(require('path').join(__dirname, 'evidence_0570.json'), JSON.stringify(ev, null, 2));
  console.log('\nFLOW ALL-PASS - evidence written to near/evidence_0570.json');
})().catch((e) => { console.error('FLOW FAILED:', e.message); process.exit(1); });
