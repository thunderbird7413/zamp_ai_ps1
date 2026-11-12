/**
 * lib/extract.js — PDF data extraction.
 *
 * Primary: sends the PDF's base64 to Anthropic (model from ANTHROPIC_MODEL,
 * default claude-3-5-sonnet-20241022) with a strict prompt that must return
 * ONLY a JSON object:
 *   { vendorName, invoiceNumber, date, totalAmount, taxAmount, poNumber, lineItems }
 *
 * Fallback: if no ANTHROPIC_API_KEY is set, or the API call times out /
 * errors / returns unparseable JSON, a local heuristic parser (regex over
 * the PDF's text layer) makes a best effort. Fallbacks are SILENT — no error
 * text is surfaced to the UI; only the source tag ("llm" | "heuristic" |
 * "failed") changes. The pipeline never throws.
 */

const db = require("./db");
const zlib = require("zlib");

const EXTRACTION_SYSTEM_PROMPT = `You are the extraction module of an invoice-approval pipeline.
You will receive one or more invoice images (PDF pages rendered as document content).

Return ONLY a single JSON object — no markdown, no code fences, no commentary.
Schema:
{
  "vendorName":    string | null,  // the billing vendor's legal name
  "invoiceNumber": string | null,
  "date":          string | null,   // ISO format YYYY-MM-DD if visible, else null
  "totalAmount":   number | null,   // final payable total, digits only, e.g. 3250.05
  "taxAmount":     number | null,
  "poNumber":      string | null,   // purchase-order reference printed on the invoice, else null
  "lineItems":     [{ "description": string, "qty": number|null, "unitPrice": number|null, "amount": number|null }]
}
Rules:
- Numbers: strip currency symbols, thousands separators, and words. Never guess a value that is not printed on the invoice — use null.
- Keep "poNumber" exactly as printed (uppercase the prefix). If no PO reference appears, use null — do not invent one.
- If the document is not an invoice at all, set vendorName and invoiceNumber to null and add "error": "not-an-invoice".`;

const MODEL = process.env.ANTHROPIC_MODEL || "claude-3-5-sonnet-20241022";

/**
 * @param {Buffer} pdfBuffer
 * @returns {Promise<{ source: "llm"|"heuristic"|"failed", data: object|null, note?: string }>}
 */
async function extractInvoiceFromPDF(pdfBuffer) {
  const apiKey = (process.env.ANTHROPIC_API_KEY || "").trim();
  if (apiKey.length > 0) {
    const llmResult = await tryLLM(pdfBuffer, apiKey);
    if (llmResult.data) return llmResult;
    // LLM path failed for ANY reason (bad key, timeout, rate limit, bad JSON)
    // — fall through to the local parser. Silent on purpose: the pipeline
    // always produces a result, and internal errors are never surfaced to the UI.
    const fallback = heuristicExtract(pdfBuffer);
    fallback.note = null;
    return fallback;
  }
  const heuristic = heuristicExtract(pdfBuffer);
  heuristic.note = null; // no key configured: quiet, local parse
  return heuristic;
}

async function tryLLM(pdfBuffer, apiKey) {
  try {
    const resp = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      // If the API hangs, bail after 30s and let the local parser take over.
      signal: AbortSignal.timeout(30_000),
      headers: {
        "content-type": "application/json",
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: MODEL,
        max_tokens: 2000,
        system: EXTRACTION_SYSTEM_PROMPT,
        messages: [
          {
            role: "user",
            content: [
              {
                type: "document",
                source: { type: "base64", media_type: "application/pdf", data: pdfBuffer.toString("base64") },
              },
              { type: "text", text: "Extract this invoice now. Reply with the JSON object only." },
            ],
          },
        ],
      }),
    });

    if (!resp.ok) {
      const errText = await resp.text().catch(() => "");
      return { source: "llm", data: null, note: `Anthropic API ${resp.status}: ${errText.slice(0, 200)}` };
    }
    const body = await resp.json();
    const text = (body.content || []).map((b) => (b.type === "text" ? b.text : "")).join("\n");
    const data = parseLLMJSON(text);
    if (data) return { source: "llm", data };
    return { source: "llm", data: null, note: "LLM returned invalid JSON." };
  } catch (e) {
    return { source: "llm", data: null, note: e.message || String(e) };
  }
}

/**
 * Parses an LLM reply that should be a JSON object. Tolerates code fences
 * and surrounding prose by finding the first balanced { … } block.
 */
