#!/usr/bin/env python3
"""Publish the Veil-ians art to the wallet's public directory.

The originals in `brand/veil-masquerade/art/` are the mint-quality source and
are never served. This re-encodes them for the web at full resolution — the
image a buyer sees is the one the token points at forever, so it is not
downscaled, only recompressed.

    python scripts/publish-nft-art.py          # write
    python scripts/publish-nft-art.py --check  # fail if a published file is missing

Requires Pillow. Run `node scripts/build-nft-metadata.mjs` afterwards so the
served metadata is regenerated alongside it.
"""
import json
import os
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SRC = os.path.join(ROOT, "brand", "veil-masquerade", "art")
DST = os.path.join(ROOT, "frontend", "wallet", "public", "masquerade")
TRAITS = os.path.join(ROOT, "brand", "veil-masquerade", "traits.json")
QUALITY = 86


def main() -> int:
    check = "--check" in sys.argv[1:]
    with open(TRAITS, encoding="utf-8") as fh:
        tokens = json.load(fh)["tokens"]

    missing = []
    for token in tokens:
        name = token["image"]
        src, dst = os.path.join(SRC, name), os.path.join(DST, name)
        if not os.path.exists(src):
            missing.append(f"{name} (no original in brand/veil-masquerade/art)")
            continue
        if check:
            if not os.path.exists(dst):
                missing.append(name)
            continue
        from PIL import Image  # imported late so --check works without Pillow

        os.makedirs(DST, exist_ok=True)
        Image.open(src).convert("RGB").save(
            dst, "JPEG", quality=QUALITY, optimize=True, progressive=True
        )

    if missing:
        print("not published: " + ", ".join(missing), file=sys.stderr)
        return 1
    total = sum(os.path.getsize(os.path.join(DST, t["image"])) for t in tokens)
    print(f"{'checked' if check else 'published'} {len(tokens)} images, {total // 1024} KB")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
