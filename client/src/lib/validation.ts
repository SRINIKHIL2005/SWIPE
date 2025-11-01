import type { Product, Customer, Invoice } from './types'

export function validateProduct(p: Product) {
  const missing: (keyof Product)[] = []
  if (!p.name) missing.push('name')
  if (!(p.unitPrice >= 0)) missing.push('unitPrice')
  if (!(p.taxRate >= 0)) missing.push('taxRate')
  return missing
}

export function validateCustomer(c: Customer) {
  const missing: (keyof Customer)[] = []
  if (!c.name) missing.push('name')
  return missing
}

export function validateInvoice(inv: Invoice) {
  const missing: (keyof Invoice)[] = []
  if (!inv.serialNumber) missing.push('serialNumber')
  if (!inv.customerId) missing.push('customerId')
  if (!inv.items?.length) missing.push('items')
  return missing
}
