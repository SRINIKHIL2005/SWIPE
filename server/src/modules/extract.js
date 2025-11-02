import { GoogleGenerativeAI } from '@google/generative-ai'
import xlsx from 'xlsx'
import fs from 'fs/promises'
import os from 'os'
import path from 'path'
import pdfParse from 'pdf-parse'

// Support either GEMINI_API_KEY or GOOGLE_API_KEY (Gemini keys come from Google AI Studio)
const API_KEY = process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY
const MODEL = process.env.GEMINI_MODEL || 'gemini-1.5-pro-latest'
const API_VERSION = process.env.GEMINI_API_VERSION || 'v1'
const BASE_URL = `https://generativelanguage.googleapis.com/${API_VERSION}`

let genAI = API_KEY ? new GoogleGenerativeAI(API_KEY) : null

function setApiVersion(version) {
  if (!API_KEY) return
  // SDK doesn't allow switching easily; our manual HTTP client below uses BASE_URL
}

async function httpGenerateContent(model, parts, generationConfig = {}, debugLog) {
  const versionsToTry = Array.from(new Set([API_VERSION, 'v1beta']))
  const body = { contents: [{ role: 'user', parts }], generationConfig }
  let lastErr
  for (const ver of versionsToTry) {
    const base = `https://generativelanguage.googleapis.com/${ver}`
    const url = `${base}/models/${model}:generateContent?key=${encodeURIComponent(API_KEY||'')}`
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    })
    if (!res.ok) {
      const text = await res.text()
      const safeUrl = url.replace(/(key=)[^&]+/i, '$1****')
      if (debugLog) debugLog.push({ step: 'http-generate-error', status: res.status, url: safeUrl, responsePreview: text.slice(0, 400) })
      lastErr = new Error(`HTTP ${res.status}: ${text}`)
      // If model not found for v1, try next (likely v1beta)
      if (res.status === 404 && /not found for API version/i.test(text)) continue
      // Otherwise break
      break
    }
    const json = await res.json()
    if (debugLog) debugLog.push({ step: 'http-generate-ok', model, apiVersionUsed: ver })
    return json
  }
  throw lastErr || new Error('generateContent failed')
}

const systemSchema = `
You are an information extraction engine. Extract ONLY structured fields and return JSON that matches EXACTLY this schema. Do not include any explanations or markdown.
{
  "products": [
    {
      "name": "string",
      "unitPrice": 0,
      "taxRate": 0,
      "priceWithTax": 0,
      "quantity": 0,
      "discount": 0
    }
  ],
  "customers": [
    {
      "name": "string",
      "phone": "string",
      "totalPurchase": 0
    }
  ],
  "invoices": [
    {
      "serialNumber": "string",
      "customerName": "string",
      "date": "string",
      "items": [
        { "productName": "string", "qty": 0, "unitPrice": 0, "taxRate": 0 }
      ],
      "tax": 0,
      "totalAmount": 0
    }
  ]
}
Rules:
- Use 0 or empty string when a value is missing; never invent plausible values.
- taxRate is a fraction (e.g., 0.18 for 18%).
- priceWithTax = unitPrice * (1 + taxRate) if not explicitly present.
- Return ONLY JSON. No additional text.
`

export async function extractFromFiles(files, { debug=false } = {}) {
  const merged = { products: [], customers: [], invoices: [] }
  const debugLog = []
  for (const f of files) {
    const ext = (f.originalname.split('.').pop() || '').toLowerCase()
    if (debug) debugLog.push({ step: 'file-received', name: f.originalname, mimetype: f.mimetype, ext, size: f.size })
    if (['xls','xlsx','csv'].includes(ext)) {
      let fromX = await extractFromExcelBuffer(f.buffer, debug ? debugLog : undefined)
      // If Excel heuristic yielded nothing and AI is available, try CSV-text AI, then file-upload AI as last resort
      if (API_KEY && (!fromX.products?.length && !fromX.customers?.length && !fromX.invoices?.length)) {
        try {
          const wb = xlsx.read(f.buffer, { type: 'buffer' })
          const sheet = wb.Sheets[wb.SheetNames[0]]
          const csvText = xlsx.utils.sheet_to_csv(sheet)
          if (csvText && csvText.trim().length > 0) {
            if (debug) debugLog.push({ step: 'excel-csv-fallback', note: 'Try AI from CSV text', chars: csvText.length })
            const aiFromCsv = await extractWithGeminiFromCSV(csvText, f.originalname, debug ? debugLog : undefined)
            if (aiFromCsv && (aiFromCsv.products?.length || aiFromCsv.customers?.length || aiFromCsv.invoices?.length)) {
              fromX = aiFromCsv
            }
          }
        } catch {}
        if (!fromX.products?.length && !fromX.customers?.length && !fromX.invoices?.length) {
          if (debug) debugLog.push({ step: 'excel-binary-fallback', note: 'Try AI from binary spreadsheet' })
          const aiFallback = await extractWithGemini({
            buffer: f.buffer,
            originalname: f.originalname,
            mimetype: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
          })
          fromX = aiFallback
        }
      }
      merge(merged, fromX)
    } else if (ext === 'pdf') {
      // Try local PDF text fallback first (no AI)
      const fromPdf = await extractFromPdfBuffer(f.buffer, debug ? debugLog : undefined)
      merge(merged, fromPdf)
      // If AI is available, optionally enhance when extraction looks poor
      if (API_KEY && shouldEnhanceWithAI(fromPdf)) {
        if (debug) debugLog.push({ step: 'pdf-ai-enhance', note: 'Heuristic says PDF parse is low-quality; enhancing with Gemini' })
        try {
          const fromAI = await extractWithGemini(f, debug ? debugLog : undefined)
          merge(merged, fromAI)
        } catch (e) {
          if (debug) debugLog.push({ step: 'pdf-ai-enhance-error', error: String(e?.message||'') })
        }
      }
    } else if (API_KEY) {
      if (debug) debugLog.push({ step: 'non-excel-file', note: 'Use Gemini', name: f.originalname })
      const fromAI = await extractWithGemini(f, debug ? debugLog : undefined)
      merge(merged, fromAI)
    } else {
      // Fallback minimal when no API key
      merge(merged, { products: [], customers: [], invoices: [] })
    }
  }
  // Cleanup obvious noise from parsers/AI before normalization
  const cleaned = cleanResults(merged, debug ? debugLog : undefined)
  // Normalize: map names to ids and compute totals
  const normalized = normalize(cleaned)
  if (debug) {
    normalized._debug = {
      steps: debugLog,
      counts: {
        products: normalized.products.length,
        customers: normalized.customers.length,
        invoices: normalized.invoices.length
      }
    }
  }
  return normalized
}

