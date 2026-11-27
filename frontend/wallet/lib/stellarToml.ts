export async function fetchStellarToml(domainOrIssuer: string): Promise<string> {
  const params = new URLSearchParams({ domain: domainOrIssuer })
  const response = await fetch(`/api/stellar-toml?${params.toString()}`)
  if (!response.ok) {
    throw new Error(`Failed to fetch stellar.toml: ${response.status}`)
  }
  return response.text()
}

export async function fetchIssuerStellarToml(issuer: string): Promise<string> {
  return fetchStellarToml(issuer)
}
