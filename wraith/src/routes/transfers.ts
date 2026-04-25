import express, { Request, Response } from 'express'
import { Server } from '@stellar/stellar-sdk'

const router = express.Router()

// Mock data for demonstration - in real implementation this would query a database
const mockTransfers = [
  {
    id: 1,
    eventType: 'transfer',
    fromAddress: 'GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5',
    toAddress: 'CBE6HF6L3G4X7Z5Y2A3B4C5D6E7F8G9H0I1J2K3L4M5N6O7P8Q9R0S1T2',
    amount: '10000000', // 1 XLM in stroops
    ledger: 12345,
    ledgerClosedAt: '2024-01-15T10:30:00Z',
    txHash: 'abc123def456',
    contractId: 'CBE6HF6L3G4X7Z5Y2A3B4C5D6E7F8G9H0I1J2K3L4M5N6O7P8Q9R0S1T2'
  },
  {
    id: 2,
    eventType: 'transfer',
    fromAddress: 'CBE6HF6L3G4X7Z5Y2A3B4C5D6E7F8G9H0I1J2K3L4M5N6O7P8Q9R0S1T2',
    toAddress: 'GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5',
    amount: '5000000', // 0.5 XLM in stroops
    ledger: 12346,
    ledgerClosedAt: '2024-01-15T11:00:00Z',
    txHash: 'def456ghi789',
    contractId: 'CBE6HF6L3G4X7Z5Y2A3B4C5D6E7F8G9H0I1J2K3L4M5N6O7P8Q9R0S1T2'
  }
]

// GET /transfers/address/:address - JSON endpoint
router.get('/address/:address', async (req: Request, res: Response) => {
  try {
    const { address } = req.params
    const { direction = 'both', limit = '20', cursor, fromDate, toDate, eventType } = req.query

    // In real implementation, this would query the database with filters
    let filteredTransfers = mockTransfers

    // Apply direction filter
    if (direction === 'incoming') {
      filteredTransfers = filteredTransfers.filter(t => t.toAddress === address)
    } else if (direction === 'outgoing') {
      filteredTransfers = filteredTransfers.filter(t => t.fromAddress === address)
    }

    // Apply date filters
    if (fromDate) {
      const from = new Date(fromDate as string)
      filteredTransfers = filteredTransfers.filter(t => new Date(t.ledgerClosedAt) >= from)
    }
    if (toDate) {
      const to = new Date(toDate as string)
      filteredTransfers = filteredTransfers.filter(t => new Date(t.ledgerClosedAt) <= to)
    }

    // Apply event type filter
    if (eventType) {
      filteredTransfers = filteredTransfers.filter(t => t.eventType === eventType)
    }

    // Apply limit
    const limitNum = Math.min(parseInt(limit as string) || 20, 10000)
    filteredTransfers = filteredTransfers.slice(0, limitNum)

    res.json({
      transfers: filteredTransfers,
      next_cursor: filteredTransfers.length === limitNum ? 'next_page_cursor' : null
    })
  } catch (error) {
    console.error('Error fetching transfers:', error)
    res.status(500).json({ error: 'Internal server error' })
  }
})

// GET /transfers/incoming/:address - Convenience endpoint for incoming transfers
router.get('/incoming/:address', async (req: Request, res: Response) => {
  req.query.direction = 'incoming'
  return router.handle(req, res, () => {})
})

// GET /transfers/outgoing/:address - Convenience endpoint for outgoing transfers
router.get('/outgoing/:address', async (req: Request, res: Response) => {
  req.query.direction = 'outgoing'
  return router.handle(req, res, () => {})
})

// GET /transfers/address/:address/export.csv - CSV export endpoint
router.get('/address/:address/export.csv', async (req: Request, res: Response) => {
  try {
    const { address } = req.params
    const { direction = 'both', fromDate, toDate, eventType } = req.query

    // In real implementation, this would query the database with filters
    let filteredTransfers = mockTransfers

    // Apply direction filter
    if (direction === 'incoming') {
      filteredTransfers = filteredTransfers.filter(t => t.toAddress === address)
    } else if (direction === 'outgoing') {
      filteredTransfers = filteredTransfers.filter(t => t.fromAddress === address)
    }

    // Apply date filters
    if (fromDate) {
      const from = new Date(fromDate as string)
      filteredTransfers = filteredTransfers.filter(t => new Date(t.ledgerClosedAt) >= from)
    }
    if (toDate) {
      const to = new Date(toDate as string)
      filteredTransfers = filteredTransfers.filter(t => new Date(t.ledgerClosedAt) <= to)
    }

    // Apply event type filter
    if (eventType) {
      filteredTransfers = filteredTransfers.filter(t => t.eventType === eventType)
    }

    // Cap at 10,000 rows
    filteredTransfers = filteredTransfers.slice(0, 10000)

    // Set CSV headers
    res.setHeader('Content-Type', 'text/csv')
    res.setHeader('Content-Disposition', `attachment; filename="transfers-${address.slice(0, 8)}.csv"`)

    // CSV header
    res.write('date,type,from,to,amount,token,ledger\n')

    // CSV rows
    for (const transfer of filteredTransfers) {
      const date = new Date(transfer.ledgerClosedAt).toISOString().split('T')[0]
      const type = transfer.fromAddress === address ? 'sent' : 'received'
      const from = transfer.fromAddress || ''
      const to = transfer.toAddress || ''
      const amount = (Math.abs(Number(transfer.amount)) / 10_000_000).toFixed(7) // Convert from stroops to XLM
      const token = 'XLM'
      const ledger = transfer.ledger.toString()

      // Escape CSV fields that might contain commas
      const escapedFrom = from.includes(',') ? `"${from}"` : from
      const escapedTo = to.includes(',') ? `"${to}"` : to

      res.write(`${date},${type},${escapedFrom},${escapedTo},${amount},${token},${ledger}\n`)
    }

    res.end()
  } catch (error) {
    console.error('Error exporting transfers:', error)
    res.status(500).json({ error: 'Internal server error' })
  }
})

export { router as transfersRouter }