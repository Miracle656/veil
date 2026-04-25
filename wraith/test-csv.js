// Simple test for CSV export functionality
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

function generateCSV(transfers: typeof mockTransfers, address: string): string {
  let csv = 'date,type,from,to,amount,token,ledger\n'

  for (const transfer of transfers) {
    const date = new Date(transfer.ledgerClosedAt).toISOString().split('T')[0]
    const type = transfer.fromAddress === address ? 'sent' : 'received'
    const from = transfer.fromAddress || ''
    const to = transfer.toAddress || ''
    const amount = (Math.abs(Number(transfer.amount)) / 10_000_000).toFixed(7)
    const token = 'XLM'
    const ledger = transfer.ledger.toString()

    const escapedFrom = from.includes(',') ? `"${from}"` : from
    const escapedTo = to.includes(',') ? `"${to}"` : to

    csv += `${date},${type},${escapedFrom},${escapedTo},${amount},${token},${ledger}\n`
  }

  return csv
}

// Test the CSV generation
const address = 'CBE6HF6L3G4X7Z5Y2A3B4C5D6E7F8G9H0I1J2K3L4M5N6O7P8Q9R0S1T2'
const csv = generateCSV(mockTransfers, address)
console.log('Generated CSV:')
console.log(csv)

console.log('\nCSV Validation:')
console.log('- Has header row:', csv.startsWith('date,type,from,to,amount,token,ledger'))
console.log('- Has 3 total rows (header + 2 data):', csv.split('\n').length === 4)
console.log('- Contains expected data:', csv.includes('2024-01-15') && csv.includes('sent') && csv.includes('received'))