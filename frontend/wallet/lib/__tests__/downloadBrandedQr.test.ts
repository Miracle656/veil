/**
 * Tests for the branded QR download (lib/downloadBrandedQr.ts).
 *
 * A QR code is read by a machine, not a person: one that renders but scans to
 * the wrong payload sends money to the wrong place while looking perfect. So
 * these tests never stop at "something was drawn" — they decode the exact
 * pixels handed to the user and compare the result, byte for byte, with what
 * was meant to be encoded.
 *
 * jsdom has no canvas implementation (`getContext` returns null) and the
 * native `canvas` package is not a dependency, so a small software 2D context
 * is installed below. It rasterises exactly the calls the code under test
 * makes (fillRect, rounded-rect paths, drawImage, fillText) into an RGBA
 * buffer. The QR itself is produced by the real `<QRCodeCanvas>` from
 * qrcode.react with the props app/receive/page.tsx uses, and the composite is
 * decoded with jsQR — the same decoder the wallet's own scanner uses.
 *
 * Text has no glyph data here, so fillText paints a solid block covering the
 * text's approximate extent. That is a stricter stand-in than real glyphs for
 * the "branding must not cover the code" checks: any overlap would show up.
 */

import { TextEncoder, TextDecoder } from 'util'
Object.assign(globalThis, { TextEncoder, TextDecoder })

import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { QRCodeCanvas } from 'qrcode.react'
import jsQR, { type QRCode } from 'jsqr'
import { StrKey } from '@stellar/stellar-sdk'

import { downloadBrandedQr } from '../downloadBrandedQr'
import { createPaymentRequest, parsePaymentLink } from '../paymentRequest'

// Full keys, never shortened: a truncated fixture would hide exactly the bug
// these tests exist to catch.
const ADDRESS = 'GDVEU3DD4KOFECV66VIHWEZOYX4ZKR3WV27L464SIIPOU2IUI3JCZA57'
const MUXED_ADDRESS = 'MDVEU3DD4KOFECV66VIHWEZOYX4ZKR3WV27L464SIIPOU2IUI3JCYAAAAAAAAAAEYPEPM'
const ISSUER = 'GBTM2YELSKFYRZIOB37KUM726HCDZ37AOKKLBOD6T7QKXJVDZ53DG4MA'

// Card geometry from downloadBrandedQr.ts. If the layout changes these must
// follow, and the quiet-zone test below re-proves scannability for it.
const CARD_W = 1080
const CARD_H = 1260
const QR_X = 230
const QR_Y = 408
const QR_SIZE = 620
const CARD_TOP = 360
const CARD_BOTTOM = 360 + 716

// ── Software 2D context ────────────────────────────────────────────────────

type Rgba = [number, number, number, number]
type Point = [number, number]

function parseColor(style: string): Rgba {
  const s = style.trim()
  let m = /^#([0-9a-f]{6})$/i.exec(s)
  if (m) {
    const n = parseInt(m[1], 16)
    return [(n >> 16) & 255, (n >> 8) & 255, n & 255, 1]
  }
  m = /^#([0-9a-f]{3})$/i.exec(s)
  if (m) {
    const [r, g, b] = m[1].split('').map((c) => parseInt(c + c, 16))
    return [r, g, b, 1]
  }
  m = /^rgba?\(\s*([\d.]+)\s*,\s*([\d.]+)\s*,\s*([\d.]+)\s*(?:,\s*([\d.]+)\s*)?\)$/i.exec(s)
  if (m) return [Number(m[1]), Number(m[2]), Number(m[3]), m[4] === undefined ? 1 : Number(m[4])]
  throw new Error(`test raster: unsupported colour "${style}"`)
}

/** Even-odd crossings of a horizontal line at `y` with the polygon's edges, sorted. */
function scanlineCrossings(y: number, poly: Point[]): number[] {
  const xs: number[] = []
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const xi = poly[i][0], yi = poly[i][1], xj = poly[j][0], yj = poly[j][1]
    if ((yi > y) !== (yj > y)) xs.push(((xj - xi) * (y - yi)) / (yj - yi) + xi)
  }
  return xs.sort((a, b) => a - b)
}

type TextCall = { text: string; x: number; y: number; font: string; fillStyle: string }

class RasterContext {
  fillStyle = '#000000'
  globalAlpha = 1
  font = '10px sans-serif'
  textAlign = 'start'
  textBaseline = 'alphabetic'
  letterSpacing = '0px'
  imageSmoothingEnabled = true

