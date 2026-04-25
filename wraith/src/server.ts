import express from 'express'
import cors from 'cors'
import { transfersRouter } from './routes/transfers.js'

const app = express()
const PORT = process.env.PORT || 3000

app.use(cors())
app.use(express.json())

// Routes
app.use('/transfers', transfersRouter)

// Health check
app.get('/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() })
})

app.listen(PORT, () => {
  console.log(`Wraith indexer running on port ${PORT}`)
})