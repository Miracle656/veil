'use client'

import { useEffect, useState } from 'react'
import { resolveReverseName } from '@/lib/reverseResolution'

export function useReverseName(address: string): {
  name: string | null
  loading: boolean
} {
  const [name, setName] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)

  useEffect(() => {
    const trimmed = (address || '').trim()
    if (!trimmed) {
      setName(null)
      setLoading(false)
      return
    }

    let active = true
    setLoading(true)

    resolveReverseName(trimmed)
      .then((res) => {
        if (active) {
          setName(res)
          setLoading(false)
        }
      })
      .catch(() => {
        if (active) {
          setName(null)
          setLoading(false)
        }
      })

    return () => {
      active = false
    }
  }, [address])

  return { name, loading }
}