  readonly texts: TextCall[] = []
  readonly smoothingAtDrawImage: boolean[] = []
  pixels = new Uint8ClampedArray(0)
  private w = 0
  private h = 0
  private sx = 1
  private sy = 1
  private path: Point[] = []

  constructor(readonly canvas: HTMLCanvasElement) {
    this.sync()
  }

  /** Resizing a canvas clears it and resets its transform, as in a browser. */
  private sync(): void {
    if (this.canvas.width === this.w && this.canvas.height === this.h) return
    this.w = this.canvas.width
    this.h = this.canvas.height
    this.pixels = new Uint8ClampedArray(this.w * this.h * 4)
    this.sx = 1
    this.sy = 1
  }

  get width(): number { this.sync(); return this.w }
  get height(): number { this.sync(); return this.h }

  /** Source-over blend of one colour into the pixel at byte offset `i`. */
  private blend(i: number, color: Rgba): void {
    const alpha = color[3] * this.globalAlpha
    if (alpha >= 1) {
      this.pixels[i] = color[0]; this.pixels[i + 1] = color[1]; this.pixels[i + 2] = color[2]; this.pixels[i + 3] = 255
      return
    }
    const dstA = this.pixels[i + 3] / 255
    const outA = alpha + dstA * (1 - alpha)
    for (let c = 0; c < 3; c++) {
      const blended = color[c] * alpha + this.pixels[i + c] * dstA * (1 - alpha)
      this.pixels[i + c] = outA === 0 ? 0 : Math.round(blended / outA)
    }
    this.pixels[i + 3] = Math.round(outA * 255)
  }

  /** Blend one colour into every pixel whose centre passes `hit`. */
  private paint(color: Rgba, x0: number, y0: number, x1: number, y1: number, hit: (px: number, py: number) => boolean): void {
    this.sync()
    const minX = Math.max(0, Math.floor(Math.min(x0, x1)))
    const maxX = Math.min(this.w, Math.ceil(Math.max(x0, x1)))
    const minY = Math.max(0, Math.floor(Math.min(y0, y1)))
    const maxY = Math.min(this.h, Math.ceil(Math.max(y0, y1)))
    for (let y = minY; y < maxY; y++) {
      for (let x = minX; x < maxX; x++) {
        if (hit(x + 0.5, y + 0.5)) this.blend((y * this.w + x) * 4, color)
      }
    }
  }

  scale(x: number, y: number): void {
    this.sync()
    this.sx *= x
    this.sy *= y
  }

  fillRect(x: number, y: number, w: number, h: number): void {
    const x0 = x * this.sx, y0 = y * this.sy, x1 = (x + w) * this.sx, y1 = (y + h) * this.sy
    this.paint(parseColor(this.fillStyle), x0, y0, x1, y1, (px, py) => px >= x0 && px < x1 && py >= y0 && py < y1)
  }

  beginPath(): void { this.path = [] }
  moveTo(x: number, y: number): void { this.path.push([x * this.sx, y * this.sy]) }
  lineTo(x: number, y: number): void { this.path.push([x * this.sx, y * this.sy]) }
  closePath(): void { /* fill() closes the polygon implicitly */ }

  /** Canvas arcTo: a line to the first tangent point, then the arc, sampled. */
  arcTo(x1: number, y1: number, x2: number, y2: number, r: number): void {
    const [x0, y0] = this.path[this.path.length - 1]
    const p1: Point = [x1 * this.sx, y1 * this.sy]
    const p2: Point = [x2 * this.sx, y2 * this.sy]
    const u: Point = [x0 - p1[0], y0 - p1[1]]
    const v: Point = [p2[0] - p1[0], p2[1] - p1[1]]
    const lu = Math.hypot(u[0], u[1])
    const lv = Math.hypot(v[0], v[1])
    const radius = r * this.sx
    if (lu === 0 || lv === 0 || radius === 0) { this.path.push(p1); return }
    const nu: Point = [u[0] / lu, u[1] / lu]
    const nv: Point = [v[0] / lv, v[1] / lv]
    const theta = Math.acos(Math.max(-1, Math.min(1, nu[0] * nv[0] + nu[1] * nv[1])))
    const d = radius / Math.tan(theta / 2)
    const bis: Point = [nu[0] + nv[0], nu[1] + nv[1]]
    const lb = Math.hypot(bis[0], bis[1])
    const centreDist = radius / Math.sin(theta / 2)
    const c: Point = [p1[0] + (bis[0] / lb) * centreDist, p1[1] + (bis[1] / lb) * centreDist]
    const t1: Point = [p1[0] + nu[0] * d, p1[1] + nu[1] * d]
    const t2: Point = [p1[0] + nv[0] * d, p1[1] + nv[1] * d]
    const a1 = Math.atan2(t1[1] - c[1], t1[0] - c[0])
    let a2 = Math.atan2(t2[1] - c[1], t2[0] - c[0])
    while (a2 - a1 > Math.PI) a2 -= 2 * Math.PI
    while (a1 - a2 > Math.PI) a2 += 2 * Math.PI
    const steps = 12
    for (let s = 0; s <= steps; s++) {
      const a = a1 + ((a2 - a1) * s) / steps
      this.path.push([c[0] + Math.cos(a) * radius, c[1] + Math.sin(a) * radius])
    }
  }

