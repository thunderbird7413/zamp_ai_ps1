# Ledgerline — Automated Invoice Decision Engine

A live, end-to-end web app that processes vendor invoices (PDFs), extracts the data with an LLM, cross-references a purchase-order database, and makes a deterministic approval decision — with a full audit trail for a human to verify the AI's work.

**Stack:** Next.js (App Router) · Tailwind CSS (dark theme) · Anthropic API for PDF extraction · embedded mock database (no setup, no credentials to persist).

---


## Run without Node or installs — browser demo

`build/index-demo.html` is a self-contained copy of the app's UI with the **real `lib/db.js` + `lib/validate.js` engine embedded** and the six sample invoices bundled (their extraction is precomputed by the real heuristic parser). Double-click it to open in any browser — no server, no npm, no API key needed. It's for instant inspection of the three views and the live terminal; the full app (LLM extraction, file uploads, session persistence) is the Next.js project above.

Regenerate it after engine changes with the build step used to produce it (it embeds the live `lib/` sources, so it always matches).

## One-click local run

- **Windows:** `run-local.bat` — sets up `.env.local`, installs deps, generates samples, starts the dev server.
- **Any OS:**
  ```bash
  npm install
  node scripts/make-samples.js   # only if public/samples is missing
  npm run dev
  ```

## Run it

```bash
npm install
npm run dev
# open http://localhost:3000
```

Production:

```bash
npm run build
npm start
```

All state (purchase orders, duplicate ledger, run history) lives in memory and is shared across API calls for the life of the server process. It resets on restart, or on demand via the **Reset session** button on the dashboard.

---

## Environment variables

Copy `.env.example` to `.env.local` (both are git-ignored; `npm run dev` picks it up automatically).

| Variable | Required | What it does |
|---|---|---|
| `ANTHROPIC_API_KEY` | strongly recommended | Sent to `https://api.anthropic.com` to run multimodal PDF extraction. |
| `ANTHROPIC_MODEL` | optional | Model id for extraction. Defaults to `claude-3-5-sonnet-20241022`. |

