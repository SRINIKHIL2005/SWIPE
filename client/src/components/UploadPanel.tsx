import { useEffect, useState } from 'react'
import axios from 'axios'
import { useDispatch } from 'react-redux'
import type { AppDispatch } from '@store'
import { upsertMany as upsertProducts } from '@store/slices/products'
import { upsertMany as upsertCustomers } from '@store/slices/customers'
import { upsertMany as upsertInvoices } from '@store/slices/invoices'

const API_BASE = import.meta.env.VITE_API_BASE || 'http://localhost:5050'

export default function UploadPanel() {
  const dispatch = useDispatch<AppDispatch>()
  const [status, setStatus] = useState<'idle'|'uploading'|'success'|'error'>('idle')
  const [message, setMessage] = useState<string>('')
  const [dragOver, setDragOver] = useState(false)
  const [apiStatus, setApiStatus] = useState<'unknown'|'online'|'offline'>('unknown')
  const [apiInfo, setApiInfo] = useState<string>('')
  const [debug, setDebug] = useState<boolean>(false)
  const [debugData, setDebugData] = useState<any>(null)

  useEffect(() => {
    let mounted = true
    async function ping() {
      try {
        const res = await axios.get(`${API_BASE}/health${debug ? '?deep=1' : ''}`, { timeout: 4000 })
        const ok = !!res.data?.ok
        if (!mounted) return
        setApiStatus(ok ? 'online' : 'offline')
        const enabled = res.data?.ai?.enabled ? 'on' : 'off'
        const model = res.data?.ai?.model || 'n/a'
        const apiVer = res.data?.ai?.apiVersion ? ` • ${res.data.ai.apiVersion}` : ''
        const valid = res.data?.ai?.valid
        const suffix = valid===false ? ' • key invalid' : ''
        setApiInfo(`AI ${enabled} • ${model}${apiVer}${suffix}`)
      } catch (_) {
        if (!mounted) return
        setApiStatus('offline')
        setApiInfo('unreachable')
      }
    }
    ping()
    const id = setInterval(ping, 20000)
    return () => { mounted = false; clearInterval(id) }
  }, [debug])

  async function onFiles(files: FileList | null) {
    if (!files || files.length === 0) return
    const form = new FormData()
    Array.from(files).forEach(f => form.append('files', f))
    setStatus('uploading')
    setMessage('Uploading and extracting…')
    try {
      const res = await axios.post(`${API_BASE}/api/extract${debug ? '?debug=1' : ''}`, form, {
        headers: { 'Content-Type': 'multipart/form-data', ...(debug ? {'x-debug':'1'}:{} ) }
      })
      const data = res.data
      setDebugData(data?._debug || null)
      const p = Array.isArray(data?.products) ? data.products : []
      const c = Array.isArray(data?.customers) ? data.customers : []
      const i = Array.isArray(data?.invoices) ? data.invoices : []
      if (p.length) dispatch(upsertProducts(p))
      if (c.length) dispatch(upsertCustomers(c))
      if (i.length) dispatch(upsertInvoices(i))
      const summary = `Extracted ${i.length} invoice(s), ${p.length} product(s), ${c.length} customer(s).`
      if (p.length + c.length + i.length === 0) {
        setStatus('error')
        setMessage(`No structured data extracted. Please check file clarity/format. ${summary}`)
      } else {
        setStatus('success')
        setMessage(summary)
      }
    } catch (e: any) {
      setStatus('error')
      setMessage(e?.response?.data?.error || e.message || 'Extraction failed')
    }
  }

  function handleDrop(e: React.DragEvent<HTMLDivElement>) {
    e.preventDefault()
    e.stopPropagation()
    setDragOver(false)
    const files = e.dataTransfer?.files || null
    onFiles(files)
  }

  return (
    <section className="panel" style={{marginBottom: 12}}>
      <div style={{display:'flex',justifyContent:'space-between',alignItems:'center',gap:12,flexWrap:'wrap'}}>
        <div
          className="upload"
          style={{flex:1, borderColor: dragOver ? '#22c55e' : undefined, background: dragOver ? '#0f1b39' : undefined}}
          onDragEnter={(e)=>{ e.preventDefault(); setDragOver(true) }}
          onDragOver={(e)=>{ e.preventDefault(); setDragOver(true) }}
          onDragLeave={(e)=>{ e.preventDefault(); setDragOver(false) }}
          onDrop={handleDrop}
          aria-label="Drop files here to upload"
        >
          <input id="file" type="file" multiple onChange={(e)=>onFiles(e.target.files)} style={{display:'none'}} />
          <label htmlFor="file" className="button secondary">Select Files</label>
          <span style={{marginLeft:10,color:'#cbd5e1'}}>
            {dragOver ? 'Drop to start upload' : 'Or drag & drop Excel, PDF, or images'}
          </span>
        </div>
        <div style={{display:'flex', gap:10, alignItems:'center'}}>
          <label style={{display:'flex',alignItems:'center',gap:6,color:'#cbd5e1'}}>
            <input type="checkbox" checked={debug} onChange={(e)=>setDebug(e.target.checked)} /> Debug
          </label>
          {apiStatus==='online' && <span className="badge success">API Online • {apiInfo}</span>}
          {apiStatus==='offline' && <span className="badge error">API Offline</span>}
          {apiStatus==='unknown' && <span className="badge">API Checking…</span>}
          {status==='uploading' && <span className="badge">⏳ {message}</span>}
          {status==='success' && <span className="badge success">✅ {message}</span>}
          {status==='error' && <span className="badge error">❌ {message}</span>}
        </div>
      </div>
      {debug && debugData && (
        <pre style={{marginTop:10, maxHeight:200, overflow:'auto', background:'#0b1224', padding:10, borderRadius:8, color:'#9fb7ff'}}>
          {JSON.stringify(debugData, null, 2)}
        </pre>
      )}
    </section>
  )
}
