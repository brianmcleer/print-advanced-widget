/**
 * Drawing backends for print-advanced.
 *
 * The page layout is composed ONCE against this Drawer interface; three
 * backends realize it:
 *   PdfDrawer    -> jsPDF (vector furniture, raster map)   : PDF
 *   SvgDrawer    -> SVG markup (vector furniture)          : SVG / SVGZ
 *   CanvasDrawer -> Canvas 2D at page DPI (all raster)     : PNG32/PNG8/JPG/GIF/TIFF/EPS
 *
 * All coordinates passed to a Drawer are in POINTS (72/in). Each backend
 * converts to its own device space.
 */
import type jsPDF from 'jspdf'

export type ShapeStyle = 'F' | 'S' | 'FD'
export type TextAlign = 'left' | 'center' | 'right'
export type FontWeight = 'normal' | 'bold' | 'italic'
export type DrawerFontFamily = 'sans' | 'serif' | 'mono'

const PDF_FAMILY: Record<DrawerFontFamily, string> = {
  sans: 'helvetica', serif: 'times', mono: 'courier'
}
const CSS_FAMILY: Record<DrawerFontFamily, string> = {
  sans: 'Helvetica, Arial, sans-serif',
  serif: '"Times New Roman", Times, serif',
  mono: '"Courier New", Courier, monospace'
}

export interface Drawer {
  setFill (r: number, g: number, b: number): void
  setStroke (r: number, g: number, b: number): void
  setLineWidth (pt: number): void
  rect (x: number, y: number, w: number, h: number, style: ShapeStyle): void
  roundedRect (x: number, y: number, w: number, h: number, rad: number, style: ShapeStyle): void
  circle (cx: number, cy: number, r: number, style: ShapeStyle): void
  triangle (x1: number, y1: number, x2: number, y2: number, x3: number, y3: number, style: ShapeStyle): void
  line (x1: number, y1: number, x2: number, y2: number): void
  setFont (weight: FontWeight, sizePt: number): void
  /** Page-wide typeface; call once after construction. */
  setFontFamily (family: DrawerFontFamily): void
  /** Use a custom font registered by name (jsPDF addFont / FontFace).
   *  Pass null to return to the family set by setFontFamily. */
  setCustomFont (name: string | null): void
  setTextColor (r: number, g: number, b: number): void
  text (str: string, x: number, y: number, align?: TextAlign): void
  /** Text with a cartographic halo (stroke behind the glyph fill).
   *  Optional capability; callers must fall back when absent. */
  haloText? (str: string, x: number, y: number, align: TextAlign, halo: [number, number, number], haloWidthPt: number): void
  textWidth (str: string): number
  /**
   * fit='stretch' (default) fills the box exactly - used for the map image,
   * whose aspect matches the box by construction. fit='contain' preserves the
   * image's aspect ratio, fitted and centered in the box - used for pictures
   * (Pro honors lockedAspectRatio; stretching distorts logos).
   */
  image (dataUrl: string, fmt: 'JPEG' | 'PNG', x: number, y: number, w: number, h: number, fit?: 'stretch' | 'contain', anchorH?: AnchorH, anchorV?: AnchorV): Promise<void>
}

export type AnchorH = 'left' | 'center' | 'right'
export type AnchorV = 'top' | 'center' | 'bottom'

/** Anchored contain-fit shared by backends that know the image's natural size.
 *  Pro-measured: a BottomLeftCorner picture anchors the fitted image to the
 *  box bottom (PRO pdf: box top 515.8 empty, image 542.1-591.8). */
export function containRect (
  x: number, y: number, w: number, h: number, imgW: number, imgH: number,
  anchorH: AnchorH = 'center', anchorV: AnchorV = 'center'
): { x: number, y: number, w: number, h: number } {
  if (!(imgW > 0) || !(imgH > 0)) return { x, y, w, h }
  const s = Math.min(w / imgW, h / imgH)
  const fw = imgW * s
  const fh = imgH * s
  const fx = anchorH === 'left' ? x : anchorH === 'right' ? x + w - fw : x + (w - fw) / 2
  const fy = anchorV === 'top' ? y : anchorV === 'bottom' ? y + h - fh : y + (h - fh) / 2
  return { x: fx, y: fy, w: fw, h: fh }
}

/** Break a single overlong token (URL, path) at character level. */
function breakWord (drawer: Drawer, word: string, maxW: number): string[] {
  const parts: string[] = []
  let cur = ''
  for (const ch of word) {
    if (cur && drawer.textWidth(cur + ch) > maxW) { parts.push(cur); cur = ch }
    else cur += ch
  }
  if (cur) parts.push(cur)
  return parts
}

