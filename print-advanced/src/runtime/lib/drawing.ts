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
import type { jsPDF } from 'jspdf'

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
  /** Start drawing into a named layer (PDF optional content group, SVG
   *  layer group). Optional capability: raster backends leave it out, and
   *  a backend with layers switched off ignores the call. Layers do not
   *  nest: a new begin closes the open layer first. */
  beginLayer? (name: string): void
  /** Close the open layer, if any. */
  endLayer? (): void
  /** Vector path: subpaths of page points; closed adds the closing segment.
   *  evenOdd fills with the even-odd rule (polygon holes). Optional. */
  path? (subpaths: Array<Array<[number, number]>>, closed: boolean, style: ShapeStyle, evenOdd?: boolean): void
  /** Clip later drawing to a rectangle until restoreClip. Optional. */
  clipRect? (x: number, y: number, w: number, h: number): void
  /** Clip later drawing to a path (even-odd) until restoreClip. Optional. */
  clipPath? (subpaths: Array<Array<[number, number]>>, evenOdd?: boolean): void
  /** Text rotated about its baseline start (page degrees, y down, so a
   *  positive angle turns clockwise), with an optional halo. Optional. */
  textAngle? (str: string, x: number, y: number, angleDeg: number, halo: [number, number, number] | null, haloWidthPt: number): void
  restoreClip? (): void
  /** Fill and stroke opacity (0-1) for later shapes. Optional. */
  setAlpha? (fill: number, stroke: number): void
  /** Dash lengths in points, or null for solid. Optional. */
  setDash? (dash: number[] | null): void
}

/** PDF literal string for a layer name (ASCII only, escaped). */
function pdfLit (s: string): string {
  return '(' + String(s || '').replace(/[^\x20-\x7e]/g, '')
    .replace(/\\/g, '\\\\').replace(/\(/g, '\\(').replace(/\)/g, '\\)') + ')'
}

/**
 * PDF layers (optional content, ISO 32000 section 8.11) for a jsPDF
 * document, written through jsPDF's own build events, so no dependency:
 *  - page content: each layer's drawing is wrapped in `/OC /OCn BDC ... EMC`
 *  - putResources: one `<< /Type /OCG /Name (...) >>` object per layer
 *  - putXobjectDict: jsPDF publishes this INSIDE the page resources'
 *    /XObject dictionary, immediately before writing its closing `>>`. The
 *    handler closes /XObject itself and opens /Properties, whose entries
 *    are then closed by jsPDF's own `>>`. The result is the standard
 *    `/XObject << ... >> /Properties << /OC1 n 0 R ... >>`.
 *  - putCatalog: /OCProperties with the layer order and all layers on.
 * Acrobat, Avenza Maps, ArcGIS Pro and QGIS show these as toggleable layers.
 */
export class PdfLayers {
  private readonly names: string[] = []
  private objIds: number[] = []
  private open = false
  private current = ''
  readonly ok: boolean

  constructor (private readonly doc: any) {
    let ok = false
    try {
      const internal = doc && doc.internal
      const ev = internal && internal.events
      if (ev && typeof ev.subscribe === 'function' && typeof internal.write === 'function' &&
        typeof internal.newObject === 'function') {
        const onXobjectDict = (): void => {
          if (!this.objIds.length) return
          internal.write('>>')
          internal.write('/Properties <<')
          this.objIds.forEach((id, i) => internal.write('/OC' + (i + 1) + ' ' + id + ' 0 R'))
        }
        let xoToken: any = null
        ev.subscribe('putResources', () => {
          this.objIds = this.names.map(n => {
            const id = internal.newObject()
            internal.write('<< /Type /OCG /Name ' + pdfLit(n) + ' >>')
            internal.write('endobj')
            return id
          })
          // The /Properties trick must run AFTER every other putXobjectDict
          // handler (jsPDF's image plugin subscribes lazily, on the first
          // addImage, and writes the /I0 entries from that same event).
          // putResources fires after all drawing and just before the
          // resource dictionary is written, so re-subscribing here always
          // puts this handler last.
          try { if (xoToken != null && typeof ev.unsubscribe === 'function') ev.unsubscribe(xoToken) } catch (e) { /* keep going */ }
          xoToken = ev.subscribe('putXobjectDict', onXobjectDict)
        })
        ev.subscribe('putCatalog', () => {
          if (!this.objIds.length) return
          const refs = this.objIds.map(id => id + ' 0 R').join(' ')
          internal.write('/OCProperties << /OCGs [' + refs + '] /D << /Name (Layers) /Order [' + refs + '] /ON [' + refs + '] /OFF [] /BaseState /ON >> >>')
        })
        ok = true
      }
    } catch (e) { ok = false }
    this.ok = ok
  }

