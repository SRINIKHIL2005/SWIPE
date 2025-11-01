import { createSlice, PayloadAction } from '@reduxjs/toolkit'
import type { Customer, ID } from '@lib/types'
import { genId } from '@lib/utils'

export type CustomersState = {
  byId: Record<ID, Customer>
  allIds: ID[]
}

const initialState: CustomersState = { byId: {}, allIds: [] }

const customersSlice = createSlice({
  name: 'customers',
  initialState,
  reducers: {
    upsertMany(state, action: PayloadAction<Partial<Customer>[]>) {
      for (const input of action.payload) {
        const id = (input as any).id || genId('cust')
        const existing = state.byId[id]
        const c: Customer = {
          id,
          name: input.name ?? existing?.name ?? '',
          phone: input.phone ?? existing?.phone,
          totalPurchase: input.totalPurchase ?? existing?.totalPurchase ?? 0,
        }
        state.byId[id] = c
        if (!existing) state.allIds.push(id)
      }
    },
    update(state, action: PayloadAction<{ id: ID, patch: Partial<Customer> }>) {
      const { id, patch } = action.payload
      const existing = state.byId[id]
      if (!existing) return
      state.byId[id] = { ...existing, ...patch }
    }
  }
})

export const { upsertMany, update } = customersSlice.actions
export default customersSlice.reducer
