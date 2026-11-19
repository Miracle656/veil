import { NextResponse, type NextRequest } from 'next/server'
import { getRecurringTopupRunner } from '@/lib/recurringTopupServer'

export const runtime = 'nodejs'

export async function GET(req: NextRequest) {
  const walletAddress = req.nextUrl.searchParams.get('walletAddress')?.trim() ?? ''
  if (!walletAddress) {
    return NextResponse.json({ error: 'walletAddress query parameter is required.' }, { status: 400 })
  }
  const activity = await getRecurringTopupRunner().getActivityForWallet(walletAddress)
  return NextResponse.json({ activity })
}
