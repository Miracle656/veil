import type { Metadata } from 'next'

export const metadata: Metadata = {
  title: 'Bulk payout · Veil',
  description:
    'Pay many recipients in one signed batch. Paste, upload, validate, sign once.',
}

export default function Layout({ children }: { children: React.ReactNode }) {
  return <div className="min-h-[100dvh] bg-night text-off-white">{children}</div>
}