  roundRect(x: number, y: number, w: number, h: number, r: number): void {
    this.moveTo(x + r, y)
    this.arcTo(x + w, y, x + w, y + h, r)
    this.arcTo(x + w, y + h, x, y + h, r)
    this.arcTo(x, y + h, x, y, r)
    this.arcTo(x, y, x + w, y, r)
  }

  fill(): void {
    const poly = this.path
    if (poly.length < 3) return
    this.sync()
    const color = parseColor(this.fillStyle)
    const ys = poly.map((p) => p[1])
    const minY = Math.max(0, Math.floor(Math.min(...ys)))
    const maxY = Math.min(this.h, Math.ceil(Math.max(...ys)))
    for (let y = minY; y < maxY; y++) {
      const xs = scanlineCrossings(y + 0.5, poly)
      for (let k = 0; k + 1 < xs.length; k += 2) {
        // Pixels whose centre lies inside the span [xs[k], xs[k + 1]).
        const from = Math.max(0, Math.ceil(xs[k] - 0.5))
        const to = Math.min(this.w, Math.ceil(xs[k + 1] - 0.5))
        for (let x = from; x < to; x++) this.blend((y * this.w + x) * 4, color)
      }
    }
  }

  /** No glyphs: paint a solid block over the text's approximate extent. */
  fillText(text: string, x: number, y: number): void {
    this.texts.push({ text, x, y, font: this.font, fillStyle: this.fillStyle })
    const px = Number(/(\d+(?:\.\d+)?)px/.exec(this.font)?.[1] ?? 10)
    const spacing = Number(/([\d.]+)px/.exec(this.letterSpacing)?.[1] ?? 0)
    const width = text.length * (px * 0.6 + spacing)
    const left = this.textAlign === 'center' ? x - width / 2 : x
    const top = this.textBaseline === 'top' ? y : y - px
    const x0 = left * this.sx, y0 = top * this.sy, x1 = (left + width) * this.sx, y1 = (top + px) * this.sy
    this.paint(parseColor(this.fillStyle), x0, y0, x1, y1, () => true)
  }

  /** Nearest-neighbour scaled copy from another rasterised canvas. */
  drawImage(image: HTMLCanvasElement, dx: number, dy: number, dw: number, dh: number): void {
    this.smoothingAtDrawImage.push(this.imageSmoothingEnabled)
    const src = rasterOf(image)
    const srcW = src.width, srcH = src.height, srcPx = src.pixels
    const x0 = dx * this.sx, y0 = dy * this.sy, x1 = (dx + dw) * this.sx, y1 = (dy + dh) * this.sy
    this.sync()
    for (let y = Math.max(0, Math.floor(y0)); y < Math.min(this.h, Math.ceil(y1)); y++) {
      for (let x = Math.max(0, Math.floor(x0)); x < Math.min(this.w, Math.ceil(x1)); x++) {
        const sxp = Math.floor(((x + 0.5 - x0) / (x1 - x0)) * srcW)
        const syp = Math.floor(((y + 0.5 - y0) / (y1 - y0)) * srcH)
        if (sxp < 0 || syp < 0 || sxp >= srcW || syp >= srcH) continue
        const si = (syp * srcW + sxp) * 4
        this.blend((y * this.w + x) * 4, [srcPx[si], srcPx[si + 1], srcPx[si + 2], srcPx[si + 3] / 255])
      }
    }
  }
}

const rasters = new WeakMap<HTMLCanvasElement, RasterContext>()
function rasterOf(canvas: HTMLCanvasElement): RasterContext {
  let ctx = rasters.get(canvas)
  if (!ctx) {
    ctx = new RasterContext(canvas)
    rasters.set(canvas, ctx)
  }
  return ctx
}

