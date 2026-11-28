import { NextResponse, type NextRequest } from 'next/server'
import { assertNoNin, type CreateRecurringTopupInput } from '@veil/agent-recurring'
import { getRecurringTopupRunner } from '@/lib/recurringTopupServer'

export const runtime = 'nodejs'

export async function GET(req: NextRequest) {
  const walletAddress = req.nextUrl.searchParams.get('walletAddress')?.trim() ?? ''
  if (!walletAddress) {
    return NextResponse.json({ error: 'walletAddress query parameter is required.' }, { status: 400 })
  }
  const plans = await getRecurringTopupRunner().listPlans(walletAddress)
  return NextResponse.json({ plans })
}

export async function POST(req: NextRequest) {
  let body: unknown
  try {
    body = await req.json()
  } catch {
    return NextResponse.json({ error: 'Expected a JSON body.' }, { status: 400 })
  }

  try {
    assertNoNin(body)
    const plan = await getRecurringTopupRunner().createPlan(body as CreateRecurringTopupInput)
    return NextResponse.json({ plan }, { status: 201 })
  } catch (err) {
    return NextResponse.json({ error: (err as Error).message }, { status: 400 })
  }
}