function parseLLMJSON(text) {
  if (!text) return null;
  let candidate = text.trim();
  const fenced = candidate.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fenced) candidate = fenced[1].trim();
  const start = candidate.indexOf("{");
  const end = candidate.lastIndexOf("}");
  if (start === -1 || end === -1 || end <= start) return null;
  let parsed;
  try {
    parsed = JSON.parse(candidate.slice(start, end + 1));
  } catch {
    return null;
  }
  return normalizeExtraction(parsed);
}

function coerceNum(v) {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string") {
    const n = parseFloat(v.replace(/[^0-9.-]/g, ""));
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

function normalizeExtraction(raw) {
  if (!raw || typeof raw !== "object") return null;
  return {
    vendorName: raw.vendorName ?? null,
    invoiceNumber: raw.invoiceNumber ?? null,
    date: raw.date ?? null,
    totalAmount: coerceNum(raw.totalAmount),
    taxAmount: coerceNum(raw.taxAmount),
    poNumber: raw.poNumber ? String(raw.poNumber).trim() : null,
    lineItems: Array.isArray(raw.lineItems)
      ? raw.lineItems.map((li) => ({
          description: li?.description ?? null,
          qty: coerceNum(li?.qty),
          unitPrice: coerceNum(li?.unitPrice),
          amount: coerceNum(li?.amount),
        }))
      : [],
    _raw: raw,
  };
}

// ---------------------------------------------------------------------------
// Heuristic fallback — regex over the PDF's ASCII text stream.
// Works for text-based PDFs (invoices generated by PDFKit etc.); it is a
// safety net, not the primary path.
// ---------------------------------------------------------------------------
const VENDOR_WHITELIST = [...db.approvedVendors];

function heuristicExtract(pdfBuffer) {
  try {
    const text = pdfText(pdfBuffer);
    const upper = text.toUpperCase();

    const vendorName =
      VENDOR_WHITELIST.find((v) => upper.includes(v.toUpperCase())) ||
      // A "Vendor:" / "Supplier:" field (its value is usually on the next line).
      (text.match(/VENDOR\s*:?\s*([A-Za-z][A-Za-z0-9 &.,'-]{2,40})/i) || [])[1]?.trim() ||
      (text.match(/\bSUPPLIER\s*:?\s*([A-Za-z][A-Za-z0-9 &.,'-]{2,40})/i) || [])[1]?.trim() ||
      // Letterhead fallback: professional invoices open with the company name on
      // its own line (ACME INDUSTRIAL SUPPLY LTD., Metro Facilities Corp, ...).
      firstVendorLine(text);

    // Invoice numbers in their common printed forms:
    //   "Invoice No: INV-2026-0142", "Invoice #: 4471", bare "INV-2024-0142"
    const invNo =
      (text.match(/INVOICE\s*(?:NUMBER|NO|NUM|#)\s*[:\s]?\s*(INV-[A-Z0-9-]+|[A-Z0-9]{2,12}-?\d{3,10})/i) || [])[1] ||
      (text.match(/\bINV-[A-Z0-9]{2,12}-\d{3,10}\b/i) || [])[0] ||
      null;

    // PO references: "PO Number: PO-1101", "PO Ref: PO-1205", "PO: 1101", bare "PO-2024-0417".
    // Keep the full reference (with "PO-" prefix) so findPO() can match it.
    let poRef = null;
    const poLabeled = text.match(/\bPO[-\s]?(?:NUMBER|REF|NO\.?|#)?\s*:\s*([A-Z0-9][A-Z0-9-]{2,19})\b/i);
    if (poLabeled) {
      poRef = poLabeled[1];
    } else {
      const poBare =
        text.match(/\bPO-[A-Z0-9]{2,12}-\d{2,10}\b/i) || text.match(/\bPO-[A-Z0-9]{2,19}\b/i);
      if (poBare) poRef = poBare[0];
    }
    if (poRef && !/^PO-/i.test(poRef)) poRef = "PO-" + poRef.toUpperCase();

    // Dates: ISO first, then US-style MM/DD/YYYY.
    const dateM =
      text.match(/\b(\d{4}-\d{2}-\d{2})\b/) || text.match(/\b(\d{1,2}\/\d{1,2}\/\d{4})\b/);
    const date = dateM ? dateM[1] : null;

    // Final payable total. Prefer "Total Due" / "Amount Due"; a bare TOTAL line
    // is only accepted when it is NOT "Subtotal" (lookbehind on the T).
    const totalM =
      text.match(/TOTAL\s*DUE[^\d]{0,10}(\$?\s*[\d][\d,]*(?:\.\d{1,2})?)/i) ||
      text.match(/AMOUNT\s*DUE[^\d]{0,12}(\$?\s*[\d][\d,]*(?:\.\d{1,2})?)/i) ||
      text.match(/(?<![A-Za-z])TOTAL\s*:?[^\d]{0,10}(\$?\s*[\d][\d,]*(?:\.\d{1,2})?)/i) ||
      null;
    // "Tax (8%) 996.00" / "Tax: 12.00" / "Tax (0%) $0.00" — "Tax (embedded)" yields no number.
    const taxM = text.match(
      /TAX(?!ID)(?:\s*RATE)?\s*(?:\(\s*\d+\s*%\s*\))?\s*:?\s*(\$?[\d][\d,]*(?:\.\d{1,2})?)/i
    );
    const totalAmount = totalM && totalM[1] ? Number(totalM[1].replace(/[$,\s]/g, "")) : null;
    const taxAmount = taxM && taxM[1] ? Number(taxM[1].replace(/[$,\s]/g, "")) : null;

    const hasContent = vendorName || invNo || totalAmount;
    if (!hasContent) {
      return { source: "heuristic", data: null, note: "Heuristic parser found no invoice content in the PDF text layer." };
    }
    return {
      source: "heuristic",
      data: {
        vendorName,
        invoiceNumber: invNo,
        date,
        totalAmount,
        taxAmount,
        poNumber: poRef,
        lineItems: [],
      },
    };
  } catch (e) {
    return { source: "heuristic", data: null, note: `Heuristic parser error: ${e.message}` };
  }
}

/**
 * Crude PDF text extraction: locate content streams, decode FlateDecode and
 * ASCII85+Flate (ReportLab) compressed streams, and pull readable strings
 * out of the ( ... ) Tj and [ ... ] TJ text operators — in both literal
 * and hex string forms.
 */
function pdfText(buf) {
  const raw = buf.toString("latin1");
  const chunks = [];

  const pullTj = (text) => {
    // (abc) Tj  /  (abc) TJ
    (text.match(/\(((?:\\.|[^\\()])*)\)\s*T[jJ]/g) || []).forEach((m) =>
      chunks.push(unescapePDF(m.slice(1, m.lastIndexOf(")"))))
    );
    // TJ arrays: [(a) -120 (b) <0061>] TJ — mix of literal and hex strings
    (text.match(/\[((?:\\.|[^\\\]])*)\]\s*TJ/g) || []).forEach((m) => {
      const inner = m.slice(1, m.lastIndexOf("]"));
      (inner.match(/\(((?:\\.|[^\\()])*)\)/g) || []).forEach((p) =>
        chunks.push(unescapePDF(p.slice(1, p.length - 1)))
      );
      (inner.match(/<([0-9A-Fa-f\s]+)>/g) || []).forEach((h) =>
        chunks.push(decodeHexString(h.slice(1, -1)))
      );
    });
  };

  // 1) Uncompressed literal strings
  pullTj(raw);

  // 2) Stream objects — decode per their /Filter, reading the dict context.
  let from = 0;
  for (;;) {
    const i = raw.indexOf("stream", from);
    if (i < 0) break;
    from = i + 6;
    const dictCtx = raw.slice(Math.max(0, i - 600), i).replace(/\s+/g, " ");
    const bodyStart = i + 6 + (raw[i + 6] === "\r" ? 2 : 1);
    const e = raw.indexOf("endstream", from);
    let body = raw.slice(bodyStart, e);
    body = body.replace(/\r?\n$/, "");
    const lengthM = dictCtx.match(/\/Length\s+(\d+)/);
    if (lengthM && Number(lengthM[1]) > 0) {
      body = raw.slice(bodyStart, bodyStart + Number(lengthM[1]));
    }

    let decoded = null;
    if (/ASCII85Decode/.test(dictCtx) && /FlateDecode/.test(dictCtx)) {
      // ReportLab default: ASCII85 -> Flate, with a '~>' terminator before endstream
      let a85 = body.replace(/\s+/g, "");
      const tilde = a85.indexOf("~>");
      if (tilde > -1) a85 = a85.slice(0, tilde);
      try {
        const rawBytes = decodeA85(a85);
        try {
          decoded = zlib.inflateSync(rawBytes).toString("latin1");
        } catch {
          decoded = rawBytes.toString("latin1");
        }
      } catch {
        decoded = null;
      }
    } else if (/FlateDecode/.test(dictCtx)) {
      try {
        decoded = zlib.inflateSync(Buffer.from(body, "latin1")).toString("latin1");
      } catch {
        decoded = null;
      }
    } else if (/ASCII85Decode/.test(dictCtx)) {
      let a85 = body.replace(/\s+/g, "").replace(/~>?$/, "");
      try {
        decoded = Buffer.from(decodeA85(a85)).toString("latin1");
      } catch {
        decoded = null;
      }
    }
    const text = decoded || body;
    pullTj(text);
  }
  // Preserve line structure (each Tj string is its own line) so the
  // letterhead/first-line heuristic can key on whole lines.
  return chunks.join("\n");
}

/**
 * Letterhead heuristic: the vendor name is usually the first content line that
 * looks like a company name — not a label (BILL TO, INVOICE, ...), not a date,
 * not a phone/PO/tax-id line. Used when no explicit "Vendor:" field exists.
 */
function firstVendorLine(text) {
  const skip = /^(?:\s*(?:BILL\s*TO|INVOICE|PO\b|PAY|VENDOR|SUPPLIER|ATTN|RE\b|DATE|TAX\s*ID|NET|TERM|DUE|SUBTOTAL|TOTAL|TAX\b|AMOUNT|DESCRIPTION|UNIT\s*PRICE|QTY|QUANTITY|CURRENCY|THANK|ORDER|INVOICE\s*NO|INVOICE\s*#))/i;
  for (const rawLine of text.split(/\n/)) {
    const line = rawLine.trim();
    if (line.length < 4 || line.length > 52) continue;
    if (skip.test(line)) continue;
    if (!/[A-Za-z]{3,}/.test(line)) continue; // need letters
    if (/\d{1,2}\/\d{1,2}\/\d{4}/.test(line)) continue; // a date
    if (/^[+\d\s().-]{6,}$/.test(line)) continue; // phone-only
    if (/TAX\s*ID/i.test(line)) continue; // contact line
    const looksName =
      /\b(Co|Company|Inc|LLC|LLP|LTD|Ltd\.?|Corp|Corp\.|GmbH|Ltda|PLC|Group)\b/i.test(line) ||
      /[A-Z][a-z]+[ .&-]+[A-Z]/.test(line) || // "Nimbus Tech Supply Co."
      (/^[A-Z][A-Z0-9 &./'-]+[A-Z0-9.]$/.test(line) && line.length > 6); // all-caps name
    if (looksName) return line;
  }
  return null;
}

/** ASCII85 (base85, Adobe variant) decoder. */
function decodeA85(str) {
  let s = str.replace(/~>?$/, "");
  const groups = Math.ceil(s.length / 5);
  const out = Buffer.alloc(groups * 4);
  let o = 0;
  for (let i = 0; i < s.length; i += 5) {
    if (s[i] === "z") {
      o += 4; // "z" = four zero bytes
      continue;
    }
    let v = 0;
    for (let j = 0; j < 5; j++) {
      const c = i + j < s.length ? s.charCodeAt(i + j) : 0x75; // missing chars pad as 'u'
      v = v * 85 + (c - 33); // ASCII85: '!'(33) -> 0 ... 'u'(117) -> 84 (padding)
    }
    out[o] = (v >>> 24) & 0xff;
    out[o + 1] = (v >>> 16) & 0xff;
    out[o + 2] = (v >>> 8) & 0xff;
    out[o + 3] = v & 0xff;
    o += 4;
  }
  // Trailing 'u' padding means those bytes are zero — trim them.
  const padCount = 5 - (s.length % 5 || 5);
  return padCount ? out.slice(0, out.length - padCount) : out;
}

function decodeHexString(h) {
  const clean = h.replace(/\s+/g, "");
  let out = "";
  for (let i = 0; i < clean.length; i += 2) {
    out += String.fromCharCode(parseInt(clean.substr(i, 2), 16));
  }
  return unescapePDF(out);
}

function unescapePDF(s) {
  return s
    .replace(/\\n/g, " ")
    .replace(/\\r/g, " ")
    .replace(/\\t/g, " ")
    .replace(/\\\(/g, "(")
    .replace(/\\\)/g, ")")
    .replace(/\\\\/g, "\\");
}

module.exports = { extractInvoiceFromPDF, parseLLMJSON, MODEL };