function merge(target, src) {
  target.products.push(...(src.products||[]))
  target.customers.push(...(src.customers||[]))
  target.invoices.push(...(src.invoices||[]))
}

async function extractFromExcelBuffer(buf, debugLog) {
  const wb = xlsx.read(buf, { type: 'buffer' })
  // Heuristic: take first sheet
  const sheet = wb.Sheets[wb.SheetNames[0]]
  const rows = xlsx.utils.sheet_to_json(sheet, { defval: '' })

  if (!rows.length) return { products: [], customers: [], invoices: [] }

  // Map likely columns by fuzzy names (expanded synonyms)
  const header = Object.keys(rows[0] || {})
  const pick = (keys) => header.find(h => keys.some(k => h.toLowerCase().includes(k)))
  const serialKey = pick(['serial','invoice','inv','bill no','bill','sno','sr no'])
  const custKey = pick(['customer','party','client','buyer','name'])
  const phoneKey = pick(['phone','mobile','contact'])
  const productKey = pick(['product','item','description'])
  const qtyKey = pick(['qty','quantity','pcs','pieces','units'])
  const priceKey = pick(['unit price','unit','price','rate','amount'])
  const taxKey = pick(['tax','gst','cgst','sgst','igst','vat'])
  const totalKey = pick(['grand total','invoice total','total amount','total','amount'])
  const dateKey = pick(['invoice date','bill date','date','dt'])

  if (debugLog) debugLog.push({ step: 'excel-headers', header, picks: { serialKey, custKey, phoneKey, productKey, qtyKey, priceKey, taxKey, totalKey, dateKey }, rows: rows.length })

  const products = []
  const customers = []
  const invoices = []

  for (const r of rows) {
    const name = String(productKey ? r[productKey] : '').trim()
    const cust = String(custKey ? r[custKey] : '').trim()
    const phone = String(phoneKey ? r[phoneKey] : '').trim()
    const unitPrice = Number(priceKey ? r[priceKey] : 0) || 0
    const qty = Number(qtyKey ? r[qtyKey] : 0) || 0
    // tax may be in percent form (e.g., 18). Convert >1 to fraction.
    let taxRaw = Number(taxKey ? r[taxKey] : 0) || 0
    const taxRate = taxRaw > 1.0 ? (taxRaw / 100) : taxRaw
    const priceWithTax = unitPrice * (1 + taxRate)
    const totalFromRow = Number(totalKey ? r[totalKey] : 0) || 0
    const date = String(dateKey ? r[dateKey] : '').trim()
    const serial = String(serialKey ? r[serialKey] : '').trim()

    // Only record rows that look like data
    const hasAny = name || cust || unitPrice || qty || totalFromRow
    if (!hasAny) continue

    if (name) {
      products.push({ name, unitPrice, taxRate, priceWithTax, quantity: qty })
    }
    if (cust) {
      customers.push({ name: cust, phone, totalPurchase: totalFromRow })
    }
    invoices.push({
      serialNumber: serial,
      customerName: cust,
      date,
      items: name ? [{ productName: name, qty, unitPrice, taxRate }] : [],
      tax: unitPrice * qty * taxRate,
      totalAmount: totalFromRow || (unitPrice * qty * (1 + taxRate))
    })
  }

  // If still nothing, return empty
  return { products, customers, invoices }
}

