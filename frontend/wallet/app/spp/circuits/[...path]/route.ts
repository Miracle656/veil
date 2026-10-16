import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { NextResponse } from 'next/server'

const CIRCUITS_ROOT = path.resolve(
  process.cwd(),
  'node_modules/stellar-private-payments/dist/circuits',
)

const CONTENT_TYPES: Record<string, string> = {
  '.bin': 'application/octet-stream',
  '.graph.bin': 'application/octet-stream',
  '.r1cs': 'application/octet-stream',
  '.txt': 'text/plain; charset=utf-8',
  '.gz': 'application/gzip',
}

function contentType(filePath: string): string {
  if (filePath.endsWith('.graph.bin')) return CONTENT_TYPES['.graph.bin']
  return CONTENT_TYPES[path.extname(filePath)] ?? 'application/octet-stream'
}

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ path: string[] }> },
) {
  const segments = (await params).path
  if (!segments?.length || segments.some((segment) => segment === '.' || segment === '..')) {
    return new NextResponse('Not found', { status: 404 })
  }

  const filePath = path.resolve(CIRCUITS_ROOT, ...segments)
  if (!filePath.startsWith(`${CIRCUITS_ROOT}${path.sep}`)) {
    return new NextResponse('Not found', { status: 404 })
  }

  try {
    const file = await readFile(filePath)
    return new NextResponse(file, {
      headers: {
        'Cache-Control': 'public, max-age=31536000, immutable',
        'Content-Type': contentType(filePath),
      },
    })
  } catch {
    return new NextResponse('Not found', { status: 404 })
  }
}