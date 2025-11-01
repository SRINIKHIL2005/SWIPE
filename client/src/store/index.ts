import { configureStore } from '@reduxjs/toolkit'
import invoicesReducer from './slices/invoices'
import productsReducer from './slices/products'
import customersReducer from './slices/customers'

export const store = configureStore({
  reducer: {
    invoices: invoicesReducer,
    products: productsReducer,
    customers: customersReducer,
  }
})

export type RootState = ReturnType<typeof store.getState>
export type AppDispatch = typeof store.dispatch
