import { useState } from 'react'
import UploadPanel from '@components/UploadPanel'
import InvoicesTable from '@components/InvoicesTable'
import ProductsTable from '@components/ProductsTable'
import CustomersTable from '@components/CustomersTable'

const tabs = ['Invoices', 'Products', 'Customers'] as const

type TabKey = typeof tabs[number]

export default function App() {
  const [active, setActive] = useState<TabKey>('Invoices')
  return (
    <div className="container">
      <header className="header">
        <div className="brand">
          <div className="logo"/>
          <h1>Swipe Invoice AI</h1>
        </div>
        <div className="controls">
          <span className="badge">Assignment • Automated Data Extraction</span>
        </div>
      </header>

      <UploadPanel />

      <div style={{margin: '16px 0'}} className="tabs">
        {tabs.map(t => (
          <div key={t}
            className={`tab ${active === t ? 'active' : ''}`}
            onClick={() => setActive(t)}
          >{t}</div>
        ))}
      </div>

      <section className="panel">
        {active === 'Invoices' && <InvoicesTable />}
        {active === 'Products' && <ProductsTable />}
        {active === 'Customers' && <CustomersTable />}
      </section>
    </div>
  )
}
