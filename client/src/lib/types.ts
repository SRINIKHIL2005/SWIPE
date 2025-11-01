export type ID = string

export type Product = {
  id: ID
  name: string
  unitPrice: number
  taxRate: number // e.g. 0.18 for 18%
  priceWithTax: number
  quantity?: number
  discount?: number
}

export type Customer = {
  id: ID
  name: string
  phone?: string
  totalPurchase: number
}

export type InvoiceItem = {
  productId: ID
  qty: number
  unitPrice: number
  taxRate: number
}

export type Invoice = {
  id: ID
  serialNumber: string
  customerId: ID
  items: InvoiceItem[]
  tax: number
  totalAmount: number
  date?: string
}

export type ExtractedPayload = {
  products: Omit<Product, 'id' | 'priceWithTax'> & { id?: ID } & { priceWithTax?: number } []
  customers: Omit<Customer, 'id' | 'totalPurchase'> & { id?: ID } & { totalPurchase?: number } []
  invoices: (Omit<Invoice, 'id' | 'items' | 'tax' | 'totalAmount'> & {
    id?: ID
    items: (Omit<InvoiceItem, 'productId'> & { productId?: ID | string, productName?: string })[]
    tax?: number
    totalAmount?: number
  })[]
}
