import { GoogleGenerativeAI } from '@google/generative-ai'
import { GoogleAIFileManager } from '@google/generative-ai/server'
import xlsx from 'xlsx'

const API_KEY = process.env.GOOGLE_API_KEY
const MODEL = process.env.GEMINI_MODEL || 'gemini-1.5-pro'

const genAI = API_KEY ? new GoogleGenerativeAI(API_KEY) : null
const fileMgr = API_KEY ? new GoogleAIFileManager(API_KEY) : null

const systemSchema = `
Return strictly this JSON structure with keys products, customers, invoices.
- products: array of { name, unitPrice (number), taxRate (0-1 number), priceWithTax (number), quantity (number, if known), discount (number, optional) }
- customers: array of { name, phone (string, optional), totalPurchase (number if computable, else 0) }
- invoices: array of { serialNumber, customerName, date (YYYY-MM-DD or original), items: [ { productName, qty (number), unitPrice (number), taxRate (0-1) } ], tax (number, total tax), totalAmount (number) }
If a value is missing, leave it empty string or 0. Do not invent data.
`

export async function extractFromFiles(files) {
  const merged = { products: [], customers: [], invoices: [] }
  for (const f of files) {
    const ext = (f.originalname.split('.').pop() || '').toLowerCase()
    if (['xls','xlsx','csv'].includes(ext)) {
      const fromX = await extractFromExcelBuffer(f.buffer)
      merge(merged, fromX)
    } else if (API_KEY) {
      const fromAI = await extractWithGemini(f)
      merge(merged, fromAI)
    } else {
      // Fallback minimal when no API key
      merge(merged, { products: [], customers: [], invoices: [] })
    }
  }
  // Normalize: map names to ids and compute totals
  return normalize(merged)
}

function merge(target, src) {
  target.products.push(...(src.products||[]))
  target.customers.push(...(src.customers||[]))
  target.invoices.push(...(src.invoices||[]))
}

async function extractFromExcelBuffer(buf) {
  const wb = xlsx.read(buf, { type: 'buffer' })
  // Heuristic: take first sheet
  const sheet = wb.Sheets[wb.SheetNames[0]]
  const rows = xlsx.utils.sheet_to_json(sheet, { defval: '' })

  // Map likely columns by fuzzy names
  const header = Object.keys(rows[0] || {})
  const pick = (keys) => header.find(h => keys.some(k => h.toLowerCase().includes(k)))
  const serialKey = pick(['serial','invoice'])
  const custKey = pick(['customer','name'])
  const phoneKey = pick(['phone','mobile'])
  const productKey = pick(['product','item'])
  const qtyKey = pick(['qty','quantity'])
  const priceKey = pick(['unit','price','rate'])
  const taxKey = pick(['tax','gst'])
  const totalKey = pick(['total','amount'])
  const dateKey = pick(['date'])

  const products = []
  const customers = []
  const invoices = []

  for (const r of rows) {
    const name = String(r[productKey] || '').trim()
    const unitPrice = Number(r[priceKey] || 0)
    const qty = Number(r[qtyKey] || 0)
    const taxRate = Number(r[taxKey] || 0)
    const priceWithTax = unitPrice * (1 + taxRate)
    if (name) products.push({ name, unitPrice, taxRate, priceWithTax, quantity: qty })

    const cust = String(r[custKey] || '').trim()
    const phone = String(r[phoneKey] || '').trim()
    const totalPurchase = Number(r[totalKey] || 0)
    if (cust) customers.push({ name: cust, phone, totalPurchase })

    invoices.push({
      serialNumber: String(r[serialKey] || '').trim(),
      customerName: cust,
      date: String(r[dateKey] || '').trim(),
      items: [{ productName: name, qty, unitPrice, taxRate }],
      tax: unitPrice * qty * taxRate,
      totalAmount: Number(r[totalKey] || (unitPrice * qty * (1 + taxRate)))
    })
  }
  return { products, customers, invoices }
}

async function extractWithGemini(file) {
  const mimeType = file.mimetype
  const upload = await fileMgr.uploadFile({
    file: file.buffer,
    displayName: file.originalname,
    mimeType
  })
  const model = genAI.getGenerativeModel({ model: MODEL })
  const prompt = `${systemSchema}\nAnalyze the attached file and extract fields.`
  const result = await model.generateContent([
    { text: prompt },
    { fileData: { fileUri: upload.file.uri, mimeType } }
  ])
  const text = await result.response.text()
  try {
    const jsonStart = text.indexOf('{')
    const jsonEnd = text.lastIndexOf('}') + 1
    const json = JSON.parse(text.slice(jsonStart, jsonEnd))
    return json
  } catch(e) {
    return { products: [], customers: [], invoices: [] }
  }
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