async function extractFromPdfBuffer(buf, debugLog) {
  try {
    const data = await pdfParse(buf)
    const text = (data.text || '').replace(/\r/g, '')
    if (debugLog) debugLog.push({ step: 'pdf-text', chars: text.length, pages: data.numpages })

    if (!text || text.trim().length === 0) return { products: [], customers: [], invoices: [] }

    // Basic field extraction heuristics
    const lines = text.split(/\n+/).map(s => s.trim()).filter(Boolean)

    // Customer block: look for common labels: Bill To / Billed To / Customer / Customer Name / Buyer / Party / Client / Consignee / Ship To / Sold To / Recipient
    let customerName = ''
    for (let i = 0; i < lines.length; i++) {
      const l = lines[i]
      if (/^(bill\s*to|billed\s*to|customer(?:\s*name)?|buyer|party|client|consignee|ship\s*to|sold\s*to|recipient)[:\s]/i.test(l)) {
        // Take current line (after colon) or next non-empty line(s)
        const after = l.split(/:\s*/i)[1]
        if (after && after.trim()) { customerName = after.trim() }
        else {
          // Prefer only the first following non-empty line as name
          // Skip obvious meta labels like GSTIN/Phone/Email
          let lookAhead = 1
          while (lookAhead <= 3) {
            const cand1 = (lines[i+lookAhead] || '').trim()
            if (cand1 && !/^(gstin|gst\s*in|phone|ph\:|email|place\s*of\s*supply)/i.test(cand1)) {
              customerName = cand1
              break
            }
            lookAhead++
          }
        }
        break
      }
    }
    // Secondary scan for inline key-value like "Customer: XYZ" anywhere
    if (!customerName) {
      for (const l of lines) {
        const m = l.match(/(?:customer(?:\s*name)?|buyer|party|client)\s*[:\-]\s*(.+)$/i)
        if (m && m[1]) { customerName = m[1].trim(); break }
      }
    }

    // Extract customer phone number
    let customerPhone = ''
    for (const l of lines) {
      // Look for phone patterns near customer section or standalone
      const phoneMatch = l.match(/(?:phone|mobile|ph|tel|contact)[:\s]*([+]?[0-9\s\-\(\)]{7,15})/i) || 
                         l.match(/\b([+]?[0-9]{1,4}[\s\-]?[0-9]{3,4}[\s\-]?[0-9]{3,4}[\s\-]?[0-9]{3,4})\b/)
      if (phoneMatch && phoneMatch[1]) {
        customerPhone = phoneMatch[1].replace(/[\s\-\(\)]/g, '')
        if (customerPhone.length >= 7) break
      }
    }

    // Invoice number: require digits in the captured segment to avoid grabbing the tail of the word "INVOICE"
    let serialNumber = ''
    for (let idx = 0; idx < lines.length; idx++) {
      const l = lines[idx]
      const m = l.match(/(?:invoice|inv|bill)\s*(?:no\.?|#|number)?\s*[:#-]?\s*([A-Za-z0-9][A-Za-z0-9\-\/# ]{1,})/i)
      if (m && m[1] && /[0-9]/.test(m[1])) { serialNumber = m[1].trim(); break }
      // If the next line looks like an ID token with digits, accept it
      const nxt = (lines[idx+1]||'').trim()
      if (!serialNumber && /(?:invoice|inv|bill)\b/i.test(l) && /^[A-Za-z0-9][A-Za-z0-9\-\/#]{2,}$/.test(nxt) && /[0-9]/.test(nxt)) {
        serialNumber = nxt
        break
      }
    }

    // Date (with validation to avoid address-like tokens)
    let date = ''
    const parseDate = (s) => {
      const t = s.trim()
      // yyyy-mm-dd
      let m = t.match(/^(\d{4})[\/.\-](\d{1,2})[\/.\-](\d{1,2})$/)
      if (m) {
        const y = Number(m[1]), mo = Number(m[2]), d = Number(m[3])
        if (y >= 1900 && y <= 2100 && mo >=1 && mo <=12 && d>=1 && d<=31) return `${y}-${String(mo).padStart(2,'0')}-${String(d).padStart(2,'0')}`
      }
      // dd-mm-yyyy or dd/mm/yy(yy)
      m = t.match(/^(\d{1,2})[\/.\-](\d{1,2})[\/.\-](\d{2,4})$/)
      if (m) {
        const d = Number(m[1]), mo = Number(m[2]); let y = Number(m[3])
        if (y < 100) y += 2000
        if (y >= 1900 && y <= 2100 && mo >=1 && mo <=12 && d>=1 && d<=31) return `${y}-${String(mo).padStart(2,'0')}-${String(d).padStart(2,'0')}`
      }
      // Month name dd, yyyy
      m = t.match(/^([A-Za-z]{3,9})\s+(\d{1,2}),?\s+(\d{4})$/)
      if (m) return t
      return ''
    }
    const tryExtractLabeledDate = () => {
      for (const l of lines) {
        let m = l.match(/date\s*[:\-]?\s*(.+)$/i)
        if (m && m[1]) {
          const cand = parseDate(m[1])
          if (cand) return cand
        }
      }
      return ''
    }
    date = tryExtractLabeledDate()
    if (!date) {
      // Look near top 20 lines where dates usually appear
      for (const l of lines.slice(0, 20)) {
        const tokens = l.split(/\s+/)
        for (const tok of tokens) {
          const cand = parseDate(tok)
          if (cand) { date = cand; break }
        }
        if (date) break
      }
    }

    // Grand total (look for many synonyms)
    let totalAmount = 0
    for (const l of lines.slice(-40)) { // search near the end
      const m = l.match(/(grand\s*total|invoice\s*total|total\s*amount|total\s*due|amount\s*due|balance\s*due|net\s*amount|payable)\s*[:\-]?\s*([₹$]?\s*[0-9,]+(?:\.[0-9]{1,2})?)/i)
      if (m && m[2]) {
        totalAmount = Number(m[2].replace(/[^0-9.]/g, '')) || 0
        break
      }
    }

    // Try to locate items table with multiple strategies
    const items = []
    
    // Strategy 1: Look for explicit table headers
    const headerIdx = lines.findIndex(l => /(description|item|product|particulars)/i.test(l) && /(qty|quantity|nos)/i.test(l) && /(rate|price|unit|amount)/i.test(l))
    if (headerIdx >= 0) {
      for (let i = headerIdx + 1; i < lines.length; i++) {
        const l = lines[i]
        // Split by multiple spaces or tabs
        const parts = l.split(/\s{2,}|\t+/).map(s => s.trim()).filter(Boolean)
        if (parts.length < 3) {
          // Also try patterns like "Widget A x2 @ 49.99"
          const pat = l.match(/^(.+?)\s+(?:x|qty\s*[:#]?)\s*(\d+)\s*@\s*([₹$]?[0-9,]+(?:\.[0-9]{1,2})?)/i)
          if (pat) {
            const name = pat[1].trim()
            const qty = Number(pat[2]) || 0
            const unitPrice = Number((pat[3]||'').replace(/[^0-9.]/g, '')) || 0
            if (name && qty && unitPrice) items.push({ productName: name, qty, unitPrice, taxRate: 0 })
            continue
          }
          continue
        }
        // Heuristic mapping: last is amount or unit price, one of the earlier is qty
        let qty = 0, unitPrice = 0, name = '', taxRate = 0
        // Find a numeric token as qty (usually small numbers)
        for (let j = 1; j < parts.length; j++) {
          const num = Number(parts[j].replace(/[^0-9.]/g, ''))
          if (!Number.isNaN(num) && num > 0 && num < 10000) { qty = num; break }
        }
        // Unit price likely in the last 1-2 tokens (larger numbers)
        const tailNums = parts.slice(-3).map(t => Number(t.replace(/[^0-9.]/g, ''))).filter(n => !Number.isNaN(n) && n > 0)
        if (tailNums.length >= 2) {
          unitPrice = tailNums[0] // rate/price
          // Last number might be total amount for this line
        } else if (tailNums.length === 1) {
          unitPrice = tailNums[0]
        }
        // Name is first token(s)
        name = parts[0]
        
        // Extract tax rate if present (look for percentage)
        for (const part of parts) {
          const taxMatch = part.match(/(\d+(?:\.\d+)?)\s*%/)
          if (taxMatch) {
            taxRate = Number(taxMatch[1]) / 100
            break
          }
        }
        
        if (name && (qty || unitPrice) && !/^(subtotal|tax|total|amount\s*due|balance\s*due|net\s*amount|grand|final)/i.test(name)) {
          items.push({ productName: name, qty: qty || 1, unitPrice: unitPrice || 0, taxRate })
        }
        // Stop if we hit another section
        if (/^(subtotal|tax|total|amount\s*due|balance\s*due|net\s*amount|grand|final)/i.test(l)) break
      }
    }
    
    // Strategy 2: Numbered items (1., 2., etc.) with description and amounts
    if (items.length === 0) {
      for (let i = 0; i < lines.length; i++) {
        const l = lines[i]
        // Look for numbered items like "1 ITEM NAME 100.00 5.00 500.00"
        const numbered = l.match(/^(\d+)\s+(.+?)\s+([0-9,]+(?:\.[0-9]{1,2})?)\s+([0-9,]+(?:\.[0-9]{1,2})?)\s+([0-9,]+(?:\.[0-9]{1,2})?)/)
        if (numbered) {
          const name = numbered[2].trim()
          const qty = Number(numbered[3].replace(/[^0-9.]/g, '')) || 1
          const unitPrice = Number(numbered[4].replace(/[^0-9.]/g, '')) || 0
          const amount = Number(numbered[5].replace(/[^0-9.]/g, '')) || 0
          
          // Validate the math makes sense
          if (name && unitPrice > 0 && Math.abs(qty * unitPrice - amount) < (amount * 0.3)) {
            items.push({ productName: name, qty, unitPrice, taxRate: 0 })
          }
        }
      }
    }
    
    // Strategy 3: Fallback pattern matching for any line with product-like structure
    if (items.length === 0) {
      for (const l of lines) {
        // Skip obvious non-product lines
        if (/^(invoice|bill|tax|total|subtotal|amount|due|customer|consignee|gstin|place|bank|terms)/i.test(l)) continue
        
        // Look for patterns: Name Numbers Numbers (at least 2 numbers that could be qty and price)
        const patterns = [
          // "Product Name 5 100.00 500.00" (qty, rate, amount)
          l.match(/^([A-Za-z][^0-9]+?)\s+(\d{1,4})\s+([0-9,]+(?:\.[0-9]{1,2})?)\s+([0-9,]+(?:\.[0-9]{1,2})?)$/),
          // "Product Name 100.00" (just rate)
          l.match(/^([A-Za-z][^0-9]+?)\s+([0-9,]+(?:\.[0-9]{1,2})?)$/)
        ]
        
        for (const m of patterns) {
          if (m) {
            const name = m[1].trim()
            let qty = 1, unitPrice = 0
            
            if (m.length === 5) { // qty, rate, amount pattern
              qty = Number(m[2]) || 1
              unitPrice = Number((m[3]||'').replace(/[^0-9.]/g, '')) || 0
            } else if (m.length === 3) { // just rate pattern
              unitPrice = Number((m[2]||'').replace(/[^0-9.]/g, '')) || 0
            }
            
            if (name.length > 3 && unitPrice > 0) {
              items.push({ productName: name, qty, unitPrice, taxRate: 0 })
              break
            }
          }
        }
      }
    }

    const products = items.map(it => ({ name: it.productName, unitPrice: it.unitPrice, taxRate: it.taxRate, priceWithTax: it.unitPrice * (1 + it.taxRate), quantity: it.qty }))
    const customers = customerName ? [{ name: customerName, phone: customerPhone, totalPurchase: totalAmount }] : []
    const invoices = [{ serialNumber, customerName, date, items, tax: 0, totalAmount }]

    if (debugLog) debugLog.push({ step: 'pdf-extracted', items: items.length, customerName: !!customerName, serialNumber: !!serialNumber, totalAmount })

    // If nothing meaningful, return empty
    const hasData = products.length || customers.length || (items.length || totalAmount)
    if (!hasData) return { products: [], customers: [], invoices: [] }
    return { products, customers, invoices }
  } catch (e) {
    if (debugLog) debugLog.push({ step: 'pdf-parse-error', error: String(e?.message||'') })
    return { products: [], customers: [], invoices: [] }
  }
}

// Heuristic: decide if the PDF-only extraction is low-quality and should be enhanced by AI
function shouldEnhanceWithAI(result) {
  if (!result) return true
  const products = Array.isArray(result.products) ? result.products : []
  const invoices = Array.isArray(result.invoices) ? result.invoices : []
  const customers = Array.isArray(result.customers) ? result.customers : []

  // No items at all? Enhance.
  const totalItems = (invoices[0]?.items?.length || 0)
  if (products.length === 0 && totalItems === 0) return true

  // Product names that look like address/bank/meta lines
  const badWords = /(karnataka|telangana|bank|ifsc|branch|gstin|invoice|tax|total|amount|pay|upi|terms|conditions|notes|email|place\s*of\s*supply|account)/i
  let suspicious = 0
  for (const p of products) {
    const name = String(p?.name||'')
    if (!name || name.length < 3) { suspicious++; continue }
    if (badWords.test(name)) suspicious++
    // Names that are too long and contain commas likely address lines
    if (name.length > 40 && /,/.test(name)) suspicious++
  }
  if (products.length > 0 && suspicious >= Math.ceil(products.length/2)) return true

  // If all unit prices are zero, likely failed to parse
  if (products.length > 0 && products.every(p => !Number(p.unitPrice))) return true

  // If invoice has no date or items, enhance
  if (invoices.length > 0) {
    const inv = invoices[0]
    const noDate = !String(inv.date||'').trim()
    const noItems = !(inv.items?.length)
    if (noDate || noItems) return true
  }

  // Looks acceptable
  return false
}

// Simple AI echo to verify key and endpoint
export async function aiEcho(prompt = 'Say ok', debug=false) {
  if (!API_KEY) return { ok: false, error: 'NO_API_KEY' }
  const candidates = Array.from(new Set([
    MODEL,
    'gemini-1.5-flash-8b',
    'gemini-1.5-flash',
    'gemini-1.5-pro'
  ])).filter(Boolean)
  let lastErr
  for (const m of candidates) {
    try {
      const dbg = []
      const json = await httpGenerateContent(m, [ { text: prompt } ], { temperature: 0 }, dbg)
      const apiVersionUsed = (dbg.find(s => s.step==='http-generate-ok')||{}).apiVersionUsed || API_VERSION
      const text = json?.candidates?.[0]?.content?.parts?.[0]?.text || JSON.stringify(json)
      return { ok: true, modelUsed: m, apiVersionUsed, text }
    } catch (e) {
      lastErr = e
    }
  }
  return { ok: false, error: String(lastErr?.message||'UNKNOWN') }
}

async function extractWithGemini(file, debugLog) {
  const mimeType = file.mimetype
  const prompt = `${systemSchema}\nAnalyze the attached file (it may be an invoice PDF/image or a spreadsheet).\n- If spreadsheet: detect header synonyms (item/description, qty, rate/price, gst/cgst/sgst/igst, customer/party, invoice no, date).\n- If PDF/image: OCR and read tables and key-value blocks.\n- Return arrays even if only one item is found.\nReturn only valid JSON as specified.`

  const candidates = Array.from(new Set([
    MODEL,
    // Gemini 2.x
    'gemini-2.5-flash',
    'gemini-2.0-flash',
    'gemini-2.0-pro',
    'gemini-2.0-flash-lite',
    // Current/recent IDs
    'gemini-1.5-pro',
    'gemini-1.5-pro-001',
    'gemini-1.5-pro-002',
    'gemini-1.5-flash',
    'gemini-1.5-flash-001',
    'gemini-1.5-flash-002',
    'gemini-1.5-pro-latest',
    'gemini-1.5-flash-latest',
    'gemini-1.5-flash-8b',
    'gemini-1.5-flash-8b-latest',
    // Legacy vision-capable models (v1beta friendly)
    'gemini-pro-vision',
    'gemini-1.0-pro-vision',
    'gemini-1.0-pro-vision-latest',
  ])).filter(Boolean)

  // Strongly-typed JSON schema enforcement (Gemini structured response)
  const responseSchema = {
    type: 'object',
    properties: {
      products: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            name: { type: 'string' },
            unitPrice: { type: 'number' },
            taxRate: { type: 'number' },
            priceWithTax: { type: 'number' },
            quantity: { type: 'number' },
            discount: { type: 'number' }
          },
          required: ['name','unitPrice','taxRate','priceWithTax']
        }
      },
      customers: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            name: { type: 'string' },
            phone: { type: 'string' },
            totalPurchase: { type: 'number' }
          },
          required: ['name']
        }
      },
      invoices: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            serialNumber: { type: 'string' },
            customerName: { type: 'string' },
            date: { type: 'string' },
            items: {
              type: 'array',
              items: {
                type: 'object',
                properties: {
                  productName: { type: 'string' },
                  qty: { type: 'number' },
                  unitPrice: { type: 'number' },
                  taxRate: { type: 'number' }
                },
                required: ['productName','qty','unitPrice','taxRate']
              }
            },
            tax: { type: 'number' },
            totalAmount: { type: 'number' }
          },
          required: ['customerName','items']
        }
      }
    },
    required: ['products','customers','invoices']
  }

  let result
  let lastErr
  for (const m of candidates) {
    try {
      const b64 = Buffer.from(file.buffer).toString('base64')
      const json = await httpGenerateContent(m, [ { text: prompt }, { inlineData: { data: b64, mimeType } } ], { temperature: 0.2 }, debugLog)
      result = { response: { text: async () => (json.candidates?.[0]?.content?.parts?.[0]?.text || JSON.stringify(json)) } }
      if (debugLog) debugLog.push({ step: 'http-generate-used', model: m })
      break
    } catch (e) {
      lastErr = e
      const msg = String(e?.message || '')
      if (debugLog) debugLog.push({ step: 'http-generate-failed', model: m, error: msg })
      if (!/not found|404/i.test(msg)) {
        break
      }
    }
  }
  if (!result) {
    console.error('[Gemini generateContent failed]', lastErr)
    if (debugLog) debugLog.push({ step: 'gemini-failed', error: String(lastErr?.message||'') })
    return { products: [], customers: [], invoices: [] }
  }
  const text = await result.response.text()
  if (debugLog) debugLog.push({ step: 'gemini-response', length: text?.length || 0, preview: String(text).slice(0, 1000) })
  try {
    // Try direct JSON (preferred when responseMimeType=application/json)
    return JSON.parse(text)
  } catch {}
  try {
    // Fallback: strip markdown code fences if present
    const fence = /```(?:json)?\s*([\s\S]*?)```/i
    const m = text.match(fence)
    if (m && m[1]) return JSON.parse(m[1])
  } catch {}
  try {
    // Last resort: best-effort slice between first { and last }
    const jsonStart = text.indexOf('{')
    const jsonEnd = text.lastIndexOf('}') + 1
    if (jsonStart >= 0 && jsonEnd > jsonStart) {
      return JSON.parse(text.slice(jsonStart, jsonEnd))
    }
  } catch {}
  return { products: [], customers: [], invoices: [] }
}