/** Greedy word-wrap shared by all backends. Words wider than the box
 *  (long URLs in attribution or copyright) break at character level
 *  instead of overflowing the frame. */
export function splitText (drawer: Drawer, str: string, maxW: number): string[] {
  const words = (str || '').split(/\s+/)
  const lines: string[] = []
  let cur = ''
  for (const w of words) {
    if (drawer.textWidth(w) > maxW) {
      // flush the current line, then hard-break the long token
      if (cur) { lines.push(cur); cur = '' }
      const parts = breakWord(drawer, w, maxW)
      cur = parts.pop() || ''
      lines.push(...parts)
      continue
    }
    const cand = cur ? cur + ' ' + w : w
    if (drawer.textWidth(cand) <= maxW || !cur) cur = cand
    else { lines.push(cur); cur = w }
  }
  if (cur) lines.push(cur)
  return lines
}

/* ------------------------------------------------------------------ */
/* PDF backend                                                         */
/* ------------------------------------------------------------------ */

export class PdfDrawer implements Drawer {
  constructor (private readonly doc: jsPDF) {
    // Pro symbology in imported .pagx layouts uses Round caps/joins; butt caps
    // leave visible notches where thick rules meet at corners.
    ;(doc as any).setLineCap('round')
    ;(doc as any).setLineJoin('round')
  }
  setFill (r: number, g: number, b: number): void { this.doc.setFillColor(r, g, b) }
  setStroke (r: number, g: number, b: number): void { this.doc.setDrawColor(r, g, b) }
  setLineWidth (pt: number): void { this.doc.setLineWidth(pt) }
  rect (x: number, y: number, w: number, h: number, s: ShapeStyle): void { this.doc.rect(x, y, w, h, s) }
  roundedRect (x: number, y: number, w: number, h: number, rad: number, s: ShapeStyle): void {
    this.doc.roundedRect(x, y, w, h, rad, rad, s)
  }
  circle (cx: number, cy: number, r: number, s: ShapeStyle): void { this.doc.circle(cx, cy, r, s) }
  triangle (x1: number, y1: number, x2: number, y2: number, x3: number, y3: number, s: ShapeStyle): void {
    this.doc.triangle(x1, y1, x2, y2, x3, y3, s)
  }
  line (x1: number, y1: number, x2: number, y2: number): void { this.doc.line(x1, y1, x2, y2) }
  private family: DrawerFontFamily = 'sans'
  private customName: string | null = null
  setFontFamily (family: DrawerFontFamily): void { this.family = family }
  setCustomFont (name: string | null): void { this.customName = name }
  setFont (weight: FontWeight, sizePt: number): void {
    if (this.customName) {
      // custom fonts are registered as 'normal' and 'bold'; italic falls back
      this.doc.setFont(this.customName, weight === 'bold' ? 'bold' : 'normal')
    } else {
      this.doc.setFont(PDF_FAMILY[this.family], weight === 'normal' ? 'normal' : weight)
    }
    this.doc.setFontSize(sizePt)
  }
  setTextColor (r: number, g: number, b: number): void { this.doc.setTextColor(r, g, b) }
  text (str: string, x: number, y: number, align: TextAlign = 'left'): void {
    this.doc.text(str, x, y, align === 'left' ? undefined : { align })
  }
  haloText (str: string, x: number, y: number, align: TextAlign, halo: [number, number, number], haloWidthPt: number): void {
    const d: any = this.doc
    try {
      d.setDrawColor(halo[0], halo[1], halo[2])
      d.setLineWidth(haloWidthPt)
      if (typeof d.setLineJoin === 'function') d.setLineJoin('round')
      if (typeof d.setLineCap === 'function') d.setLineCap('round')
      d.text(str, x, y, { align: align === 'left' ? undefined : align, renderingMode: 'stroke' })
    } catch (e) { /* halo is best-effort; fill always draws */ }
    this.text(str, x, y, align)
  }
  textWidth (str: string): number { return this.doc.getTextWidth(str) }
  async image (dataUrl: string, fmt: 'JPEG' | 'PNG', x: number, y: number, w: number, h: number, fit: 'stretch' | 'contain' = 'stretch', anchorH: AnchorH = 'center', anchorV: AnchorV = 'center'): Promise<void> {
    if (fit === 'contain') {
      try {
        const props: any = (this.doc as any).getImageProperties(dataUrl)
        const r = containRect(x, y, w, h, props?.width || 0, props?.height || 0, anchorH, anchorV)
        this.doc.addImage(dataUrl, fmt, r.x, r.y, r.w, r.h)
        return
      } catch (e) { /* fall through to stretch */ }
    }
    this.doc.addImage(dataUrl, fmt, x, y, w, h)
  }
}

