import { NextRequest, NextResponse } from 'next/server'
import {
  globalNamesRegistry,
  InvalidNameError,
  ReservedNameError,
  NameAlreadyTakenError,
  UnpaidClaimError,
  PasskeyAlreadyClaimedError,
  InvalidSignatureError,
} from '@/lib/namesRegistry'

export async function POST(req: NextRequest) {
  try {
    const body = await req.json().catch(() => null)
    if (!body || typeof body !== 'object') {
      return NextResponse.json(
        { error: 'Invalid JSON request body.' },
        { status: 400, headers: corsHeaders() },
      )
    }

    const { name, walletAddress, passkeyPublicKey, paymentTxHash, signature } = body

    if (!name || !walletAddress || !passkeyPublicKey) {
      return NextResponse.json(
        {
          error:
            'Missing required fields. "name", "walletAddress", and "passkeyPublicKey" are required.',
        },
        { status: 400, headers: corsHeaders() },
      )
    }

    const record = await globalNamesRegistry.claimName({
      name,
      walletAddress,
      passkeyPublicKey,
      paymentTxHash,
      signature,
    })

    return NextResponse.json(
      {
        success: true,
        record: {
          name: record.name,
          stellar_address: `${record.name}*useveilapp.xyz`,
          tokenId: record.tokenId,
          walletAddress: record.walletAddress,
          passkeyPublicKey: record.passkeyPublicKey,
          claimedAt: record.claimedAt,
        },
      },
      {
        status: 201,
        headers: {
          ...corsHeaders(),
          'Cache-Control': 'no-store',
        },
      },
    )
  } catch (err: unknown) {
    if (err instanceof InvalidNameError) {
      return NextResponse.json(
        { error: err.message, code: 'INVALID_NAME' },
        { status: 400, headers: corsHeaders() },
      )
    }
    if (err instanceof PasskeyAlreadyClaimedError) {
      return NextResponse.json(
        { error: err.message, code: 'PASSKEY_ALREADY_CLAIMED' },
        { status: 400, headers: corsHeaders() },
      )
    }
    if (err instanceof InvalidSignatureError) {
      return NextResponse.json(
        { error: err.message, code: 'INVALID_SIGNATURE' },
        { status: 400, headers: corsHeaders() },
      )
    }
    if (err instanceof UnpaidClaimError) {
      return NextResponse.json(
        { error: err.message, code: 'UNPAID_CLAIM' },
        { status: 402, headers: corsHeaders() },
      )
    }
    if (err instanceof ReservedNameError) {
      return NextResponse.json(
        { error: err.message, code: 'RESERVED_NAME' },
        { status: 403, headers: corsHeaders() },
      )
    }
    if (err instanceof NameAlreadyTakenError) {
      return NextResponse.json(
        { error: err.message, code: 'NAME_ALREADY_TAKEN' },
        { status: 409, headers: corsHeaders() },
      )
    }

    const message = err instanceof Error ? err.message : 'Internal server error'
    return NextResponse.json(
      { error: message, code: 'SERVER_ERROR' },
      { status: 500, headers: corsHeaders() },
    )
  }
}

export async function OPTIONS() {
  return new NextResponse(null, {
    status: 204,
    headers: corsHeaders(),
  })
}

function corsHeaders(): Record<string, string> {
  return {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
  }
}