async function extractWithGeminiFromCSV(csvText, originalname='sheet.csv', debugLog) {
  const prompt = `${systemSchema}\nThe following text is a CSV export of an invoice spreadsheet.\n- Infer headers (e.g., item/description, qty, rate/price, gst/cgst/sgst/igst, customer/party, invoice no, date, total).\n- Parse rows into products, customers, and invoices as per the schema.\nCSV Content (begin):\n\n${csvText}\n\nCSV Content (end).\nReturn only valid JSON conforming to the schema.`

  const candidates = Array.from(new Set([
    MODEL,
    'gemini-2.5-flash',
    'gemini-2.0-flash',
    'gemini-2.0-pro',
    'gemini-2.0-flash-lite',
    'gemini-1.5-pro',
    'gemini-1.5-pro-001',
    'gemini-1.5-pro-002',
    'gemini-1.5-flash',
    'gemini-1.5-flash-001',
    'gemini-1.5-flash-002',
    'gemini-1.5-pro-latest',
    'gemini-1.5-flash-latest',
    'gemini-1.5-flash-8b',
    'gemini-1.5-flash-8b-latest',
    'gemini-pro-vision',
    'gemini-1.0-pro-vision',
    'gemini-1.0-pro-vision-latest',
  ])).filter(Boolean)

  const responseSchema = {
    type: 'object',
    properties: {
      products: { type: 'array', items: { type: 'object', properties: {
        name: { type: 'string' }, unitPrice: { type: 'number' }, taxRate: { type: 'number' }, priceWithTax: { type: 'number' }, quantity: { type: 'number' }, discount: { type: 'number' }
      }, required: ['name','unitPrice','taxRate','priceWithTax'] } },
      customers: { type: 'array', items: { type: 'object', properties: {
        name: { type: 'string' }, phone: { type: 'string' }, totalPurchase: { type: 'number' }
      }, required: ['name'] } },
      invoices: { type: 'array', items: { type: 'object', properties: {
        serialNumber: { type: 'string' }, customerName: { type: 'string' }, date: { type: 'string' },
        items: { type: 'array', items: { type: 'object', properties: { productName: { type: 'string' }, qty: { type: 'number' }, unitPrice: { type: 'number' }, taxRate: { type: 'number' } }, required: ['productName','qty','unitPrice','taxRate'] } },
        tax: { type: 'number' }, totalAmount: { type: 'number' }
      }, required: ['customerName','items'] } }
    },
    required: ['products','customers','invoices']
  }

  let result
  let lastErr
  for (const m of candidates) {
    try {
      const json = await httpGenerateContent(m, [ { text: prompt } ], { temperature: 0.2 }, debugLog)
      result = { response: { text: async () => (json.candidates?.[0]?.content?.parts?.[0]?.text || JSON.stringify(json)) } }
      if (debugLog) debugLog.push({ step: 'http-csv-generate', model: m, chars: csvText.length })
      break
    } catch (e) {
      lastErr = e
      const msg = String(e?.message || '')
      if (debugLog) debugLog.push({ step: 'http-csv-error', model: m, error: msg })
      if (!/not found|404/i.test(msg)) break
    }
  }
  if (!result) {
    console.error('[Gemini generateContent from CSV failed]', lastErr)
    if (debugLog) debugLog.push({ step: 'gemini-csv-failed', error: String(lastErr?.message||'') })
    return { products: [], customers: [], invoices: [] }
  }
  const text = await result.response.text()
  if (debugLog) debugLog.push({ step: 'gemini-csv-response', length: text?.length || 0, preview: String(text).slice(0, 1000) })
  try { return JSON.parse(text) } catch {}
  try {
    const m = text.match(/```(?:json)?\s*([\s\S]*?)```/i)
    if (m && m[1]) return JSON.parse(m[1])
  } catch {}
  try {
    const s = text.indexOf('{'), e = text.lastIndexOf('}') + 1
    if (s >= 0 && e > s) return JSON.parse(text.slice(s, e))
  } catch {}
  return { products: [], customers: [], invoices: [] }
}

