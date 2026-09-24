#!/usr/bin/env python3
"""Print the SHA-256 fingerprint of an APK's signing certificate.

    python3 scripts/apk-cert-sha256.py app.apk
    -> 0FDAA58B5555CDF2FB6F95F4A5D7507141B5B41EB6F7C83B5416F1BC99095744

Reads the APK Signature Scheme v2/v3 block directly, so it needs nothing but
Python: no Java, no apksigner, no build-tools version to find. Veil's APKs are
signed with v2/v3 only (there is no META-INF v1 signature), and the fingerprint
Android checks against assetlinks.json is the SHA-256 of the first signer's
certificate, which is what this prints (upper-case hex, no colons).

Exits non-zero if the APK has no v2/v3 signing block. It does not verify the
signature itself; it identifies which key signed the APK, which is the question
that decides whether it installs over the current app and keeps passkeys working.
"""

import hashlib
import struct
import sys

V2_BLOCK_ID = 0x7109871A
V3_BLOCK_ID = 0xF05368C0


def length_prefixed(buf: bytes, offset: int) -> tuple[bytes, int]:
    (size,) = struct.unpack_from("<I", buf, offset)
    start = offset + 4
    return buf[start : start + size], start + size


def signing_cert(apk: bytes) -> bytes:
    eocd = apk.rfind(b"PK\x05\x06")
    if eocd < 0:
        raise ValueError("not a zip archive")
    (central_dir,) = struct.unpack_from("<I", apk, eocd + 16)
    if apk[central_dir - 16 : central_dir] != b"APK Sig Block 42":
        raise ValueError("no APK signing block (v2/v3)")
    (block_size,) = struct.unpack_from("<Q", apk, central_dir - 24)
    pairs = apk[central_dir - block_size - 8 + 8 : central_dir - 24]

    offset = 0
    found = {}
    while offset < len(pairs):
        (size,) = struct.unpack_from("<Q", pairs, offset)
        (block_id,) = struct.unpack_from("<I", pairs, offset + 8)
        found[block_id] = pairs[offset + 12 : offset + 8 + size]
        offset += 8 + size

    value = found.get(V3_BLOCK_ID) or found.get(V2_BLOCK_ID)
    if value is None:
        raise ValueError("signing block has no v2/v3 signature")
    signers, _ = length_prefixed(value, 0)
    signer, _ = length_prefixed(signers, 0)
    signed_data, _ = length_prefixed(signer, 0)
    _digests, after_digests = length_prefixed(signed_data, 0)
    certificates, _ = length_prefixed(signed_data, after_digests)
    certificate, _ = length_prefixed(certificates, 0)
    return certificate


def main() -> int:
    if len(sys.argv) != 2:
        print("usage: apk-cert-sha256.py <file.apk>", file=sys.stderr)
        return 2
    with open(sys.argv[1], "rb") as handle:
        apk = handle.read()
    try:
        certificate = signing_cert(apk)
    except (ValueError, struct.error) as error:
        print(f"error: {error}", file=sys.stderr)
        return 1
    print(hashlib.sha256(certificate).hexdigest().upper())
    return 0


if __name__ == "__main__":
    sys.exit(main())
