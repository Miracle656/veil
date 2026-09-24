const GOLD = '#FDDA24'
const INK = '#0F0F0F'
const PAPER = '#FFFFFF'

const CARD_W = 1080
const CARD_H = 1260

type DownloadBrandedQrParams = {
  qrCanvas: HTMLCanvasElement
  filename: string
  address: string
}

function fontStack(cssVariable: string, fallback: string): string {
  const loaded = getComputedStyle(document.documentElement)
    .getPropertyValue(cssVariable)
    .trim()
  return loaded ? `${loaded}, ${fallback}` : fallback
}

function fillRoundRect(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  w: number,
  h: number,
  r: number,
): void {
  const radius = Math.min(r, w / 2, h / 2)
  ctx.beginPath()
  if (typeof ctx.roundRect === 'function') {
    ctx.roundRect(x, y, w, h, radius)
  } else {
    ctx.moveTo(x + radius, y)
    ctx.arcTo(x + w, y, x + w, y + h, radius)
    ctx.arcTo(x + w, y + h, x, y + h, radius)
    ctx.arcTo(x, y + h, x, y, radius)
    ctx.arcTo(x, y, x + w, y, radius)
    ctx.closePath()
  }
  ctx.fill()
}

/** Three stacked bars from `VeilMark`, scaled into a square. */
function drawVeilMark(
  ctx: CanvasRenderingContext2D,
  cx: number,
  cy: number,
  size: number,
  color: string,
): void {
  const scale = size / 96
  const originX = cx - size / 2
  const originY = cy - size / 2
  const bars: Array<{ x: number; y: number; w: number; h: number; alpha: number }> = [
    { x: 22, y: 26, w: 52, h: 12, alpha: 1 },
    { x: 28, y: 44, w: 40, h: 12, alpha: 0.55 },
    { x: 34, y: 62, w: 28, h: 12, alpha: 0.28 },
  ]
  for (const bar of bars) {
    ctx.globalAlpha = bar.alpha
    ctx.fillStyle = color
    fillRoundRect(
      ctx,
      originX + bar.x * scale,
      originY + bar.y * scale,
      bar.w * scale,
      bar.h * scale,
      6 * scale,
    )
  }
  ctx.globalAlpha = 1
}

function shorten(address: string, head = 6, tail = 6): string {
  return address.length > head + tail + 1
    ? `${address.slice(0, head)}…${address.slice(-tail)}`
    : address
}

function triggerDownload(dataUrl: string, filename: string): void {
  const link = document.createElement('a')
  link.download = filename
  link.href = dataUrl
  link.click()
}

export async function downloadBrandedQr({
  qrCanvas,
  filename,
  address,
}: DownloadBrandedQrParams): Promise<boolean> {
  const out = document.createElement('canvas')
  out.width = CARD_W
  out.height = CARD_H
  const ctx = out.getContext('2d')
  if (!ctx) return false

  if (document.fonts) {
    try {
      await document.fonts.ready
    } catch {
      /* fallback faces still draw */
    }
  }

  ctx.fillStyle = GOLD
  ctx.fillRect(0, 0, CARD_W, CARD_H)

  const markSize = 96
  const markY = 168
  drawVeilMark(ctx, CARD_W / 2, markY, markSize, INK)

  const anton = fontStack('--font-anton', 'Anton, Impact, sans-serif')
  ctx.fillStyle = INK
  ctx.font = `400 72px ${anton}`
  ctx.textAlign = 'center'
  ctx.textBaseline = 'top'
  ctx.letterSpacing = '6px'
  ctx.fillText('VEIL', CARD_W / 2, markY + markSize / 2 + 18)
  ctx.letterSpacing = '0px'

  const qrSize = 620
  const quiet = 48
  const cardSize = qrSize + quiet * 2
  const cardX = (CARD_W - cardSize) / 2
  const cardY = 360
  ctx.fillStyle = PAPER
  fillRoundRect(ctx, cardX, cardY, cardSize, cardSize, 36)

  ctx.imageSmoothingEnabled = false
  ctx.drawImage(qrCanvas, cardX + quiet, cardY + quiet, qrSize, qrSize)
  ctx.imageSmoothingEnabled = true

  const mono = fontStack('--font-inconsolata', 'Inconsolata, monospace')
  ctx.fillStyle = 'rgba(15, 15, 15, 0.55)'
  ctx.font = `400 28px ${mono}`
  ctx.textAlign = 'center'
  ctx.textBaseline = 'top'
  ctx.fillText(shorten(address, 8, 8), CARD_W / 2, cardY + cardSize + 36)

  triggerDownload(out.toDataURL('image/png'), filename)
  return true
}