  /** Registered layer names, in first-use order. */
  list (): string[] { return this.names.slice() }

  begin (name: string): void {
    if (!this.ok) return
    if (this.open && this.current === name) return // same layer continues
    this.end()
    this.current = name
    let i = this.names.indexOf(name)
    if (i < 0) { this.names.push(name); i = this.names.length - 1 }
    this.doc.internal.write('/OC /OC' + (i + 1) + ' BDC')
    this.open = true
  }

  end (): void {
    if (!this.ok || !this.open) return
    this.doc.internal.write('EMC')
    this.open = false
  }
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
  private layers: PdfLayers | null = null
  /** Switch PDF layers on for this document (call once, before drawing). */
  enableLayers (): boolean {
    if (!this.layers) this.layers = new PdfLayers(this.doc)
    return this.layers.ok
  }
  layerNames (): string[] { return this.layers ? this.layers.list() : [] }
  beginLayer (name: string): void { if (this.layers) this.layers.begin(name) }
  endLayer (): void { if (this.layers) this.layers.end() }
  private n (v: number): string { return (Math.round(v * 100) / 100).toString() }
  path (subpaths: Array<Array<[number, number]>>, closed: boolean, style: ShapeStyle, evenOdd = false): void {
    const d: any = this.doc
    const k = Number(d.internal.scaleFactor) || 1
    const H = Number(d.internal.pageSize.getHeight())
    const ops: string[] = []
    for (const sp of subpaths) {
      if (!sp || sp.length < 2) continue
      ops.push(this.n(sp[0][0] * k) + ' ' + this.n((H - sp[0][1]) * k) + ' m')
      for (let i = 1; i < sp.length; i++) ops.push(this.n(sp[i][0] * k) + ' ' + this.n((H - sp[i][1]) * k) + ' l')
      if (closed) ops.push('h')
    }
    if (!ops.length) return
    const eo = evenOdd ? '*' : ''
    ops.push(style === 'F' ? 'f' + eo : style === 'FD' ? 'B' + eo : 'S')
    d.internal.write(ops.join('\n'))
  }
  clipRect (x: number, y: number, w: number, h: number): void {
    const d: any = this.doc
    const k = Number(d.internal.scaleFactor) || 1
    const H = Number(d.internal.pageSize.getHeight())
    d.saveGraphicsState()
    d.internal.write(this.n(x * k) + ' ' + this.n((H - y - h) * k) + ' ' + this.n(w * k) + ' ' + this.n(h * k) + ' re W n')
  }
  restoreClip (): void { (this.doc as any).restoreGraphicsState() }
  clipPath (subpaths: Array<Array<[number, number]>>, evenOdd = true): void {
    const d: any = this.doc
    const k = Number(d.internal.scaleFactor) || 1
    const H = Number(d.internal.pageSize.getHeight())
    const ops: string[] = []
    for (const sp of subpaths) {
      if (!sp || sp.length < 3) continue
      ops.push(this.n(sp[0][0] * k) + ' ' + this.n((H - sp[0][1]) * k) + ' m')
      for (let i = 1; i < sp.length; i++) ops.push(this.n(sp[i][0] * k) + ' ' + this.n((H - sp[i][1]) * k) + ' l')
      ops.push('h')
    }
    d.saveGraphicsState()
    // an empty clip must still clip everything away, never nothing
    d.internal.write(ops.length ? ops.join('\n') + (evenOdd ? ' W* n' : ' W n') : '0 0 0 0 re W n')
  }
  textAngle (str: string, x: number, y: number, angleDeg: number, halo: [number, number, number] | null, haloWidthPt: number): void {
    const d: any = this.doc
    // jsPDF angles are counter-clockwise in PDF space (y up): the page
    // (y down) clockwise angle is the negation
    const angle = -angleDeg
    if (halo && haloWidthPt > 0) {
      try {
        d.setDrawColor(halo[0], halo[1], halo[2])
        d.setLineWidth(haloWidthPt)
        d.text(str, x, y, { angle, renderingMode: 'stroke' })
      } catch (e) { /* halo best-effort */ }
    }
    d.text(str, x, y, { angle })
  }
  setAlpha (fill: number, stroke: number): void {
    const d: any = this.doc
    try { d.setGState(new d.GState({ opacity: fill, 'stroke-opacity': stroke })) } catch (e) { /* opaque */ }
  }
  setDash (dash: number[] | null): void {
    try { (this.doc as any).setLineDashPattern(dash && dash.length ? dash : [], 0) } catch (e) { /* solid */ }
  }
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
    if (style === 'F' || style === 'FD') { this.ctx.globalAlpha = this.alphaFill; this.ctx.fillStyle = this.fill; this.ctx.fill() }
    if (style === 'S' || style === 'FD') {
      this.ctx.globalAlpha = this.alphaStroke
      this.ctx.strokeStyle = this.stroke
      this.ctx.lineWidth = this.lw * this.s
      this.ctx.stroke()
    }
    this.ctx.globalAlpha = 1
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
    c.globalAlpha = this.alphaStroke
    c.stroke()
    c.globalAlpha = 1
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
    this.ctx.setLineDash([])
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