// ── Harness: canvas, toDataURL and the download click ─────────────────────

type Snapshot = { width: number; height: number; pixels: Uint8ClampedArray; type: string; ctx: RasterContext }
const snapshots = new Map<string, Snapshot>()
let downloads: Array<{ filename: string; href: string }> = []
let canvasAvailable = true
let nativeRoundRect = true
let roots: Root[] = []

beforeAll(() => {
  ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
})

beforeEach(() => {
  snapshots.clear()
  downloads = []
  canvasAvailable = true
  nativeRoundRect = true

  jest.spyOn(HTMLCanvasElement.prototype, 'getContext').mockImplementation(function (this: HTMLCanvasElement, id: string) {
    if (!canvasAvailable || id !== '2d') return null
    const ctx = rasterOf(this)
    if (!nativeRoundRect) (ctx as unknown as { roundRect?: unknown }).roundRect = undefined
    return ctx as unknown as CanvasRenderingContext2D
  } as unknown as HTMLCanvasElement['getContext'])

  // The data URL is an opaque key to a snapshot of the pixels at the moment
  // of export, so the test decodes exactly what the user would have saved.
  jest.spyOn(HTMLCanvasElement.prototype, 'toDataURL').mockImplementation(function (this: HTMLCanvasElement, type?: string) {
    const ctx = rasterOf(this)
    const key = `data:${type ?? 'image/png'};base64,${Buffer.from(`raster-${snapshots.size}`).toString('base64')}`
    snapshots.set(key, { width: ctx.width, height: ctx.height, pixels: ctx.pixels.slice(), type: type ?? 'image/png', ctx })
    return key
  })

  jest.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (this: HTMLAnchorElement) {
    downloads.push({ filename: this.download, href: this.getAttribute('href') ?? '' })
  })
})

afterEach(() => {
  act(() => roots.forEach((root) => root.unmount()))
  roots = []
  document.body.innerHTML = ''
  document.documentElement.removeAttribute('style')
  delete (document as { fonts?: unknown }).fonts
  jest.restoreAllMocks()
})

/** The real <QRCodeCanvas>, with the props app/receive/page.tsx renders it with. */
function renderReceiveQr(value: string): HTMLCanvasElement {
  const host = document.createElement('div')
  document.body.appendChild(host)
  const root = createRoot(host)
  roots.push(root)
  act(() => {
    root.render(createElement(QRCodeCanvas, { value, size: 200, bgColor: '#ffffff', fgColor: '#0F0F0F', level: 'M' }))
  })
  const canvas = host.querySelector('canvas')
  if (!canvas) throw new Error('QRCodeCanvas did not render a canvas')
  return canvas
}

/** Run the download and return the single file it produced. */
async function downloadFor(payload: string, address: string, filename = 'veil-spending.png'): Promise<Snapshot & { filename: string }> {
  const ok = await downloadBrandedQr({ qrCanvas: renderReceiveQr(payload), filename, address })
  expect(ok).toBe(true)
  expect(downloads).toHaveLength(1)
  const snap = snapshots.get(downloads[0].href)
  if (!snap) throw new Error('downloaded href was not produced by canvas.toDataURL')
  return { ...snap, filename: downloads[0].filename }
}

function decode(snap: Snapshot): QRCode {
  // The code is dark-on-light by construction, so skip jsQR's inverted pass.
  const result = jsQR(snap.pixels, snap.width, snap.height, { inversionAttempts: 'dontInvert' })
  if (!result) throw new Error('jsQR could not find a QR code in the downloaded image')
  return result
}

/** Payload bytes exactly as decoded, independent of jsQR's string decoding. */
function decodedBytes(result: QRCode): string {
  return Buffer.from(result.binaryData).toString('latin1')
}

function luminance(snap: Snapshot, x: number, y: number): number {
  const i = (y * snap.width + x) * 4
  return 0.299 * snap.pixels[i] + 0.587 * snap.pixels[i + 1] + 0.114 * snap.pixels[i + 2]
}

// ── Tests ─────────────────────────────────────────────────────────────────

describe('fixtures', () => {
  // A malformed fixture would make every round-trip below meaningless.
  it('uses real, full-length Stellar keys', () => {
    expect(ADDRESS).toHaveLength(56)
    expect(StrKey.isValidEd25519PublicKey(ADDRESS)).toBe(true)
    expect(ISSUER).toHaveLength(56)
    expect(StrKey.isValidEd25519PublicKey(ISSUER)).toBe(true)
    expect(MUXED_ADDRESS).toHaveLength(69)
    expect(StrKey.isValidMed25519PublicKey(MUXED_ADDRESS)).toBe(true)
  })
})