function normalize(raw) {
  const productIdByName = new Map()
  const customerIdByName = new Map()
  const products = []
  const customers = []

  const addProduct = (p) => {
    const key = (p.name||'').toLowerCase()
    if (!key) return null
    if (!productIdByName.has(key)) {
      const id = `prod_${products.length+1}`
      productIdByName.set(key, id)
      products.push({
        id,
        name: p.name || '',
        unitPrice: Number(p.unitPrice||0),
        taxRate: Number(p.taxRate||0),
        priceWithTax: Number(p.priceWithTax || (Number(p.unitPrice||0) * (1+Number(p.taxRate||0)))),
        quantity: p.quantity ? Number(p.quantity) : undefined,
        discount: p.discount ? Number(p.discount) : undefined,
      })
    }
    return productIdByName.get(key)
  }

  const addCustomer = (c) => {
    const key = (c.name||'').toLowerCase()
    if (!key) return null
    if (!customerIdByName.has(key)) {
      const id = `cust_${customers.length+1}`
      customerIdByName.set(key, id)
      customers.push({
        id,
        name: c.name || '',
        phone: c.phone || '',
        totalPurchase: Number(c.totalPurchase||0),
      })
    }
    return customerIdByName.get(key)
  }

  const invoices = []
  // Seed with provided customers and products to preserve fields like phone and tax
  for (const p of (raw.products||[])) addProduct(p)
  for (const c of (raw.customers||[])) addCustomer(c)
  for (const inv of raw.invoices || []) {
    const cid = addCustomer({ name: inv.customerName || '' })
    const items = (inv.items||[]).map(it => {
      const pid = it.productId || addProduct({ name: it.productName||'', unitPrice: it.unitPrice, taxRate: it.taxRate, quantity: it.qty })
      return { productId: pid, qty: Number(it.qty||0), unitPrice: Number(it.unitPrice||0), taxRate: Number(it.taxRate||0) }
    })
    const subtotal = items.reduce((s, it) => s + it.unitPrice * it.qty, 0)
    const tax = items.reduce((s, it) => s + it.unitPrice * it.qty * it.taxRate, 0)
    const total = Number(inv.totalAmount||0) || (subtotal + tax)
    invoices.push({
      id: `inv_${invoices.length+1}`,
      serialNumber: inv.serialNumber || '',
      customerId: cid || '',
      items,
      tax,
      totalAmount: total,
      date: inv.date || ''
    })
  }

  // Recompute customers totalPurchase
  const totalsByCustomer = new Map()
  for (const inv of invoices) {
    if (!inv.customerId) continue
    totalsByCustomer.set(inv.customerId, (totalsByCustomer.get(inv.customerId)||0) + inv.totalAmount)
  }
  for (const c of customers) {
    c.totalPurchase = totalsByCustomer.get(c.id) || c.totalPurchase || 0
  }

  return { products, customers, invoices }
}

