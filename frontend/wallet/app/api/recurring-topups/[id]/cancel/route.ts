import { NextResponse, type NextRequest } from 'next/server'
import { getRecurringTopupRunner } from '@/lib/recurringTopupServer'

export const runtime = 'nodejs'

export async function POST(
  req: NextRequest,
  context: { params: Promise<{ id: string }> },
) {
  let body: Record<string, unknown>
  try {
    body = (await req.json()) as Record<string, unknown>
  } catch {
    return NextResponse.json({ error: 'Expected a JSON body.' }, { status: 400 })
  }

  const walletAddress = typeof body.walletAddress === 'string' ? body.walletAddress.trim() : ''
  if (!walletAddress) {
    return NextResponse.json({ error: 'walletAddress is required to cancel a plan.' }, { status: 400 })
  }

  const { id } = await context.params
  try {
    const plan = await getRecurringTopupRunner().cancelPlan(walletAddress, id)
    return NextResponse.json({ plan })
  } catch (err) {
    return NextResponse.json({ error: (err as Error).message }, { status: 404 })
  }
}