describe('downloadBrandedQr — the saved image decodes to the exact payload', () => {
  const cases: Array<[string, () => string, string]> = [
    ['a bare G address', () => ADDRESS, ADDRESS],
    ['a bare muxed M address', () => MUXED_ADDRESS, MUXED_ADDRESS],
    ['the receive page SEP-7 request', () => createPaymentRequest({ destination: ADDRESS }).qrValue, ADDRESS],
    ['a SEP-7 request with an amount', () => createPaymentRequest({ destination: ADDRESS, amount: '25.5' }).qrValue, ADDRESS],
    [
      'a SEP-7 issued-asset request (longest payload, densest code)',
      () => createPaymentRequest({ destination: ADDRESS, amount: '1250', assetCode: 'USDC', assetIssuer: ISSUER }).qrValue,
      ADDRESS,
    ],
    ['a SEP-7 request to a muxed address', () => createPaymentRequest({ destination: MUXED_ADDRESS }).qrValue, MUXED_ADDRESS],
  ]

  it.each(cases)('%s', async (_label, makePayload, address) => {
    const payload = makePayload()
    const snap = await downloadFor(payload, address)

    const result = decode(snap)
    // If this fails, the saved QR scans to something other than what the
    // receive screen showed — a payer would be sent elsewhere.
    expect(decodedBytes(result)).toBe(payload)
    expect(result.data).toBe(payload)

    // The full address survives byte for byte: no ellipsis, no truncation, no
    // case or whitespace normalisation.
    expect(result.data).toContain(address)
    expect(result.data).not.toContain('…')
    if (payload === address) {
      expect(result.data).toHaveLength(address.length)
    } else {
      expect(parsePaymentLink(result.data).destination).toBe(address)
    }
  })

  it('encodes what the QR canvas holds, not a re-encoding of the address argument', async () => {
    // The amount and asset live only in the URI; if the download re-encoded
    // from `address` the payer would silently lose them.
    const payload = createPaymentRequest({ destination: ADDRESS, amount: '1250', assetCode: 'USDC', assetIssuer: ISSUER }).qrValue
    const result = decode(await downloadFor(payload, ADDRESS))
    expect(result.data).toBe(payload)
    expect(parsePaymentLink(result.data)).toMatchObject({ destination: ADDRESS, amount: '1250', assetCode: 'USDC', assetIssuer: ISSUER })
  })

  it('saves a PNG under the requested filename', async () => {
    const snap = await downloadFor(ADDRESS, ADDRESS, `veil-spending-${ADDRESS.slice(0, 8)}.png`)
    expect(snap.type).toBe('image/png')
    expect(snap.filename).toBe('veil-spending-GDVEU3DD.png')
    expect([snap.width, snap.height]).toEqual([CARD_W, CARD_H])
  })
})

