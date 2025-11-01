import { useSelector } from 'react-redux'
import type { RootState } from '@store'
import { toPercent } from '@lib/utils'

export default function InvoicesTable() {
  const invoices = useSelector((s: RootState) => s.invoices)
  const customers = useSelector((s: RootState) => s.customers)
  const products = useSelector((s: RootState) => s.products)

  return (
    <div style={{overflowX:'auto'}}>
      <table className="table">
        <thead>
          <tr>
            <th>Serial Number</th>
            <th>Customer Name</th>
            <th>Product</th>
            <th>Qty</th>
            <th>Tax</th>
            <th>Total Amount</th>
            <th>Date</th>
          </tr>
        </thead>
        <tbody>
          {invoices.allIds.map(id => {
            const inv = invoices.byId[id]
            const cust = customers.byId[inv.customerId]
            return (
              <tr key={id}>
                <td>{inv.serialNumber || <span className="missing">missing</span>}</td>
                <td>{cust?.name || <span className="missing">missing</span>}</td>
                <td>
                  {inv.items.map((it, i) => {
                    const p = products.byId[it.productId]
                    return (
                      <div key={i}>
                        {p?.name || <span className="missing">missing</span>}
                      </div>
                    )
                  })}
                </td>
                <td>
                  {inv.items.map((it, i) => (
                    <div key={i}>{it.qty}</div>
                  ))}
                </td>
                <td>
                  {inv.items.map((it, i) => (
                    <div key={i}>{toPercent(it.taxRate)}</div>
                  ))}
                </td>
                <td>{inv.totalAmount.toFixed(2)}</td>
                <td>{inv.date || '-'}</td>
              </tr>
            )
          })}
        </tbody>
      </table>
    </div>
  )
}
