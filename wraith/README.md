# Wraith

Stellar Soroban contract event indexer for transfer history.

## Endpoints

### GET /transfers/address/:address

Returns transfer history for an address in JSON format.

**Query Parameters:**

- `direction`: `incoming`, `outgoing`, or `both` (default: `both`)
- `limit`: Maximum number of results (default: 20, max: 100)
- `cursor`: Pagination cursor
- `fromDate`: Filter transfers from this date (ISO format)
- `toDate`: Filter transfers to this date (ISO format)
- `eventType`: Filter by event type

**Response:**

```json
{
  "transfers": [...],
  "next_cursor": "cursor_string_or_null"
}
```

### GET /transfers/address/:address/export.csv

Returns transfer history as a downloadable CSV file.

**Query Parameters:** Same as JSON endpoint (direction, fromDate, toDate, eventType)

**Response:** CSV file with headers: `date,type,from,to,amount,token,ledger`

**Notes:**

- Maximum 10,000 rows returned
- Content-Type: `text/csv`
- Content-Disposition: `attachment; filename="transfers-{address}.csv"`

### Convenience Endpoints

- `GET /transfers/incoming/:address` - Incoming transfers only
- `GET /transfers/outgoing/:address` - Outgoing transfers only

## Development

```bash
npm install
npm run dev
```

## Production

```bash
npm run build
npm start
```
