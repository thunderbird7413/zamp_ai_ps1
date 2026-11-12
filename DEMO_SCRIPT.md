# Ledgerline — Demo Script (short, spoken-style · ~3:30)

Before you start:
- Run `npm run build` then `npm start` (NOT dev mode).
- Have your ANTHROPIC_API_KEY working (the key sample should show "extraction: llm").
- Open your browser full-window so the terminal text is readable.
- Have these samples in mind, in this order: **happy → duplicate → 8% tax → missing PO → re-run the happy one.**

---

## [0:00] Dashboard — say this while it's on screen

> "So, every finance team has the same headache: a pile of vendor invoices, and
> someone has to check each one by hand — is this a duplicate, is this vendor
> approved, do the numbers match the purchase order. It's slow, and one mistake
> is a double payment. Ledgerline does that check in a few seconds, and keeps
> a full record of *why* it decided what it decided. This is the dashboard —
> everything we've processed, and the purchase orders we're checking against."

*(Click "Process a new invoice".)*

## [0:20] Happy path — sample → Run engine

*(Click "Show a sample invoice" → pick "Clean invoice" → "Load this invoice" → "Run engine". Let the terminal play out for ~5 seconds.)*

> "Let's process one. I loaded a sample — but you could drop in any real PDF,
> it's the same pipeline. Watch the terminal: first, the language model reads
> the PDF and pulls out the vendor, invoice number, total, tax, and the PO
> reference. Then the **rules engine** takes over — and this is the important
> bit: the AI only *reads*. It never touches the money decisions. The rules
> ask: duplicate? vendor approved? does the amount fit the purchase order?
> All yes, so: **approved.** And two things just happened in the background —
> the PO's balance went down by $12,450, and this invoice is now marked paid,
> so it can never be paid twice."

## [1:10] Audit view

*(Click "Open side-by-side audit".)*

> "Now the part I want you to remember: *why* did it approve? Left — the exact
> document we processed. Right — what we read off it, and the rule log, step
> by step. If an accountant asks 'did anyone actually check this?' — this is
> the receipt. No black box."

*(Click "Process invoice" to go back.)*

## [1:30] Duplicate case

*(Run the "Duplicate" sample.)*

> "Now the interesting invoices. This one was already submitted — the engine
> catches it instantly: *'Duplicate invoice detected. Payment halted.'* That's
> your double-payment protection, working."

## [1:50] 8% tax case

*(Run the "Tax tolerance" sample.)*

> "This one's total is higher than the purchase order. That could be an error —
> or it could just be tax. The engine knows our tax rates: when the difference
> is *exactly* 8 percent, that's GST, not fraud — so it approves, and writes
> down the reason. One invoice a human would have to sit and figure out. Done
> in seconds."

## [2:15] Missing PO case *(say it fast, or skip if you're over time)*

*(Run the "Missing PO" sample.)*

> "Quick one: this invoice has no PO number printed on it. The engine finds the
> *one* purchase order matching this vendor and this amount, and holds it for a
> human to confirm: *'Suggested PO match found.'* It never guesses on money —
> it just points a human at the answer."

## [2:40] Your own invoice + the closer

*(Run the external demo invoice, or your own PDF.)*

> "All of that was samples — real invoices run through the same pipeline. And
> one last check: I approved that first invoice minutes ago. Watch what happens
> when I send it in again…"

*(Re-run the happy-path sample.)*

> "**Rejected. Duplicate.** The one that just got approved, refused. That's the
> double-pay protection, live."

## [3:15] Wrap

> "So the whole system in one line: a language model **reads**, a rules engine
> **decides**, and the audit trail **proves** it. Same invoice in, same answer
> out, every time. And the whole thing runs on the free tier — one click to
> deploy, and the mock purchase-order system is one module away from being your
> real one. Questions?"

---

## If a judge asks (be ready, don't read these — 10-second answers)

- **"What if the AI misreads the invoice?"** — Great question: the AI only
  extracts. The verdict comes from deterministic rules — the amount must match
  a real PO, the vendor must be on the approved list, duplicates get blocked.
  A misread number that doesn't match any PO just gets held for a human.
- **"Why not let the LLM make the decision?"** — Because money decisions have
  to be reproducible and auditable. Judges, accountants, and tax auditors need
  to see *why* — a rule log you can read, not a model's vibes.
- **"Where is the data stored?"** — Right now, a mock ERP in the server
  process: purchase orders, approved vendors, a duplicate ledger. It's behind
  one module, so swapping in a real database is a contained change.
- **"How fast / how much does it cost?"** — A few seconds per invoice. The
  whole thing runs on free tiers (Vercel + Haiku is pennies per invoice).
- **"Why 'pending review' instead of just approving?"** — Money rule: if
  something's unusual — missing PO, amount doesn't fit — the machine *holds*
  it and tells a human exactly what to check. It only auto-approves when every
  rule passes.
