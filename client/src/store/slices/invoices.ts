import { createSlice, PayloadAction } from '@reduxjs/toolkit'
import type { Invoice, ID, InvoiceItem } from '@lib/types'
import { genId, safeNumber } from '@lib/utils'

export type InvoicesState = {
  byId: Record<ID, Invoice>
  allIds: ID[]
}

const initialState: InvoicesState = { byId: {}, allIds: [] }

function compute(inv: Omit<Invoice, 'totalAmount' | 'tax'> & Partial<Pick<Invoice, 'totalAmount' | 'tax'>>): Invoice {
  const subtotal = inv.items.reduce((s, it) => s + (safeNumber(it.unitPrice) * safeNumber(it.qty)), 0)
  const tax = inv.items.reduce((s, it) => s + (safeNumber(it.unitPrice) * safeNumber(it.qty) * safeNumber(it.taxRate)), 0)
  const total = subtotal + tax
  return {
    ...inv,
    tax: safeNumber(inv.tax ?? tax),
    totalAmount: safeNumber(inv.totalAmount ?? total),
  } as Invoice
}

const invoicesSlice = createSlice({
  name: 'invoices',
  initialState,
  reducers: {
    upsertMany(state, action: PayloadAction<Partial<Invoice>[]>) {
      for (const input of action.payload) {
        const id = (input as any).id || genId('inv')
        const existing = state.byId[id]
        const base: Invoice = compute({
          id,
          serialNumber: input.serialNumber ?? existing?.serialNumber ?? '',
          customerId: (input as any).customerId ?? existing?.customerId ?? '',
          items: (input.items ?? existing?.items ?? []) as InvoiceItem[],
          date: input.date ?? existing?.date,
          totalAmount: input.totalAmount ?? existing?.totalAmount,
          tax: input.tax ?? existing?.tax,
        })
        state.byId[id] = base
        if (!existing) state.allIds.push(id)
      }
    },
    update(state, action: PayloadAction<{ id: ID, patch: Partial<Invoice> }>) {
      const { id, patch } = action.payload
      const existing = state.byId[id]
      if (!existing) return
      state.byId[id] = compute({ ...existing, ...patch })
    },
    linkCustomer(state, action: PayloadAction<{ id: ID, customerId: ID }>) {
      const { id, customerId } = action.payload
      const inv = state.byId[id]
      if (!inv) return
      inv.customerId = customerId
    }
  }
})

export const { upsertMany, update, linkCustomer } = invoicesSlice.actions
export default invoicesSlice.reducer
