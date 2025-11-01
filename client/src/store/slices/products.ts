import { createSlice, PayloadAction } from '@reduxjs/toolkit'
import type { Product, ID } from '@lib/types'
import { genId } from '@lib/utils'

export type ProductsState = {
  byId: Record<ID, Product>
  allIds: ID[]
}

const initialState: ProductsState = { byId: {}, allIds: [] }

const productsSlice = createSlice({
  name: 'products',
  initialState,
  reducers: {
    upsertMany(state, action: PayloadAction<Partial<Product>[]>) {
      for (const input of action.payload) {
        const id = (input as any).id || genId('prod')
        const existing = state.byId[id]
        const product: Product = {
          id,
          name: input.name ?? existing?.name ?? '',
          unitPrice: input.unitPrice ?? existing?.unitPrice ?? 0,
          taxRate: input.taxRate ?? existing?.taxRate ?? 0,
          priceWithTax: input.priceWithTax ?? existing?.priceWithTax ?? ((input.unitPrice ?? existing?.unitPrice ?? 0) * (1 + (input.taxRate ?? existing?.taxRate ?? 0))),
          quantity: input.quantity ?? existing?.quantity,
          discount: input.discount ?? existing?.discount,
        }
        state.byId[id] = product
        if (!existing) state.allIds.push(id)
      }
    },
    update(state, action: PayloadAction<{ id: ID, patch: Partial<Product> }>) {
      const { id, patch } = action.payload
      const existing = state.byId[id]
      if (!existing) return
      state.byId[id] = { ...existing, ...patch, priceWithTax: (patch.unitPrice ?? existing.unitPrice) * (1 + (patch.taxRate ?? existing.taxRate)) }
    }
  }
})

export const { upsertMany, update } = productsSlice.actions
export default productsSlice.reducer
