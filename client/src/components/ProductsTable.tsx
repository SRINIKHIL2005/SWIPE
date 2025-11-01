import { useDispatch, useSelector } from 'react-redux'
import type { RootState } from '@store'
import { update } from '@store/slices/products'
import type { AppDispatch } from '@store'
import { toPercent } from '@lib/utils'

export default function ProductsTable() {
  const products = useSelector((s: RootState) => s.products)
  const dispatch = useDispatch<AppDispatch>()

  return (
    <div style={{overflowX:'auto'}}>
      <table className="table">
        <thead>
          <tr>
            <th>Name</th>
            <th>Quantity</th>
            <th>Unit Price</th>
            <th>Tax</th>
            <th>Price with Tax</th>
          </tr>
        </thead>
        <tbody>
          {products.allIds.map(id => {
            const p = products.byId[id]
            return (
              <tr key={id}>
                <td>
                  <input className="input" value={p.name} onChange={(e)=>dispatch(update({id, patch:{name:e.target.value}}))} />
                </td>
                <td>
                  <input className="input" type="number" value={p.quantity ?? 0} onChange={(e)=>dispatch(update({id, patch:{quantity:Number(e.target.value)}}))} />
                </td>
                <td>
                  <input className="input" type="number" step="0.01" value={p.unitPrice} onChange={(e)=>dispatch(update({id, patch:{unitPrice:Number(e.target.value)}}))} />
                </td>
                <td>
                  <input className="input" type="number" step="0.01" value={p.taxRate} onChange={(e)=>dispatch(update({id, patch:{taxRate:Number(e.target.value)}}))} />
                  <div style={{color:'#94a3b8', fontSize:12}}>{toPercent(p.taxRate)}</div>
                </td>
                <td>{p.priceWithTax.toFixed(2)}</td>
              </tr>
            )
          })}
        </tbody>
      </table>
    </div>
  )
}
