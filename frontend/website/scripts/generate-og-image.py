"""
Render the site's link-preview image (public/og.png, 1200x630).

Why a static PNG and not app/opengraph-image.tsx: Next's ImageResponse
(@vercel/og) fails to build on Windows with "TypeError: Invalid URL" while
loading its bundled font, so a generated route could not be verified locally.
A file has no runtime and cannot fail at request time. It is referenced
explicitly from every page through lib/metadata.ts — not through the
app/opengraph-image file convention, which dropped the image on any page that
set its own openGraph metadata.

Uses the brand typefaces from the mobile app's font packages (Lora 600 italic
for the wordmark, Inter for everything else) and the brand tokens: near-black
#0F0F0F, gold #FDDA24.

    python -m pip install --user pillow
    python frontend/website/scripts/generate-og-image.py

Rerun after changing the copy below; commit the PNG.
"""

from pathlib import Path

from PIL import Image, ImageDraw, ImageFont

HERE = Path(__file__).resolve().parent
WEBSITE = HERE.parent
FONTS = WEBSITE.parent / 'mobile' / 'node_modules' / '@expo-google-fonts'
OUT = WEBSITE / 'public' / 'og.png'

W, H = 1200, 630
PAD_X = 80

BG = (15, 15, 15)
GOLD = (253, 218, 36)
TEXT = (246, 247, 248)
MUTED = (160, 161, 162)  # textSecondary (#F6F7F8 at 62%) flattened onto the background
LABEL = (214, 210, 196)

HEADLINE = ['Your fingerprint', 'is your wallet.']
# One sentence per line: wrapping by width left single words stranded.
SUBHEAD = ['A passkey smart wallet on Stellar.', 'No seed phrases. No private keys.']
FOOTER = 'useveilapp.xyz  ·  Live on Stellar mainnet'


def font(family: str, style: str, size: int) -> ImageFont.FreeTypeFont:
    path = FONTS / family / style / f'{family.capitalize()}_{style}.ttf'
    if not path.exists():
        raise SystemExit(f'Missing font {path} — run npm install in frontend/mobile first.')
    return ImageFont.truetype(str(path), size)



def main() -> None:
    img = Image.new('RGB', (W, H), BG)
    d = ImageDraw.Draw(img)

    # Wordmark: gold dot + Lora italic "Veil".
    d.ellipse((PAD_X, 86, PAD_X + 20, 106), fill=GOLD)
    d.text((PAD_X + 38, 70), 'Veil', font=font('lora', '600SemiBold_Italic', 46), fill=GOLD)

    # Headline, then subhead, bottom-anchored above the footer.
    head_face = font('inter', '700Bold', 80)
    sub_face = font('inter', '400Regular', 34)
    usable = W - 2 * PAD_X
    head_lines = HEADLINE
    sub_lines = SUBHEAD

    for line in [*head_lines]:
        assert d.textlength(line, font=head_face) <= usable, f'headline line too wide: {line!r}'

    y = 186
    for line in head_lines:
        d.text((PAD_X, y), line, font=head_face, fill=TEXT)
        y += 90
    y += 24
    for line in sub_lines:
        d.text((PAD_X, y), line, font=sub_face, fill=MUTED)
        y += 46

    d.text((PAD_X, H - 96), FOOTER, font=font('inter', '500Medium', 26), fill=LABEL)

    img.save(OUT, optimize=True)
    print(f'wrote {OUT.relative_to(WEBSITE)} ({OUT.stat().st_size // 1024} KB)')


if __name__ == '__main__':
    main()