/* ------------------------------------------------------------------ */
/* Canvas backend                                                      */
/* ------------------------------------------------------------------ */

const _imgCache = new Map<string, Promise<HTMLImageElement>>()

function loadImage (dataUrl: string): Promise<HTMLImageElement> {
  let p = _imgCache.get(dataUrl)
  if (!p) {
    p = new Promise((resolve, reject) => {
      const img = new Image()
      img.onload = () => resolve(img)
      img.onerror = () => reject(new Error('image load failed'))
      img.src = dataUrl
    })
    _imgCache.set(dataUrl, p)
    p.catch(() => _imgCache.delete(dataUrl))
    // bound the cache: map captures are huge; keep it small
    if (_imgCache.size > 64) {
      const first = _imgCache.keys().next().value
      if (first) _imgCache.delete(first)
    }
  }
  return p
}

export class CanvasDrawer implements Drawer {
  readonly canvas: HTMLCanvasElement
  private readonly ctx: CanvasRenderingContext2D
  private readonly s: number // px per pt
  private fill = '#000'
  private stroke = '#000'
  private lw = 1
  private font = 'normal'
  private fontSize = 10
  private textColor = '#000'
  private family: DrawerFontFamily = 'sans'

  constructor (pageWPt: number, pageHPt: number, dpi: number) {
    this.s = dpi / 72
    this.canvas = document.createElement('canvas')
    this.canvas.width = Math.round(pageWPt * this.s)
    this.canvas.height = Math.round(pageHPt * this.s)
    const ctx = this.canvas.getContext('2d')
    if (!ctx) throw new Error('Canvas 2D context unavailable.')
    this.ctx = ctx
    this.ctx.fillStyle = '#ffffff'
    this.ctx.fillRect(0, 0, this.canvas.width, this.canvas.height)
    this.ctx.imageSmoothingEnabled = true
    this.ctx.imageSmoothingQuality = 'high'
    this.ctx.lineCap = 'round'
    this.ctx.lineJoin = 'round'
  }

  private rgb (r: number, g: number, b: number): string { return `rgb(${r},${g},${b})` }
  private customName: string | null = null
  setFontFamily (family: DrawerFontFamily): void { this.family = family }
  setCustomFont (name: string | null): void { this.customName = name }
  private cssFamily (): string {
    return this.customName ? `"${this.customName}", ${CSS_FAMILY[this.family]}` : CSS_FAMILY[this.family]
  }
  private applyFont (): void {
    const weight = this.font === 'bold' ? 'bold ' : this.font === 'italic' ? 'italic ' : ''
    this.ctx.font = `${weight}${this.fontSize * this.s}px ${this.cssFamily()}`
  }
  private paint (style: ShapeStyle): void {
    if (style === 'F' || style === 'FD') { this.ctx.fillStyle = this.fill; this.ctx.fill() }
    if (style === 'S' || style === 'FD') {
      this.ctx.strokeStyle = this.stroke
      this.ctx.lineWidth = this.lw * this.s
      this.ctx.stroke()
    }
  }

  setFill (r: number, g: number, b: number): void { this.fill = this.rgb(r, g, b) }
  setStroke (r: number, g: number, b: number): void { this.stroke = this.rgb(r, g, b) }
  setLineWidth (pt: number): void { this.lw = pt }

  rect (x: number, y: number, w: number, h: number, style: ShapeStyle): void {
    this.ctx.beginPath()
    this.ctx.rect(x * this.s, y * this.s, w * this.s, h * this.s)
    this.paint(style)
  }

  roundedRect (x: number, y: number, w: number, h: number, rad: number, style: ShapeStyle): void {
    const s = this.s; const X = x * s; const Y = y * s; const W = w * s; const H = h * s; const R = rad * s
    const c = this.ctx
    c.beginPath()
    c.moveTo(X + R, Y)
    c.arcTo(X + W, Y, X + W, Y + H, R)
    c.arcTo(X + W, Y + H, X, Y + H, R)
    c.arcTo(X, Y + H, X, Y, R)
    c.arcTo(X, Y, X + W, Y, R)
    c.closePath()
    this.paint(style)
  }

  circle (cx: number, cy: number, r: number, style: ShapeStyle): void {
    this.ctx.beginPath()
    this.ctx.arc(cx * this.s, cy * this.s, r * this.s, 0, Math.PI * 2)
    this.paint(style)
  }

