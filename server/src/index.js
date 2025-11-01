import express from 'express'
import cors from 'cors'
import multer from 'multer'
import path from 'path'
import { fileURLToPath } from 'url'
import { extractFromFiles } from './modules/extract.js'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)

const app = express()
app.use(cors())
app.use(express.json())

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 15 * 1024 * 1024 } })

app.get('/health', (req, res) => {
  res.json({ ok: true })
})

app.post('/api/extract', upload.array('files'), async (req, res) => {
  try {
    const files = req.files || []
    if (!files.length) return res.status(400).json({ error: 'No files uploaded' })
    const result = await extractFromFiles(files)
    res.json(result)
  } catch (e) {
    console.error(e)
    res.status(500).json({ error: e?.message || 'Extraction failed' })
  }
})

const PORT = process.env.PORT || 5050
app.listen(PORT, () => console.log(`Server running on http://localhost:${PORT}`))