  /** Stroke/fill opacity for later shapes (grid lines, hatch). */
  setAlpha (fill: number, stroke: number): void {
    // canvas has one alpha; lines use the stroke value, fills the fill value
    this.alphaFill = Math.max(0, Math.min(1, fill)); this.alphaStroke = Math.max(0, Math.min(1, stroke))
  }
  private alphaFill = 1
  private alphaStroke = 1
  setDash (dash: number[] | null): void {
    this.ctx.setLineDash(dash && dash.length ? dash.map(v => v * this.s) : [])
  }
  textAngle (str: string, x: number, y: number, angleDeg: number, halo: [number, number, number] | null, haloWidthPt: number): void {
    this.applyFont()
    const c = this.ctx
    c.save()
    c.globalAlpha = 1
    c.setLineDash([])
    c.translate(x * this.s, y * this.s)
    c.rotate(angleDeg * Math.PI / 180)
    c.textAlign = 'left'
    c.textBaseline = 'alphabetic'
    if (halo && haloWidthPt > 0) {
      c.lineJoin = 'round'; c.miterLimit = 2
      c.strokeStyle = this.rgb(halo[0], halo[1], halo[2])
      c.lineWidth = haloWidthPt * 2 * this.s
      c.strokeText(str, 0, 0)
    }
    c.fillStyle = this.textColor
    c.fillText(str, 0, 0)
    c.restore()
  }
  private clipDepth = 0
  clipRect (x: number, y: number, w: number, h: number): void {
    this.ctx.save()
    this.ctx.beginPath()
    this.ctx.rect(x * this.s, y * this.s, w * this.s, h * this.s)
    this.ctx.clip()
    this.clipDepth++
  }
  restoreClip (): void {
    if (this.clipDepth <= 0) return
    this.ctx.restore()
    this.clipDepth--
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

  private layersOn = false
  private layerOpen = false
  private layerName = ''
  private readonly layerCounts = new Map<string, number>()
  /** Switch SVG layer groups on (Inkscape and Illustrator read top-level
   *  groups as layers). */
  enableLayers (): boolean { this.layersOn = true; return true }
  beginLayer (name: string): void {
    if (!this.layersOn) return
    if (this.layerOpen && this.layerName === name) return // same layer continues
    this.endLayer()
    this.layerName = name
    const base = 'layer-' + (String(name || 'layer').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'layer')
    const n = (this.layerCounts.get(base) || 0) + 1
    this.layerCounts.set(base, n)
    const id = n === 1 ? base : base + '-' + n
    this.parts.push(`<g id="${id}" inkscape:groupmode="layer" inkscape:label="${esc(name)}">`)
    this.layerOpen = true
  }
  endLayer (): void {
    if (!this.layerOpen) return
    this.parts.push('</g>')
    this.layerOpen = false
  }

  constructor (private readonly pageWPt: number, private readonly pageHPt: number) {
    const c = document.createElement('canvas')
    const ctx = c.getContext('2d')
    if (!ctx) throw new Error('Canvas 2D context unavailable.')
    this.measurer = ctx
    this.parts.push(
      `<rect x="0" y="0" width="${pageWPt}" height="${pageHPt}" fill="#ffffff"/>`
    )
  }

  private fillA = 1
  private strokeA = 1
  private dash: number[] | null = null
  private clipSeq = 0
  private clipDepth = 0
  private styleAttr (style: ShapeStyle): string {
    const f = style === 'S' ? 'none' : this.fill
    const s = style === 'F' ? 'none' : this.stroke
    const sw = style === 'F' ? '' : ` stroke-width="${this.lw}" stroke-linecap="round" stroke-linejoin="round"`
    const fo = style !== 'S' && this.fillA < 1 ? ` fill-opacity="${+this.fillA.toFixed(3)}"` : ''
    const so = style !== 'F' && this.strokeA < 1 ? ` stroke-opacity="${+this.strokeA.toFixed(3)}"` : ''
    const da = style !== 'F' && this.dash && this.dash.length ? ` stroke-dasharray="${this.dash.map(v => +v.toFixed(2)).join(' ')}"` : ''
    return `fill="${f}" stroke="${s}"${sw}${fo}${so}${da}`
  }
  setAlpha (fill: number, stroke: number): void { this.fillA = fill; this.strokeA = stroke }
  setDash (dash: number[] | null): void { this.dash = dash && dash.length ? dash.slice() : null }
  path (subpaths: Array<Array<[number, number]>>, closed: boolean, style: ShapeStyle, evenOdd = false): void {
    const r = (v: number): string => (Math.round(v * 100) / 100).toString()
    let dstr = ''
    for (const sp of subpaths) {
      if (!sp || sp.length < 2) continue
      dstr += 'M' + r(sp[0][0]) + ' ' + r(sp[0][1])
      for (let i = 1; i < sp.length; i++) dstr += 'L' + r(sp[i][0]) + ' ' + r(sp[i][1])
      if (closed) dstr += 'Z'
    }
    if (!dstr) return
    this.parts.push(`<path d="${dstr}"${evenOdd ? ' fill-rule="evenodd"' : ''} ${this.styleAttr(style)}/>`)
  }
  clipRect (x: number, y: number, w: number, h: number): void {
    const id = 'pa-clip-' + (++this.clipSeq)
    this.parts.push(`<clipPath id="${id}"><rect x="${x}" y="${y}" width="${w}" height="${h}"/></clipPath><g clip-path="url(#${id})">`)
    this.clipDepth++
  }
  clipPath (subpaths: Array<Array<[number, number]>>, evenOdd = true): void {
    const r = (v: number): string => (Math.round(v * 100) / 100).toString()
    let dstr = ''
    for (const sp of subpaths) {
      if (!sp || sp.length < 3) continue
      dstr += 'M' + r(sp[0][0]) + ' ' + r(sp[0][1])
      for (let i = 1; i < sp.length; i++) dstr += 'L' + r(sp[i][0]) + ' ' + r(sp[i][1])
      dstr += 'Z'
    }
    const id = 'pa-clip-' + (++this.clipSeq)
    this.parts.push(`<clipPath id="${id}"><path d="${dstr || 'M0 0Z'}"${evenOdd ? ' clip-rule="evenodd"' : ''}/></clipPath><g clip-path="url(#${id})">`)
    this.clipDepth++
  }
  textAngle (str: string, x: number, y: number, angleDeg: number, halo: [number, number, number] | null, haloWidthPt: number): void {
    const weight = this.font === 'bold' ? ' font-weight="bold"' : ''
    const styleAttr = this.font === 'italic' ? ' font-style="italic"' : ''
    const haloAttr = halo && haloWidthPt > 0
      ? ` stroke="rgb(${halo[0]},${halo[1]},${halo[2]})" stroke-width="${haloWidthPt * 2}" stroke-linejoin="round" style="paint-order:stroke"`
      : ''
    this.parts.push(
      `<text x="${x}" y="${y}" transform="rotate(${+angleDeg.toFixed(3)} ${x} ${y})" font-family='${this.cssFamily()}' font-size="${this.fontSize}"` +
      `${weight}${styleAttr} fill="${this.textColor}"${haloAttr}>${esc(str)}</text>`
    )
  }
  restoreClip (): void {
    if (this.clipDepth <= 0) return
    this.parts.push('</g>')
    this.clipDepth--
    this.fillA = 1; this.strokeA = 1; this.dash = null
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
    const so = this.strokeA < 1 ? ` stroke-opacity="${+this.strokeA.toFixed(3)}"` : ''
    const da = this.dash && this.dash.length ? ` stroke-dasharray="${this.dash.map(v => +v.toFixed(2)).join(' ')}"` : ''
    this.parts.push(`<line x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}" stroke="${this.stroke}" stroke-width="${this.lw}" stroke-linecap="round" stroke-linejoin="round"${so}${da}/>`)
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
    this.endLayer()
    return `<?xml version="1.0" encoding="UTF-8"?>\n` +
      `<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" ` +
      `xmlns:inkscape="http://www.inkscape.org/namespaces/inkscape" ` +
      `width="${this.pageWPt}pt" height="${this.pageHPt}pt" viewBox="0 0 ${this.pageWPt} ${this.pageHPt}">\n` +
      this.parts.join('\n') + '\n</svg>'
  }
}