  triangle (x1: number, y1: number, x2: number, y2: number, x3: number, y3: number, style: ShapeStyle): void {
    const s = this.s; const c = this.ctx
    c.beginPath()
    c.moveTo(x1 * s, y1 * s)
    c.lineTo(x2 * s, y2 * s)
    c.lineTo(x3 * s, y3 * s)
    c.closePath()
    this.paint(style)
  }

  line (x1: number, y1: number, x2: number, y2: number): void {
    const s = this.s; const c = this.ctx
    c.beginPath()
    c.moveTo(x1 * s, y1 * s)
    c.lineTo(x2 * s, y2 * s)
    c.strokeStyle = this.stroke
    c.lineWidth = this.lw * s
    c.stroke()
  }

  setFont (weight: FontWeight, sizePt: number): void { this.font = weight; this.fontSize = sizePt; this.applyFont() }
  setTextColor (r: number, g: number, b: number): void { this.textColor = this.rgb(r, g, b) }

  text (str: string, x: number, y: number, align: TextAlign = 'left'): void {
    this.applyFont()
    this.ctx.fillStyle = this.textColor
    this.ctx.textAlign = align
    this.ctx.textBaseline = 'alphabetic'
    this.ctx.fillText(str, x * this.s, y * this.s)
  }
  haloText (str: string, x: number, y: number, align: TextAlign, halo: [number, number, number], haloWidthPt: number): void {
    this.applyFont()
    this.ctx.save()
    this.ctx.textAlign = align
    this.ctx.textBaseline = 'alphabetic'
    this.ctx.lineJoin = 'round'
    this.ctx.miterLimit = 2
    this.ctx.strokeStyle = this.rgb(halo[0], halo[1], halo[2])
    this.ctx.lineWidth = haloWidthPt * 2 * this.s
    this.ctx.strokeText(str, x * this.s, y * this.s)
    this.ctx.restore()
    this.text(str, x, y, align)
  }

  textWidth (str: string): number {
    this.applyFont()
    return this.ctx.measureText(str).width / this.s
  }

  async image (dataUrl: string, _fmt: 'JPEG' | 'PNG', x: number, y: number, w: number, h: number, fit: 'stretch' | 'contain' = 'stretch', anchorH: AnchorH = 'center', anchorV: AnchorV = 'center'): Promise<void> {
    const img = await loadImage(dataUrl)
    let r = { x, y, w, h }
    if (fit === 'contain') r = containRect(x, y, w, h, img.naturalWidth, img.naturalHeight, anchorH, anchorV)
    this.ctx.drawImage(img, r.x * this.s, r.y * this.s, r.w * this.s, r.h * this.s)
  }
}

/* ------------------------------------------------------------------ */
/* SVG backend                                                         */
/* ------------------------------------------------------------------ */