describe('downloadBrandedQr — branding does not break scanning', () => {
  it('keeps a light quiet zone of at least 4 modules around the code, clear of every overlay', async () => {
    // The densest payload the receive page produces has the smallest modules,
    // so it is the worst case for the fixed 48px white margin.
    const payload = createPaymentRequest({ destination: ADDRESS, amount: '1250', assetCode: 'USDC', assetIssuer: ISSUER }).qrValue
    const snap = await downloadFor(payload, ADDRESS)
    const modules = 17 + 4 * decode(snap).version
    const band = Math.ceil((4 * QR_SIZE) / modules)

    // The code fills exactly its 620px slot on the white card — square, not
    // cropped or stretched — so the band below is measured around the real code.
    let [left, top, right, bottom] = [CARD_W, CARD_H, -1, -1]
    for (let y = CARD_TOP; y < CARD_BOTTOM; y++) {
      for (let x = 0; x < CARD_W; x++) {
        if (luminance(snap, x, y) >= 128) continue
        left = Math.min(left, x); right = Math.max(right, x)
        top = Math.min(top, y); bottom = Math.max(bottom, y)
      }
    }
    expect([left, top, right + 1, bottom + 1]).toEqual([QR_X, QR_Y, QR_X + QR_SIZE, QR_Y + QR_SIZE])

    // A mark, wordmark or caption creeping into this band, or a background too
    // dark to read as "light", makes the code fail on stricter scanners.
    let darkest = 255
    for (let y = QR_Y - band; y < QR_Y + QR_SIZE + band; y++) {
      for (let x = QR_X - band; x < QR_X + QR_SIZE + band; x++) {
        const insideCode = x >= QR_X && x < QR_X + QR_SIZE && y >= QR_Y && y < QR_Y + QR_SIZE
        if (!insideCode) darkest = Math.min(darkest, luminance(snap, x, y))
      }
    }
    expect(darkest).toBeGreaterThan(180)
  })

  it('draws the code with strong contrast and without smoothing', async () => {
    const snap = await downloadFor(ADDRESS, ADDRESS)
    // Smoothing blurs module edges into grey; the code under test turns it off
    // for exactly the one drawImage that copies the QR.
    expect(snap.ctx.smoothingAtDrawImage).toEqual([false])

    const values = new Set<number>()
    for (let y = QR_Y; y < QR_Y + QR_SIZE; y += 7) {
      for (let x = QR_X; x < QR_X + QR_SIZE; x += 7) values.add(Math.round(luminance(snap, x, y)))
    }
    // Only ink and paper inside the code: no gold, no translucent overlay.
    expect([...values].sort((a, b) => a - b)).toEqual([15, 255])
  })

  it('still decodes when the browser lacks CanvasRenderingContext2D.roundRect', async () => {
    // Older Safari takes the arcTo fallback; the card must come out the same.
    nativeRoundRect = false
    const snap = await downloadFor(ADDRESS, ADDRESS)
    expect(decode(snap).data).toBe(ADDRESS)
    // The white card was actually drawn by the fallback path: its centre-top
    // edge is paper, while the rounded-off corner is still gold background.
    expect(Math.round(luminance(snap, CARD_W / 2, QR_Y - 24))).toBe(255)
    expect(luminance(snap, QR_X - 47, QR_Y - 47)).toBeLessThan(255)
  })

  it('labels the card with the same address the code carries', async () => {
    const snap = await downloadFor(MUXED_ADDRESS, MUXED_ADDRESS)
    const caption = snap.ctx.texts.find((t) => t.text !== 'VEIL')
    // A caption naming a different account than the QR would mislead anyone
    // checking the image by eye before sharing it.
    expect(caption).toBeDefined()
    expect(caption!.text.startsWith(MUXED_ADDRESS.slice(0, 8))).toBe(true)
    expect(caption!.text.endsWith(MUXED_ADDRESS.slice(-8))).toBe(true)
    expect(snap.ctx.texts.map((t) => t.text)).toContain('VEIL')
  })
})

describe('downloadBrandedQr — environment handling', () => {
  it('returns false and downloads nothing when no 2D context is available', async () => {
    const qrCanvas = renderReceiveQr(ADDRESS)
    canvasAvailable = false
    await expect(downloadBrandedQr({ qrCanvas, filename: 'x.png', address: ADDRESS })).resolves.toBe(false)
    expect(downloads).toHaveLength(0)
  })

  it('waits for web fonts and uses the loaded faces', async () => {
    let resolveFonts!: () => void
    const ready = new Promise<void>((resolve) => { resolveFonts = resolve })
    Object.defineProperty(document, 'fonts', { value: { ready }, configurable: true })
    document.documentElement.style.setProperty('--font-anton', 'AntonLoaded')
    document.documentElement.style.setProperty('--font-inconsolata', 'InconsolataLoaded')

    const pending = downloadBrandedQr({ qrCanvas: renderReceiveQr(ADDRESS), filename: 'x.png', address: ADDRESS })
    await Promise.resolve()
    // Drawing before fonts load would bake fallback faces into the saved file.
    expect(downloads).toHaveLength(0)

    resolveFonts()
    await expect(pending).resolves.toBe(true)
    const snap = snapshots.get(downloads[0].href)!
    expect(decode(snap).data).toBe(ADDRESS)
    const fonts = snap.ctx.texts.map((t) => t.font)
    expect(fonts[0]).toContain('AntonLoaded')
    expect(fonts[1]).toContain('InconsolataLoaded')
  })

  it('still produces a decodable file when font loading fails', async () => {
    Object.defineProperty(document, 'fonts', { value: { ready: Promise.reject(new Error('font load failed')) }, configurable: true })
    const snap = await downloadFor(ADDRESS, ADDRESS)
    expect(decode(snap).data).toBe(ADDRESS)
    expect(snap.ctx.texts[0].font).toContain('Anton, Impact, sans-serif')
  })
})
