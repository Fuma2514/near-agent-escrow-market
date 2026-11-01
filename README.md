# near-agent-escrow-market

**DAiL bnty_0397 entry — NEAR Hackathon Agent Economy track.**
A working prototype of an escrowed agent-services market modeled on the
NEAR Intents model: agents hire agents, buyer funds are **locked in escrow**
at intent time, work is delivered and verified, and escrow releases to the
seller on acceptance (or refunds on dispute).

## The problem
Agent-to-agent hiring needs the same trust machine human marketplaces use:
the buyer must not be able to walk away after delivery, and the seller must
not be paid before delivering. The intent-then-settle model solves both by
moving money into a locked escrow state the moment the intent is signed.

## How it works
1. `register` — agent joins with a starting balance (ledger entry).
2. `listService` — a seller lists a service with a price.
3. `hire` — buyer **debits immediately into escrow** (locked, not spendable).
4. `deliver` — seller delivers; order moves to `delivered`.
5. `accept` — buyer verifies and accepts → escrow **releases to the seller**.
6. `dispute` — buyer disputes before accepting → escrow **refunds the buyer**.
7. `verify` — invariant check: every escrowed/delivered order's amount is
   provably locked out of circulating balances.

Dependency-free Node.js (stdlib only) — no install step at all.

## Run it
```bash
node market.js
```

### Expected result
```
after hire  : alice = 70 | verify: { locked: 30, events: 4 }
after accept: alice = 70 bob = 80 | verify: { locked: 0, events: 6 }
```
Then a full event trail (register → list_service → escrow_lock → delivered
→ escrow_release) prints as JSON.

### Try the dispute path
```js
const { EscrowMarket } = require("./market.js");
const m = new EscrowMarket();
m.register("a", 100); m.register("b", 0);
m.listService("b", "s1", "x", 40);
const o = m.hire("a", "s1", "o1");
m.deliver(o);
m.dispute(o);                       // refund path
console.log(m.balance("a"));        // 100  (escrow refunded in full)
```

## Why it fits the Agent Economy track
- **Intents, not calls**: `hire` locks funds at intent time — no trust window.
- **Escrow with two exits**: verified release (`accept`) or full refund (`dispute`).
- **Public verifiability**: every state change is an event; `verify()` proves
  locked funds always equal open order value.
- **Agent-agnostic**: any agent with an id can register, list, and hire.

## Map to a real NEAR deployment
`hire` → FT `ft_transfer_call` into an escrow contract with the order memo;
`accept`/`dispute` → contract calls releasing to `seller` or `buyer`;
`verify` → on-chain view summing open-order locks. The state machine here is
the contract spec.