function esc (str: string): string {
  return (str || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
}

export class SvgDrawer implements Drawer {
  private readonly parts: string[] = []
  private readonly measurer: CanvasRenderingContext2D
  private fill = 'rgb(0,0,0)'
  private stroke = 'rgb(0,0,0)'
  private lw = 1
  private font: FontWeight = 'normal'
  private fontSize = 10
  private textColor = 'rgb(0,0,0)'
  private family: DrawerFontFamily = 'sans'

  constructor (private readonly pageWPt: number, private readonly pageHPt: number) {
    const c = document.createElement('canvas')
    const ctx = c.getContext('2d')
    if (!ctx) throw new Error('Canvas 2D context unavailable.')
    this.measurer = ctx
    this.parts.push(
      `<rect x="0" y="0" width="${pageWPt}" height="${pageHPt}" fill="#ffffff"/>`
    )
  }

  private styleAttr (style: ShapeStyle): string {
    const f = style === 'S' ? 'none' : this.fill
    const s = style === 'F' ? 'none' : this.stroke
    const sw = style === 'F' ? '' : ` stroke-width="${this.lw}" stroke-linecap="round" stroke-linejoin="round"`
    return `fill="${f}" stroke="${s}"${sw}`
  }

  setFill (r: number, g: number, b: number): void { this.fill = `rgb(${r},${g},${b})` }
  setStroke (r: number, g: number, b: number): void { this.stroke = `rgb(${r},${g},${b})` }
  setLineWidth (pt: number): void { this.lw = pt }

  rect (x: number, y: number, w: number, h: number, style: ShapeStyle): void {
    this.parts.push(`<rect x="${x}" y="${y}" width="${w}" height="${h}" ${this.styleAttr(style)}/>`)
  }
  roundedRect (x: number, y: number, w: number, h: number, rad: number, style: ShapeStyle): void {
    this.parts.push(`<rect x="${x}" y="${y}" width="${w}" height="${h}" rx="${rad}" ${this.styleAttr(style)}/>`)
  }
  circle (cx: number, cy: number, r: number, style: ShapeStyle): void {
    this.parts.push(`<circle cx="${cx}" cy="${cy}" r="${r}" ${this.styleAttr(style)}/>`)
  }
  triangle (x1: number, y1: number, x2: number, y2: number, x3: number, y3: number, style: ShapeStyle): void {
    this.parts.push(`<polygon points="${x1},${y1} ${x2},${y2} ${x3},${y3}" ${this.styleAttr(style)}/>`)
  }
  line (x1: number, y1: number, x2: number, y2: number): void {
    this.parts.push(`<line x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}" stroke="${this.stroke}" stroke-width="${this.lw}" stroke-linecap="round" stroke-linejoin="round"/>`)
  }

  private customName: string | null = null
  setFont (weight: FontWeight, sizePt: number): void { this.font = weight; this.fontSize = sizePt }
  setFontFamily (family: DrawerFontFamily): void { this.family = family }
  setCustomFont (name: string | null): void { this.customName = name }
  private cssFamily (): string {
    return this.customName ? `"${this.customName}", ${CSS_FAMILY[this.family]}` : CSS_FAMILY[this.family]
  }
  setTextColor (r: number, g: number, b: number): void { this.textColor = `rgb(${r},${g},${b})` }

  text (str: string, x: number, y: number, align: TextAlign = 'left'): void {
    const anchor = align === 'center' ? 'middle' : align === 'right' ? 'end' : 'start'
    const weight = this.font === 'bold' ? ' font-weight="bold"' : ''
    const styleAttr = this.font === 'italic' ? ' font-style="italic"' : ''
    this.parts.push(
      `<text x="${x}" y="${y}" font-family='${this.cssFamily()}' font-size="${this.fontSize}"` +
      `${weight}${styleAttr} fill="${this.textColor}" text-anchor="${anchor}">${esc(str)}</text>`
    )
  }
  haloText (str: string, x: number, y: number, align: TextAlign, halo: [number, number, number], haloWidthPt: number): void {
    const anchor = align === 'center' ? 'middle' : align === 'right' ? 'end' : 'start'
    const weight = this.font === 'bold' ? ' font-weight="bold"' : ''
    const styleAttr = this.font === 'italic' ? ' font-style="italic"' : ''
    const stroke = `rgb(${halo[0]},${halo[1]},${halo[2]})`
    this.parts.push(
      `<text x="${x}" y="${y}" font-family='${this.cssFamily()}' font-size="${this.fontSize}"` +
      `${weight}${styleAttr} fill="${this.textColor}" text-anchor="${anchor}"` +
      ` stroke="${stroke}" stroke-width="${haloWidthPt * 2}" stroke-linejoin="round"` +
      ` style="paint-order:stroke">${esc(str)}</text>`
    )
  }

  textWidth (str: string): number {
    const weight = this.font === 'bold' ? 'bold ' : this.font === 'italic' ? 'italic ' : ''
    this.measurer.font = `${weight}${this.fontSize}px ${this.cssFamily()}`
    return this.measurer.measureText(str).width
  }

  async image (dataUrl: string, _fmt: 'JPEG' | 'PNG', x: number, y: number, w: number, h: number, fit: 'stretch' | 'contain' = 'stretch', anchorH: AnchorH = 'center', anchorV: AnchorV = 'center'): Promise<void> {
    const xa = anchorH === 'left' ? 'xMin' : anchorH === 'right' ? 'xMax' : 'xMid'
    const ya = anchorV === 'top' ? 'YMin' : anchorV === 'bottom' ? 'YMax' : 'YMid'
    const par = fit === 'contain' ? `${xa}${ya} meet` : 'none'
    this.parts.push(
      `<image x="${x}" y="${y}" width="${w}" height="${h}" preserveAspectRatio="${par}" href="${dataUrl}" xlink:href="${dataUrl}"/>`
    )
  }

  toSvg (): string {
    return `<?xml version="1.0" encoding="UTF-8"?>\n` +
      `<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" ` +
      `width="${this.pageWPt}pt" height="${this.pageHPt}pt" viewBox="0 0 ${this.pageWPt} ${this.pageHPt}">\n` +
      this.parts.join('\n') + '\n</svg>'
  }
}