**Without a key the app still works:** the extraction layer (`lib/extract.js`) falls back to a local heuristic parser (regex over the PDF's text layer), and the terminal shows a note saying so. All four verdict paths remain fully testable — the bundled demo invoices are text-based PDFs, so the heuristic path handles them.

## Deploying to production

The app is a standard, framework-only Next.js project — no exotic dependencies — so it deploys anywhere Next.js runs. One thing drives the hosting choice:

**Recommended: Render (or any always-on Node host).** The data stores in `lib/db.js` and `lib/results.js` live on the Node process (on `globalThis`, so every route shares one store). A single long-running process — `npm run build` + `npm start` — is exactly the environment this app is designed for, and it's what Render's free "Web Service" runs:

```
New → Web Service → connect your GitHub repo
Runtime: Node · Plan: Free
Build command:  npm install && npm run build
Start command:  npm start
Environment:    ANTHROPIC_API_KEY, ANTHROPIC_MODEL
```

On an always-on service, history, audit links, PO balance bookkeeping, and duplicate detection all behave exactly like the local app. (Free Render instances sleep after ~15 min of idle: the *first* request after a sleep wakes the process and state resets — run the dashboard once at the start of a demo session to warm it.)

**Vercel works, with one caveat:** the API routes run as serverless Node Functions in isolated, possibly-fresh instances, so the process-level stores are per-instance — audit links and history can miss across instances. Fine for a quick share-link demo; not the best fit for this app's state. If you want Vercel with full persistence, swap `lib/db.js` / `lib/results.js` for a real database (module boundaries are already isolated — a contained change).

The engine, extraction, validation rules, and UI are production-ready on any host; only the data layer's persistence model changes with the hosting choice.

---

The extractor handles both plain `FlateDecode` streams and ReportLab-style
`ASCII85+Flate` compressed content, literal and hex text strings, and several
layout conventions (letterhead vendor names, `Invoice No:` / `INVOICE #` labels,
`PO Ref` / `PO Number` / bare `PO-xxxx` references, `Total Due` vs `Subtotal`).
Scanned/image-only PDFs have no text layer: the heuristic path cannot read them
and the engine correctly returns `MANUAL_ENTRY_REQUIRED` — set `ANTHROPIC_API_KEY`
and the LLM (vision) path will handle them instead.

## How it works

```
PDF upload ──► LLM extraction (strict JSON contract)
                 │  vendorName, invoiceNumber, date,
                 │  totalAmount, taxAmount, poNumber, lineItems
                 ▼
             deterministic validation engine (lib/validate.js)
                 │  1. duplicate ledger check
                 │  2. approved-vendor check
                 │  3. PO resolution (explicit / inferred)
                 │  4. amount & variance rules
                 ▼
       APPROVED · PENDING_REVIEW · REJECTED · MANUAL_ENTRY_REQUIRED
       (+ step-by-step reasoning log, persisted to the dashboard)
```

The LLM only extracts; **no business rule is left to the model**. The decision engine is pure code, and every step emits a log entry the UI streams live into the execution terminal.

### The edge cases, as the engine sees them

| Case | Condition | Verdict |
|---|---|---|
| Happy path | Approved vendor, not a duplicate, PO found, amounts match | `APPROVED` — PO balance decremented, invoice added to the duplicate ledger |
| **Duplicate** | `invoiceNumber` already in the processed ledger | `REJECTED` — "Duplicate invoice detected. Payment halted." |
| **Unapproved vendor** | Vendor name not in the master list | `REJECTED` — "Vendor not found in master approved list. Compliance risk." |
| **Missing PO** | Extraction returns a null `poNumber`; the engine searches for the unique PO matching `vendorName` + `totalAmount` | `PENDING_REVIEW` — "Suggested PO match found", held for a human to confirm |
| **Tax tolerance** | Invoice total exceeds the PO total, and the difference equals exactly 8% or 18% of the PO total | `APPROVED` — "Amount variance within recognized tax tolerance." |
| Other | Unknown/misspelled PO, ambiguous match, invoice exceeds remaining PO balance, PO already closed, or extraction failed | `PENDING_REVIEW` (or `REJECTED` for a closed PO) / `MANUAL_ENTRY_REQUIRED` |

### Demo invoices

`public/samples/` contains seven PDFs, one per rule (generated by `scripts/make-samples.js`):

- `sample-01-happy.pdf` → approved
- `sample-02-tax.pdf` → approved via the 8% tolerance
- `sample-03-duplicate.pdf` → rejected (already in the ledger)
- `sample-04-unapproved-vendor.pdf` → rejected (compliance)
- `sample-05-missing-po.pdf` → pending review (PO inferred)
- `sample-06-closed-po.pdf` → rejected (closed PO)
- `external-demo-invoice.pdf` → approved — an "external" invoice (new vendor + PO that
  exist in the ERP but aren't tied to any of the six rules). Use it to test uploading
  your own PDFs with different values.

On the **Process invoice** page, the "Show a sample invoice" button opens a calm,
preview-first picker: each sample is listed on the left with a live PDF preview on the
right, and a single "Load this invoice" action drops the chosen sample into the upload
slot so you can run the engine on it.

---

## Project layout

```
app/
  page.js                  dashboard: stats, history table, POs, demo invoices
  process/page.js          upload + live execution terminal + verdict
  audit/[id]/page.js       side-by-side: PDF iframe | JSON + reasoning + PO
  api/process-invoice/     POST — the engine pipeline, NDJSON stream
  api/history/ · [id] · run-file · pos · reset
components/ui.js           status badges, terminal, log lines
lib/
  db.js                    mock ERP (POs, approved vendors, duplicate ledger)
  extract.js               LLM extraction + heuristic fallback
  validate.js              the deterministic decision engine
  results.js               in-memory run history + stored PDF bytes
  samples.js · format.js
public/samples/            the six demo invoice PDFs
scripts/make-samples.js   regenerates the demo PDFs
```
