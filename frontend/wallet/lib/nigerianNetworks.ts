/**
 * Nigerian mobile prefixes, so the network is detected rather than asked for.
 * One copy, used by the airtime screen and by the assistant's top-ups.
 */
export const NETWORK_PREFIXES: Record<string, string[]> = {
  MTN: ['0803', '0806', '0703', '0706', '0813', '0816', '0810', '0814', '0903', '0906', '0913', '0916'],
  AIRTEL: ['0802', '0808', '0708', '0812', '0701', '0902', '0901', '0904', '0907', '0912'],
  GLO: ['0805', '0807', '0705', '0815', '0811', '0905', '0915'],
  '9MOBILE': ['0809', '0818', '0817', '0909', '0908'],
}

export const MOBILE_NETWORKS = Object.keys(NETWORK_PREFIXES)

/** The network a number belongs to by its first four digits, or null. */
export function detectNetwork(phone: string): string | null {
  const p = phone.replace(/\D/g, '')
  if (p.length < 4) return null
  const prefix = p.slice(0, 4)
  for (const [network, list] of Object.entries(NETWORK_PREFIXES)) {
    if (list.includes(prefix)) return network
  }
  return null
}
