import express from 'express'
import cors from 'cors'
import multer from 'multer'
import path from 'path'
import { fileURLToPath } from 'url'
import { extractFromFiles, checkAIConnectivity } from './modules/extract.js'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)

const app = express()
app.use(cors())
app.use(express.json())

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 15 * 1024 * 1024 } })

app.get('/', (req, res) => {
  res.json({
    service: 'Swipe Invoice AI Backend',
    ok: true,
    routes: {
      health: '/health',
      extract: { method: 'POST', path: '/api/extract', formField: 'files' }
    }
  })
})

const AI_ENABLED = !!process.env.GOOGLE_API_KEY
const AI_MODEL = process.env.GEMINI_MODEL || 'gemini-1.5-pro-latest'
const AI_API_VERSION = process.env.GEMINI_API_VERSION || 'v1'

app.get('/health', async (req, res) => {
  const deep = String(req.query.deep||'').toLowerCase()
  let ai = { enabled: AI_ENABLED, model: AI_MODEL, apiVersion: AI_API_VERSION }
  if (AI_ENABLED && (deep==='1' || deep==='true')) {
    try {
      const r = await checkAIConnectivity()
      // Only expose minimal key shape to avoid leaking secrets
      const key = process.env.GOOGLE_API_KEY || ''
      const looksLikeAIStudio = key.startsWith('AIza')
      const keyShape = { present: !!key, looksLikeAIStudio, length: key.length }
      ai = { ...ai, valid: !!r.ok, error: r.ok ? undefined : r.error, modelVerified: r.model || undefined, keyShape }
    } catch (e) {
      ai = { ...ai, valid: false, error: String(e?.message||'UNKNOWN') }
    }
  }
  res.json({ ok: true, ai })
})

app.post('/api/extract', upload.array('files'), async (req, res) => {
  try {
    const files = req.files || []
    if (!files.length) return res.status(400).json({ error: 'No files uploaded' })
    const debug = String(req.query.debug || req.headers['x-debug'] || '').toLowerCase()
    const debugEnabled = debug === '1' || debug === 'true' || debug === 'yes'
    const result = await extractFromFiles(files, { debug: debugEnabled })
    res.json(result)
  } catch (e) {
    console.error(e)
    res.status(500).json({ error: e?.message || 'Extraction failed' })
  }
})

const PORT = process.env.PORT || 5050
app.listen(PORT, () => console.log(`Server running on http://localhost:${PORT}`))
