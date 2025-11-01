import { useDispatch, useSelector } from 'react-redux'
import type { RootState } from '@store'
import { update } from '@store/slices/customers'
import type { AppDispatch } from '@store'

export default function CustomersTable() {
  const customers = useSelector((s: RootState) => s.customers)
  const dispatch = useDispatch<AppDispatch>()

  return (
    <div style={{overflowX:'auto'}}>
      <table className="table">
        <thead>
          <tr>
            <th>Customer Name</th>
            <th>Phone Number</th>
            <th>Total Purchase Amount</th>
          </tr>
        </thead>
        <tbody>
          {customers.allIds.map(id => {
            const c = customers.byId[id]
            return (
              <tr key={id}>
                <td>
                  <input className="input" value={c.name} onChange={(e)=>dispatch(update({id, patch:{name:e.target.value}}))} />
                </td>
                <td>
                  <input className="input" value={c.phone ?? ''} onChange={(e)=>dispatch(update({id, patch:{phone:e.target.value}}))} />
                </td>
                <td>{c.totalPurchase.toFixed(2)}</td>
              </tr>
            )
          })}
        </tbody>
      </table>
    </div>
  )
}
