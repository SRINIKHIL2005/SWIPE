import { GoogleGenerativeAI } from '@google/generative-ai'
import xlsx from 'xlsx'
import fs from 'fs/promises'
import os from 'os'
import path from 'path'

const API_KEY = process.env.GOOGLE_API_KEY
const MODEL = process.env.GEMINI_MODEL || 'gemini-1.5-pro-latest'
const API_VERSION = process.env.GEMINI_API_VERSION || 'v1'
const BASE_URL = `https://generativelanguage.googleapis.com/${API_VERSION}`

let genAI = API_KEY ? new GoogleGenerativeAI(API_KEY) : null

function setApiVersion(version) {
  if (!API_KEY) return
  // SDK doesn't allow switching easily; our manual HTTP client below uses BASE_URL
}

async function httpGenerateContent(model, parts, generationConfig = {}, debugLog) {
  const url = `${BASE_URL}/models/${model}:generateContent?key=${encodeURIComponent(API_KEY||'')}`
  const body = { contents: [{ role: 'user', parts }], generationConfig }
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  })
  if (!res.ok) {
    const text = await res.text()
    const safeUrl = url.replace(/(key=)[^&]+/i, '$1****')
    if (debugLog) debugLog.push({ step: 'http-generate-error', status: res.status, url: safeUrl, responsePreview: text.slice(0, 400) })
    throw new Error(`HTTP ${res.status}: ${text}`)
  }
  const json = await res.json()
  if (debugLog) debugLog.push({ step: 'http-generate-ok', model })
  return json
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
    } else if (API_KEY) {
      if (debug) debugLog.push({ step: 'non-excel-file', note: 'Use Gemini', name: f.originalname })
      const fromAI = await extractWithGemini(f, debug ? debugLog : undefined)
      merge(merged, fromAI)
    } else {
      // Fallback minimal when no API key
      merge(merged, { products: [], customers: [], invoices: [] })
    }
  }
  // Normalize: map names to ids and compute totals
  const normalized = normalize(merged)
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

async function extractWithGemini(file, debugLog) {
  const mimeType = file.mimetype
  const prompt = `${systemSchema}\nAnalyze the attached file (it may be an invoice PDF/image or a spreadsheet).\n- If spreadsheet: detect header synonyms (item/description, qty, rate/price, gst/cgst/sgst/igst, customer/party, invoice no, date).\n- If PDF/image: OCR and read tables and key-value blocks.\n- Return arrays even if only one item is found.\nReturn only valid JSON as specified.`

  const candidates = Array.from(new Set([
    MODEL,
    // Current/recent IDs
    'gemini-1.5-pro',
    'gemini-1.5-pro-001',
    'gemini-1.5-pro-002',
    'gemini-1.5-flash',
    'gemini-1.5-flash-001',
    'gemini-1.5-flash-002',
    'gemini-1.5-pro-latest',
    'gemini-1.5-flash-latest',
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
    'gemini-1.5-pro',
    'gemini-1.5-pro-001',
    'gemini-1.5-pro-002',
    'gemini-1.5-flash',
    'gemini-1.5-flash-001',
    'gemini-1.5-flash-002',
    'gemini-1.5-pro-latest',
    'gemini-1.5-flash-latest',
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

// Lightweight AI connectivity check used by /health?deep=1
export async function checkAIConnectivity() {
  if (!API_KEY) return { ok: false, error: 'NO_API_KEY' }
  const candidates = [ MODEL, 'gemini-1.5-flash', 'gemini-1.5-pro' ].filter(Boolean)
  let lastErr
  for (const m of candidates) {
    try {
      const json = await httpGenerateContent(m, [ { text: '{"ping":"ok"}' } ], { temperature: 0 }, undefined)
      if (json && json.candidates) return { ok: true, model: m }
    } catch (e) {
      lastErr = e
    }
  }
  return { ok: false, error: String(lastErr?.message || 'UNKNOWN') }
}