// Remove clearly invalid product entries or address/meta lines that slipped through extraction
function cleanResults(raw, debugLog) {
  const badName = (name) => {
    const s = String(name||'')
    if (!s.trim()) return true
    // Address/meta keywords and boilerplate
    const rx = /(karnataka|telangana|assam|kerala|maharashtra|gujarat|tamil\s*nadu|west\s*bengal|delhi|goa|andhra|odisha|chennai|mumbai|kolkata|kochi|bangalore|hyderabad|other\s*territory|address|phone|email|gstin|ifsc|bank|branch|beneficiary|account|upi|terms|conditions|notes|authorized\s*signatory|place\s*of\s*supply|tax\s*invoice|invoice\s*date|invoice\s*#|amount\s*payable|total\s*amount|digitally\s*signed|page\s*\d+|recipient|consignee|ship\s*to|sold\s*to)/i
    if (rx.test(s)) return true
    // Too long with commas likely address blocks
    if (s.length > 60 && /,/.test(s)) return true
    // Ends with a comma and has no digits -> likely address line
    if (/,\s*$/.test(s) && !/\d/.test(s)) return true
    // All uppercase with commas often address headings
    if (s.length > 20 && s === s.toUpperCase() && /[A-Z],/.test(s)) return true
    // Business survey/test/noise keywords that creep in from sample datasets
    if (/(survey|analysis|quant|dealer|consumers?|sentimental|syntimental|fleetowners|real\s*estate|barcode|images?\s*\d+)/i.test(s)) return true
    // Very short gibberish tokens (e.g., "78doleo", "copy pr")
    if (/^[a-z]{2,}\s+[a-z]{2,}$/i.test(s) === true && s.length <= 10) return true
    return false
  }

  const filteredProducts = (raw.products||[]).filter(p => !badName(p.name))
  // Also filter invoice items by product name validity
  const filteredInvoices = (raw.invoices||[]).map(inv => ({
    ...inv,
    items: (inv.items||[])
      // drop obvious bad names
      .filter(it => !badName(it.productName))
      // drop items with no meaningful price/qty
      .filter(it => (Number(it.unitPrice||0) > 0) || (Number(it.qty||0) > 0))
  }))
  if (debugLog) {
    const removed = (raw.products?.length||0) - filteredProducts.length
    if (removed > 0) debugLog.push({ step: 'cleanup-products', removed })
  }
  return { products: filteredProducts, customers: (raw.customers||[]), invoices: filteredInvoices }
}

// Lightweight AI connectivity check used by /health?deep=1
export async function checkAIConnectivity() {
  if (!API_KEY) return { ok: false, error: 'NO_API_KEY' }
  const candidates = [ MODEL, 'gemini-2.5-flash', 'gemini-2.0-flash', 'gemini-1.5-flash', 'gemini-1.5-flash-8b', 'gemini-1.5-pro' ].filter(Boolean)
  let lastErr
  for (const m of candidates) {
    try {
      const json = await httpGenerateContent(m, [ { text: '{"ping":"ok"}' } ], { temperature: 0 }, undefined)
      if (json && json.candidates) {
        // If httpGenerateContent logged apiVersionUsed, we can't read it here directly.
        // Re-run a tiny call with debugLog to capture which version succeeded.
        const dbg = []
        await httpGenerateContent(m, [ { text: '{"ping":"ok2"}' } ], { temperature: 0 }, dbg)
        const ver = (dbg.find(s => s.step === 'http-generate-ok')||{}).apiVersionUsed
        return { ok: true, model: m, apiVersionVerified: ver }
      }
    } catch (e) {
      lastErr = e
    }
  }
  return { ok: false, error: String(lastErr?.message || 'UNKNOWN') }
}
