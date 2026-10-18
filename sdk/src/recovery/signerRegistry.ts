export type RegisteredSigner = Uint8Array | string

function signerBytes(value: RegisteredSigner): Uint8Array {
    if (value instanceof Uint8Array) return value
    if (value.length % 2 !== 0 || !/^[0-9a-f]*$/i.test(value)) throw new Error('Invalid signer hex')
    return new Uint8Array(value.match(/.{2}/g)?.map((byte) => parseInt(byte, 16)) ?? [])
}

function toHex(value: Uint8Array): string {
    return Array.from(value, (byte) => byte.toString(16).padStart(2, '0')).join('')
}

/** Compare signer keys by their bytes without loading Stellar SDK modules. */
export function isRegisteredSigner(signers: RegisteredSigner[], publicKey: RegisteredSigner): boolean {
    const target = toHex(signerBytes(publicKey)).toLowerCase()
    return signers.some((signer) => toHex(signerBytes(signer)).toLowerCase() === target)
}
