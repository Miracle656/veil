import { NextResponse, type NextRequest } from 'next/server'
import { getRecurringTopupRunner } from '@/lib/recurringTopupServer'

export const runtime = 'nodejs'

export async function POST(req: NextRequest) {
  const expectedToken = process.env.RECURRING_CRON_TOKEN?.trim()
  if (expectedToken) {
    const provided = req.headers.get('authorization')?.replace(/^Bearer\s+/i, '').trim() ?? ''
    if (provided !== expectedToken) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 403 })
    }
  }

  const outcomes = await getRecurringTopupRunner().runDuePlans()
  return NextResponse.json({ outcomes })
}
