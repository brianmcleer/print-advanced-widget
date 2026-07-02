/**
 * print-advanced render engine (pagx-driven, multi-format).
 *
 * Layouts are imported from ArcGIS Pro .pagx files in settings (see
 * pagxParser.ts) and stored as an element list. composePage renders that list
 * against a Drawer backend, so the SAME Pro layout reproduces in every format:
 *   PDF          -> PdfDrawer (vector furniture + raster map)
 *   SVG / SVGZ   -> SvgDrawer (vector furniture + raster map)
 *   PNG32 / PNG8 / JPG / GIF / TIFF / EPS -> CanvasDrawer (full-page raster)
 *
 * Hard-won notes baked in:
 *  - The temp MapView shares the live WebMap: null .map and .container before
 *    destroy(), or the live map dies with it. Do not "simplify" that block.
 *  - Wait for !view.updating via reactiveUtils, then a short settle delay.
 *  - Capture is capped (WebGL); effective DPI is reduced and reported honestly.
 */
import MapView from 'esri/views/MapView'
import SpatialReference from 'esri/geometry/SpatialReference'
import { metersPerMapUnit, extentFitScale, resolvePrintedScale, PrintScaleMode } from './scaleMath'
import * as reactiveUtils from 'esri/core/reactiveUtils'
import * as symbolUtils from 'esri/symbols/support/symbolUtils'
import { jsPDF } from 'jspdf'
import {
  PrintLayout, ScaleBarUnits, ScaleBarStyle, NorthArrowStyle, FontFamily, LayoutElement,
  TextEl, ScaleBarEl, LegendEl, MapFrameEl, PictureEl, NorthArrowEl, LineEl
} from '../../config'
import { Drawer, PdfDrawer, CanvasDrawer, SvgDrawer, splitText } from './drawing'

/* eslint-disable @typescript-eslint/no-var-requires */
const UPNG = require('upng-js')
const UTIF = require('utif')
const gifenc = require('gifenc')
/* eslint-enable @typescript-eslint/no-var-requires */

export type OutputFormat = 'pdf' | 'png32' | 'png8' | 'jpg' | 'gif' | 'eps' | 'svg' | 'svgz' | 'aix' | 'tiff'

export const FORMAT_LABELS: Array<{ value: OutputFormat, label: string, disabled?: boolean }> = [
  { value: 'pdf', label: 'Portable Document Format (PDF)' },
  { value: 'png32', label: '32-bit Portable Network Graphics (PNG32)' },
  { value: 'png8', label: '8-bit Portable Network Graphics (PNG8)' },
  { value: 'jpg', label: 'Joint Photographic Experts Group (JPG)' },
  { value: 'gif', label: 'Graphics Interchange Format (GIF)' },
  { value: 'eps', label: 'Encapsulated PostScript (EPS)' },
  { value: 'svg', label: 'Scalable Vector Graphics (SVG)' },
  { value: 'svgz', label: 'Compressed Scalable Vector Graphics (SVGZ)' },
  { value: 'aix', label: 'Adobe Illustrator Exchange (AIX)', disabled: true },
  { value: 'tiff', label: 'Tag Image File Format (TIFF)' }
]

/** Runtime overrides the end user can pick per export (defaults from pagx). */
export interface RenderOptions {
  northArrowStyle?: NorthArrowStyle
  scaleBarStyle?: ScaleBarStyle
  scaleBarUnits?: ScaleBarUnits
  /** Second unit -> renders a Pro-style dual scale bar (upper/lower). */
  scaleBarUnits2?: ScaleBarUnits
  /** Widget-level logo dataURL; used by picture elements without their own image. */
  defaultLogo?: string
  /** Page-wide typeface for all text elements and labels. */
  fontFamily?: FontFamily
  /** Custom font fetched by URL at export time (TTF). Overrides fontFamily. */
  customFont?: { name: string, url: string, boldUrl?: string }
  scaleMode?: PrintScaleMode
  fixedScale?: number
  lockedCenter?: { x: number, y: number }
  author?: string
  copyright?: string
  attribution?: string
  includeLegend?: boolean
  mapOnly?: boolean
  /** MAP_ONLY explicit output size in pixels (matches TemplateOptions width/height). */
  mapOnlyWidth?: number
  mapOnlyHeight?: number
  /** Output coordinate system WKID; map is re-rendered in this SR client-side. */
  outputWkid?: number
}

export const FONT_FAMILIES: Array<{ value: FontFamily, label: string }> = [
  { value: 'sans', label: 'Sans-serif (Helvetica / Arial)' },
  { value: 'serif', label: 'Serif (Times)' },
  { value: 'mono', label: 'Monospace (Courier)' }
]

export const NORTH_ARROW_STYLES: Array<{ value: NorthArrowStyle, label: string }> = [
  { value: 'splitArrow', label: 'Split arrow' },
  { value: 'solidTriangle', label: 'Solid triangle' },
  { value: 'outlineArrow', label: 'Outline triangle' },
  { value: 'needle', label: 'Needle' },
  { value: 'simpleArrow', label: 'Simple arrow' },
  { value: 'chevron', label: 'Chevron' },
  { value: 'meridian', label: 'Meridian' },
  { value: 'compassStar', label: 'Compass star' },
  { value: 'compassRose', label: 'Compass rose' },
  { value: 'starburst', label: 'Starburst' },
  { value: 'circledArrow', label: 'Circled arrow' },
  { value: 'filledCircleArrow', label: 'Filled circle' }
]

export const SCALE_BAR_STYLES: Array<{ value: ScaleBarStyle, label: string }> = [
  { value: 'alternating', label: 'Alternating' },
  { value: 'doubleAlternating', label: 'Double alternating' },
  { value: 'hollow', label: 'Hollow' },
  { value: 'hollowDouble', label: 'Double hollow' },
  { value: 'singleDivision', label: 'Single division' },
  { value: 'line', label: 'Line' },
  { value: 'scaleLine', label: 'Scale line' },
  { value: 'steppedLine', label: 'Stepped line' },
  { value: 'steppedFilled', label: 'Stepped filled' }
]

export const SCALE_BAR_UNITS: Array<{ value: ScaleBarUnits, label: string }> = [
  { value: 'feet', label: 'Feet' },
  { value: 'miles', label: 'Miles' },
  { value: 'meters', label: 'Meters' },
  { value: 'kilometers', label: 'Kilometers' }
]

export interface RenderProgress { (message: string): void }

export interface RenderResult {
  fileName: string
  effectiveDpi: number
  printedScale: number
  url?: string
  sizeKb?: number
}

interface LegendRow {
  kind: 'layer' | 'item'
  label: string
  dataUrl?: string | null
}

const PT_PER_IN = 72
const METERS_PER_UNIT: Record<ScaleBarUnits, number> = {
  feet: 0.3048, miles: 1609.344, meters: 1, kilometers: 1000
}
const UNIT_LABEL: Record<ScaleBarUnits, string> = {
  feet: 'Feet', miles: 'Miles', meters: 'Meters', kilometers: 'Kilometers'
}
/** inches of ground per inch of page -> value in unit (per printedScale inch). */
const INCHES_PER_UNIT: Record<string, number> = {
  in: 1, ft: 12, yd: 36, mi: 63360, m: 39.3700787, km: 39370.0787
}

/* ------------------------------------------------------------------ */
/* helpers                                                             */
/* ------------------------------------------------------------------ */

function fmtNumber (n: number, decimals = 0): string {
  const fixed = n.toFixed(decimals)
  const parts = fixed.split('.')
  parts[0] = parts[0].replace(/\B(?=(\d{3})+(?!\d))/g, ',')
  return parts.join('.')
}

function today (): string {
  // Pro renders <dyn type="date" format=""/> as the short date (7/1/2026).
  return new Date().toLocaleDateString('en-US')
}

/** Replace runtime tokens produced by the pagx importer. */
interface TextTokens { title: string, printedScale: number, author?: string, copyright?: string, attribution?: string }

function replaceTokens (tpl: string, tk: TextTokens): string {
  return (tpl || '')
    .replace(/\{title\}/g, tk.title || '')
    .replace(/\{author\}/g, tk.author || '')
    .replace(/\{copyright\}/g, tk.copyright || '')
    .replace(/\{attribution\}/g, tk.attribution || '')
    .replace(/\{date\}/g, today())
    .replace(/\{scale\}/g, fmtNumber(tk.printedScale))
    .replace(/\{scaleRatio:(\w+):(\d+)\}/g, (_m, unit: string, dp: string) => {
      const per = INCHES_PER_UNIT[unit] || 12
      return fmtNumber(tk.printedScale / per, parseInt(dp, 10) || 0)
    })
}

function niceBarDistance (printedScale: number, units: ScaleBarUnits, maxIn: number): { dist: number, barIn: number } {
  const mpu = METERS_PER_UNIT[units]
  const maxGround = (maxIn * 0.0254 * printedScale) / mpu
  const pow = Math.pow(10, Math.floor(Math.log10(Math.max(maxGround, 1e-6))))
  let best = pow
  for (const mult of [1, 2, 2.5, 3, 4, 5, 10]) {
    if (mult * pow <= maxGround) best = mult * pow
  }
  const barIn = (best * mpu) / (0.0254 * printedScale)
  return { dist: best, barIn }
}

function downloadBlob (blob: Blob, fileName: string): string {
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = fileName
  document.body.appendChild(a)
  a.click()
  a.remove()
  // URL kept alive for the session so the results list can re-download it.
  return url
}

// No explicit return annotation: TS 5.7 widens a declared `Uint8Array` to
// Uint8Array<ArrayBufferLike> (incl. SharedArrayBuffer), which Blob rejects.
// Inference from the constructor yields Uint8Array<ArrayBuffer>, Blob-safe.
function dataUrlToBytes (dataUrl: string) {
  const b64 = dataUrl.substring(dataUrl.indexOf(',') + 1)
  const bin = atob(b64)
  const out = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i)
  return out
}

/* ------------------------------------------------------------------ */
/* offscreen high-resolution map capture                               */
/* ------------------------------------------------------------------ */

interface CaptureResult {
  dataUrl: string
  widthPx: number
  heightPx: number
  printedScale: number
  effectiveDpi: number
  rotation: number
}

export async function captureMapHiRes (
  liveView: MapView,
  frameWIn: number,
  frameHIn: number,
  layout: PrintLayout,
  maxImagePx: number,
  opts: RenderOptions,
  onProgress: RenderProgress
): Promise<CaptureResult> {
  let capW = Math.round(frameWIn * layout.dpi)
  let capH = Math.round(frameHIn * layout.dpi)
  const maxDim = Math.max(capW, capH)
  if (maxDim > maxImagePx) {
    const s = maxImagePx / maxDim
    capW = Math.round(capW * s)
    capH = Math.round(capH * s)
  }
  const effectiveDpi = capW / frameWIn

  const mpuLive = metersPerMapUnit(liveView.scale, liveView.resolution)
  const ext = liveView.extent
  const fitScale = extentFitScale(ext.width, ext.height, mpuLive, frameWIn, frameHIn, capW, capH)
  const mode: PrintScaleMode = opts.scaleMode || (layout.preserve === 'extent' ? 'preserveExtent' : 'current')
  const printedScale = resolvePrintedScale(mode, liveView.scale, opts.fixedScale, fitScale)

  const viewScale = printedScale * (96 / effectiveDpi)

  const center = liveView.center.clone()
  if (opts.lockedCenter && typeof opts.lockedCenter.x === 'number') {
    center.x = opts.lockedCenter.x
    center.y = opts.lockedCenter.y
  }

  const container = document.createElement('div')
  container.style.cssText =
    'position:absolute;left:-99999px;top:0;width:' + capW + 'px;height:' + capH + 'px;overflow:hidden;'
  document.body.appendChild(container)

  let tmp: MapView | null = null
  try {
    onProgress('Rendering map at ' + Math.round(effectiveDpi) + ' DPI…')
    const outSR = (opts.outputWkid && opts.outputWkid > 0)
      ? new SpatialReference({ wkid: opts.outputWkid })
      : liveView.spatialReference
    tmp = new MapView({
      container,
      map: liveView.map,
      spatialReference: outSR,
      center, // Point in the live view's SR; the view projects it on load
      scale: viewScale,
      rotation: liveView.rotation,
      ui: { components: [] } as any,
      constraints: { snapToZoom: false, rotationEnabled: true } as any,
      popupEnabled: false
    } as any)

    await tmp.when()
    await Promise.race([
      reactiveUtils.whenOnce(() => !!tmp && !tmp.updating),
      new Promise(resolve => setTimeout(resolve, 45000))
    ])
    await new Promise(resolve => setTimeout(resolve, 600))

    onProgress('Capturing map image…')
    const shot = await tmp.takeScreenshot({
      width: capW,
      height: capH,
      format: layout.imageFormat === 'png' ? 'png' : 'jpg',
      quality: 95
    } as any)

    return {
      dataUrl: shot.dataUrl,
      widthPx: capW,
      heightPx: capH,
      printedScale,
      effectiveDpi,
      rotation: liveView.rotation || 0
    }
  } finally {
    // CRITICAL: temp view shares the live WebMap - detach before destroy.
    if (tmp) {
      try {
        (tmp as any).map = null
        ;(tmp as any).container = null
        tmp.destroy()
      } catch (e) { /* ignore */ }
    }
    container.remove()
  }
}

/* ------------------------------------------------------------------ */
/* legend extraction (client-side)                                     */
/* ------------------------------------------------------------------ */

async function symbolToDataUrl (symbol: any): Promise<string | null> {
  try {
    const el: HTMLElement = await (symbolUtils as any).renderPreviewHTML(symbol, { size: 18 })
    if (!el) return null
    const canvas = el instanceof HTMLCanvasElement ? el : el.querySelector('canvas')
    if (canvas) return (canvas as HTMLCanvasElement).toDataURL('image/png')
    const svg = el instanceof SVGElement ? el : el.querySelector('svg')
    if (svg) {
      const xml = new XMLSerializer().serializeToString(svg)
      const url = 'data:image/svg+xml;base64,' + btoa(unescape(encodeURIComponent(xml)))
      return await new Promise<string | null>((resolve) => {
        const img = new Image()
        img.onload = () => {
          try {
            const c = document.createElement('canvas')
            c.width = img.width || 36
            c.height = img.height || 36
            c.getContext('2d')?.drawImage(img, 0, 0)
            resolve(c.toDataURL('image/png'))
          } catch (e) { resolve(null) }
        }
        img.onerror = () => resolve(null)
        img.src = url
      })
    }
    const image = el.querySelector('img')
    if (image && image.src) return image.src
    return null
  } catch (e) {
    return null
  }
}

export async function buildLegendRows (view: MapView, maxItems: number, onProgress: RenderProgress): Promise<LegendRow[]> {
  const rows: LegendRow[] = []
  let count = 0
  try {
    onProgress('Building legend…')
    const layers = view.map.allLayers
      .filter((l: any) => l.visible && l.type === 'feature' && l.listMode !== 'hide')
      .toArray() as any[]

    for (const layer of layers) {
      if (count >= maxItems) break
      try {
        if (!layer.loaded && layer.load) await layer.load()
        const renderer = layer.renderer
        if (!renderer) continue
        rows.push({ kind: 'layer', label: layer.title || 'Layer' })

        if (renderer.type === 'simple' && renderer.symbol) {
          rows.push({ kind: 'item', label: '', dataUrl: await symbolToDataUrl(renderer.symbol) })
          count++
        } else if (renderer.type === 'unique-value') {
          for (const info of (renderer.uniqueValueInfos || [])) {
            if (count >= maxItems) break
            rows.push({ kind: 'item', label: info.label || String(info.value ?? ''), dataUrl: await symbolToDataUrl(info.symbol) })
            count++
          }
        } else if (renderer.type === 'class-breaks') {
          for (const info of (renderer.classBreakInfos || [])) {
            if (count >= maxItems) break
            rows.push({ kind: 'item', label: info.label || (info.minValue + ' to ' + info.maxValue), dataUrl: await symbolToDataUrl(info.symbol) })
            count++
          }
        } else {
          rows.push({ kind: 'item', label: '(symbology not supported)', dataUrl: null })
          count++
        }
      } catch (e) { /* one bad layer never kills the export */ }
    }
  } catch (e) { /* legend is best-effort */ }
  return rows
}

/* ------------------------------------------------------------------ */
/* element renderers (backend-agnostic, coordinates in points)         */
/* ------------------------------------------------------------------ */

function drawNorthArrowEl (d: Drawer, el: NorthArrowEl, rotationDeg: number, style: NorthArrowStyle = 'splitArrow'): void {
  // Pro's ESRI North glyph fills the element frame HEIGHT (N on top, arrow
  // below). Compose ours the same way: N ~26% of height, arrow the rest.
  const cx = (el.xIn + el.wIn / 2) * PT_PER_IN
  const H = el.hIn * PT_PER_IN
  const W = el.wIn * PT_PER_IN
  const topY = el.yIn * PT_PER_IN

  // Layout the "N" + arrow to fill the frame with even padding, vertically centered.
  const pad = Math.min(H, W) * 0.06
  const nSize = Math.max(7, Math.min(H * 0.24, W * 0.5))
  const gap = nSize * 0.25
  const arrowH = Math.max(4, H - pad * 2 - nSize - gap)
  const arrowHalfW = Math.min((W - pad * 2) / 2, arrowH * 0.34)
  const acx = cx
  const nBaseline = topY + pad + nSize
  const acy = nBaseline + gap + arrowH / 2

  const theta = (rotationDeg * Math.PI) / 180
  const rot = (x: number, y: number): [number, number] => [
    acx + x * Math.cos(theta) - y * Math.sin(theta),
    acy + x * Math.sin(theta) + y * Math.cos(theta)
  ]

  const halfH = arrowH / 2
  const tip = rot(0, -halfH)
  const baseL = rot(-arrowHalfW, halfH)
  const baseR = rot(arrowHalfW, halfH)
  const notch = rot(0, halfH * 0.45)

  d.setStroke(30, 30, 30)
  d.setLineWidth(0.6)

  switch (style) {
    case 'solidTriangle': {
      d.setFill(30, 30, 30)
      d.triangle(tip[0], tip[1], baseL[0], baseL[1], baseR[0], baseR[1], 'F')
      break
    }
    case 'needle': {
      // slender split needle, classic dark-left/light-right
      const nL = rot(-arrowHalfW * 0.45, halfH)
      const nR = rot(arrowHalfW * 0.45, halfH)
      const foot = rot(0, halfH * 0.8)
      d.setFill(30, 30, 30)
      d.triangle(tip[0], tip[1], foot[0], foot[1], nL[0], nL[1], 'F')
      d.setFill(255, 255, 255)
      d.triangle(tip[0], tip[1], foot[0], foot[1], nR[0], nR[1], 'FD')
      break
    }
    case 'compassStar': {
      // 4-point star: long N-S points, short E-W points, alternating fills
      const s = halfH
      const w = Math.min(arrowHalfW, s * 0.4)
      const N = rot(0, -s); const S = rot(0, s)
      const E = rot(w * 1.6, 0); const Wp = rot(-w * 1.6, 0)
      const ne = rot(w * 0.35, -w * 0.35); const se = rot(w * 0.35, w * 0.35)
      const sw = rot(-w * 0.35, w * 0.35); const nw = rot(-w * 0.35, -w * 0.35)
      const c: [number, number] = [acx, acy]
      d.setFill(30, 30, 30)
      d.triangle(N[0], N[1], c[0], c[1], ne[0], ne[1], 'F')
      d.triangle(S[0], S[1], c[0], c[1], sw[0], sw[1], 'F')
      d.triangle(E[0], E[1], c[0], c[1], se[0], se[1], 'F')
      d.triangle(Wp[0], Wp[1], c[0], c[1], nw[0], nw[1], 'F')
      d.setFill(255, 255, 255)
      d.triangle(N[0], N[1], c[0], c[1], nw[0], nw[1], 'FD')
      d.triangle(S[0], S[1], c[0], c[1], se[0], se[1], 'FD')
      d.triangle(E[0], E[1], c[0], c[1], ne[0], ne[1], 'FD')
      d.triangle(Wp[0], Wp[1], c[0], c[1], sw[0], sw[1], 'FD')
      break
    }
    case 'circledArrow': {
      d.setFill(255, 255, 255)
      d.setLineWidth(0.9)
      d.circle(acx, acy, halfH, 'FD')
      const t2 = rot(0, -halfH * 0.8)
      const l2 = rot(-arrowHalfW * 0.8, halfH * 0.7)
      const r2 = rot(arrowHalfW * 0.8, halfH * 0.7)
      const k2 = rot(0, halfH * 0.35)
      d.setFill(30, 30, 30)
      d.triangle(t2[0], t2[1], k2[0], k2[1], l2[0], l2[1], 'F')
      d.setFill(255, 255, 255)
      d.setLineWidth(0.6)
      d.triangle(t2[0], t2[1], k2[0], k2[1], r2[0], r2[1], 'FD')
      break
    }
    case 'outlineArrow': {
      d.setFill(255, 255, 255)
      d.triangle(tip[0], tip[1], baseL[0], baseL[1], baseR[0], baseR[1], 'FD')
      break
    }
    case 'simpleArrow': {
      const hbY = -halfH + arrowHalfW * 1.3
      const hl = rot(-arrowHalfW, hbY); const hr = rot(arrowHalfW, hbY)
      const sTop = rot(0, hbY); const sBot = rot(0, halfH)
      d.setLineWidth(1.3)
      d.line(sTop[0], sTop[1], sBot[0], sBot[1])
      d.setFill(30, 30, 30)
      d.triangle(tip[0], tip[1], hl[0], hl[1], hr[0], hr[1], 'F')
      break
    }
    case 'chevron': {
      const cy2 = -halfH + arrowHalfW * 1.7
      const cl = rot(-arrowHalfW, cy2); const cr = rot(arrowHalfW, cy2)
      d.setLineWidth(1.6)
      d.line(tip[0], tip[1], cl[0], cl[1])
      d.line(tip[0], tip[1], cr[0], cr[1])
      break
    }
    case 'meridian': {
      const sTop = rot(0, -halfH * 0.5); const sBot = rot(0, halfH)
      d.setLineWidth(1)
      d.line(sTop[0], sTop[1], sBot[0], sBot[1])
      const tl = rot(-arrowHalfW * 0.5, -halfH * 0.5); const tr = rot(arrowHalfW * 0.5, -halfH * 0.5)
      d.setFill(30, 30, 30)
      d.triangle(tip[0], tip[1], tl[0], tl[1], tr[0], tr[1], 'F')
      const dot = rot(0, halfH)
      d.circle(dot[0], dot[1], 1.4, 'F')
      break
    }
    case 'compassRose':
    case 'starburst': {
      const rose = style === 'compassRose'
      const Rlong = halfH
      const Rshort = rose ? halfH * 0.45 : halfH * 0.62
      const inner = halfH * 0.13
      const pt = (a: number, r: number): [number, number] => {
        let px = acx + Math.sin(a) * r
        const dx = Math.max(-arrowHalfW * 1.6, Math.min(arrowHalfW * 1.6, px - acx))
        px = acx + dx
        return [px, acy - Math.cos(a) * r]
      }
      for (let k = 0; k < 8; k++) {
        const a = theta + (k * Math.PI) / 4
        const R = (k % 2 === 0) ? Rlong : Rshort
        const tp = pt(a, R)
        const b1 = pt(a + Math.PI / 2, inner)
        const b2 = pt(a - Math.PI / 2, inner)
        if (rose && k % 2 === 1) d.setFill(255, 255, 255); else d.setFill(30, 30, 30)
        d.triangle(tp[0], tp[1], b1[0], b1[1], b2[0], b2[1], rose ? 'FD' : 'F')
      }
      break
    }
    case 'filledCircleArrow': {
      d.setFill(30, 30, 30)
      d.circle(acx, acy, halfH, 'F')
      const t2 = rot(0, -halfH * 0.62)
      const l2 = rot(-arrowHalfW * 0.7, halfH * 0.28)
      const r2 = rot(arrowHalfW * 0.7, halfH * 0.28)
      d.setFill(255, 255, 255)
      d.triangle(t2[0], t2[1], l2[0], l2[1], r2[0], r2[1], 'F')
      break
    }
    default: { // splitArrow
      d.setFill(30, 30, 30)
      d.triangle(tip[0], tip[1], notch[0], notch[1], baseL[0], baseL[1], 'F')
      d.setFill(255, 255, 255)
      d.triangle(tip[0], tip[1], notch[0], notch[1], baseR[0], baseR[1], 'FD')
    }
  }

  d.setFont('bold', nSize)
  d.setTextColor(30, 30, 30)
  d.text('N', cx, nBaseline, 'center')
}

/**
 * Scale bar engine: renders any Pro structural style inside the pagx frame,
 * with optional dual (upper/lower unit) mode. Placement is Pro-calibrated
 * (labels 5pt above the bar; unit label baseline at the bar bottom).
 */
function drawBarOfStyle (
  d: Drawer, style: ScaleBarStyle, x: number, top: number, barPt: number, barH: number,
  segments: number, c1: [number, number, number], c2: [number, number, number]
): void {
  const segPt = barPt / Math.max(1, segments)
  const [r1, g1, b1] = c1
  const [r2, g2, b2] = c2
  d.setStroke(30, 30, 30)
  d.setLineWidth(0.5)

  switch (style) {
    case 'alternating': {
      for (let i = 0; i < segments; i++) {
        d.setFill(i % 2 === 0 ? r1 : r2, i % 2 === 0 ? g1 : g2, i % 2 === 0 ? b1 : b2)
        d.rect(x + i * segPt, top, segPt, barH, 'FD')
      }
      break
    }
    case 'singleDivision': {
      d.setFill(r1, g1, b1)
      d.rect(x, top, barPt, barH, 'FD')
      break
    }
    case 'hollow': {
      d.setFill(255, 255, 255)
      d.rect(x, top, barPt, barH, 'FD')
      d.line(x, top + barH / 2, x + barPt, top + barH / 2)
      for (let i = 1; i < segments; i++) d.line(x + i * segPt, top, x + i * segPt, top + barH)
      break
    }
    case 'scaleLine': {
      d.setLineWidth(1.2)
      d.line(x, top + barH, x + barPt, top + barH)
      for (let i = 0; i <= segments; i++) {
        d.line(x + i * segPt, top, x + i * segPt, top + barH)
      }
      break
    }
    case 'steppedLine': {
      d.setLineWidth(1.2)
      for (let i = 0; i < segments; i++) {
        const yA = i % 2 === 0 ? top + barH : top
        const yB = i % 2 === 0 ? top : top + barH
        d.line(x + i * segPt, yA, x + (i + 1) * segPt, yA)
        d.line(x + (i + 1) * segPt, yA, x + (i + 1) * segPt, yB)
      }
      break
    }
    case 'hollowDouble': {
      const rowH = barH / 2
      d.setFill(255, 255, 255)
      d.rect(x, top, barPt, rowH, 'FD')
      d.rect(x, top + rowH, barPt, rowH, 'FD')
      for (let i = 1; i < segments; i++) d.line(x + i * segPt, top, x + i * segPt, top + barH)
      break
    }
    case 'line': {
      d.setLineWidth(1.2)
      d.line(x, top, x + barPt, top)
      for (let i = 0; i <= segments; i++) d.line(x + i * segPt, top, x + i * segPt, top + barH)
      break
    }
    case 'steppedFilled': {
      for (let i = 0; i < segments; i++) {
        const h = barH * (1 - (i / Math.max(1, segments)) * 0.6)
        d.setFill(i % 2 === 0 ? r1 : r2, i % 2 === 0 ? g1 : g2, i % 2 === 0 ? b1 : b2)
        d.rect(x + i * segPt, top + (barH - h), segPt, h, 'FD')
      }
      break
    }
    default: { // doubleAlternating (checkerboard, two rows)
      const rowH = barH / 2
      for (let i = 0; i < segments; i++) {
        d.setFill(i % 2 === 0 ? r1 : r2, i % 2 === 0 ? g1 : g2, i % 2 === 0 ? b1 : b2)
        d.rect(x + i * segPt, top, segPt, rowH, 'FD')
        d.setFill(i % 2 === 0 ? r2 : r1, i % 2 === 0 ? g2 : g1, i % 2 === 0 ? b2 : b1)
        d.rect(x + i * segPt, top + rowH, segPt, rowH, 'FD')
      }
    }
  }
}

function drawScaleBarEl (d: Drawer, el: ScaleBarEl, printedScale: number, opts: RenderOptions): void {
  const boxX = el.xIn * PT_PER_IN
  const boxY = el.yIn * PT_PER_IN
  const boxW = el.wIn * PT_PER_IN
  const boxH = el.hIn * PT_PER_IN

  const style: ScaleBarStyle = opts.scaleBarStyle || el.style || 'doubleAlternating'
  const units: ScaleBarUnits = opts.scaleBarUnits || el.units
  const units2 = opts.scaleBarUnits2 && opts.scaleBarUnits2 !== units ? opts.scaleBarUnits2 : undefined

  const segments = Math.max(1, el.divisions) * Math.max(1, el.subdivisions)
  const labelSize = Math.min(el.labelSizePt || 8, boxH * 0.45)
  const unitSize = el.unitLabelSizePt || Math.max(el.labelSizePt || 8, 10)
  const fmt = (v: number): string => (v >= 1000 ? fmtNumber(v) : String(Math.round(v * 100) / 100))
  const midLabels = style !== 'singleDivision' && (el.subdivisions > 1 || el.divisions > 1)
  // Rough glyph-width estimate (pt) so nothing overflows the frame on either side.
  const textW = (s: string, sz: number): number => s.length * sz * 0.55

  if (!units2) {
    const barH = Math.max(3, Math.min(el.barHeightPt || 8, boxH * 0.45))
    const labelGap = Math.max(3, labelSize * 0.4)
    // Vertically centre the [numbers row | bar] group within the frame.
    const groupH = labelSize + labelGap + barH
    const groupTop = boxY + Math.max(0, (boxH - groupH) / 2)
    const labelBaseline = groupTop + labelSize
    const barTop = groupTop + labelSize + labelGap

    // Reserve space so a centred "0" fits on the left and the unit label fits on the right.
    const unitStr = UNIT_LABEL[units]
    const leftInset = labelSize * 0.35
    const unitReserve = textW(unitStr, unitSize) + 8
    const availIn = Math.max(0.2, (boxW - leftInset - unitReserve) / PT_PER_IN)
    const { dist, barIn } = niceBarDistance(printedScale, units, availIn)
    const barPt = barIn * PT_PER_IN
    const x0 = boxX + leftInset

    drawBarOfStyle(d, style, x0, barTop, barPt, barH, segments, el.color1, el.color2)

    d.setFont('normal', labelSize)
    d.setTextColor(30, 30, 30)
    d.text('0', x0, labelBaseline, 'center')
    if (midLabels) d.text(fmt(dist / 2), x0 + barPt / 2, labelBaseline, 'center')
    d.text(fmt(dist), x0 + barPt, labelBaseline, 'center')
    // Unit label: vertically centred on the bar, just right of its end.
    d.setFont('normal', unitSize)
    d.text(unitStr, x0 + barPt + 4, barTop + barH / 2 + unitSize * 0.34, 'left')
    return
  }

  // Dual scale bar (Pro: upper and lower unit sharing the zero point). The whole
  // [upper labels | upper bar | lower bar | lower labels] group is centred in the frame.
  const labelBand = labelSize + 3
  const barH = Math.max(3, Math.min((el.barHeightPt || 8) * 0.75, (boxH - 2 * labelBand) / 2))
  const totalH = 2 * labelBand + 2 * barH
  const top0 = boxY + Math.max(0, (boxH - totalH) / 2)
  const upperTop = top0 + labelBand
  const axis = upperTop + barH

  const dualUnitSize = Math.min(unitSize, labelSize + 2)
  const uStr = UNIT_LABEL[units]
  const u2Str = UNIT_LABEL[units2]
  const leftInset = labelSize * 0.35
  const reserve = Math.max(textW(uStr, dualUnitSize), textW(u2Str, dualUnitSize)) + 8
  const availIn = Math.max(0.2, (boxW - leftInset - reserve) / PT_PER_IN)
  const up = niceBarDistance(printedScale, units, availIn)
  const lo = niceBarDistance(printedScale, units2, availIn)
  const upPt = up.barIn * PT_PER_IN
  const loPt = lo.barIn * PT_PER_IN
  const x0 = boxX + leftInset

  drawBarOfStyle(d, style, x0, upperTop, upPt, barH, segments, el.color1, el.color2)
  drawBarOfStyle(d, style, x0, axis, loPt, barH, segments, el.color2, el.color1)

  d.setTextColor(30, 30, 30)
  d.setFont('normal', labelSize)
  const upY = upperTop - 3
  d.text('0', x0, upY, 'center')
  if (midLabels) d.text(fmt(up.dist / 2), x0 + upPt / 2, upY, 'center')
  d.text(fmt(up.dist), x0 + upPt, upY, 'center')
  const loY = Math.min(axis + barH + labelSize, boxY + boxH - labelSize * 0.2)
  if (midLabels) d.text(fmt(lo.dist / 2), x0 + loPt / 2, loY, 'center')
  d.text(fmt(lo.dist), x0 + loPt, loY, 'center')
  d.setFont('normal', dualUnitSize)
  d.text(uStr, x0 + upPt + 4, upperTop + barH / 2 + dualUnitSize * 0.34, 'left')
  d.text(u2Str, x0 + loPt + 4, axis + barH / 2 + dualUnitSize * 0.34, 'left')
}

function drawTextEl (d: Drawer, el: TextEl, tokens: TextTokens): void {
  const boxX = el.xIn * PT_PER_IN
  const boxY = el.yIn * PT_PER_IN
  const boxW = el.wIn * PT_PER_IN
  const boxH = el.hIn * PT_PER_IN
  const size = el.fontSizePt || 10
  const lineH = size * 1.2

  const weight = el.bold ? 'bold' : el.italic ? 'italic' : 'normal'
  d.setFont(weight as any, size)
  d.setTextColor(el.color[0], el.color[1], el.color[2])

  const resolved = replaceTokens(el.text, tokens)
  const paragraphs = resolved.split(/\r?\n/)
  const lines: string[] = []
  for (const p of paragraphs) {
    if (!p) { lines.push(''); continue }
    // Only wrap when the line overflows; wrapping normalizes internal spacing
    // and Pro preserves it (e.g. "equals  24,389" keeps its double space).
    if (d.textWidth(p) <= boxW) { lines.push(p); continue }
    for (const l of splitText(d, p, Math.max(10, boxW))) lines.push(l)
  }

  const blockH = lines.length * lineH
  // First-baseline offset: full em from the frame top (Pro leads the first
  // line so glyph tops sit ~0.28em inside the frame, clear of any rule that
  // shares the frame edge). Measured against Pro output for valign=Top.
  let firstBaseline: number
  if (el.valign === 'bottom') firstBaseline = boxY + boxH - blockH + lineH - size * 0.2
  else if (el.valign === 'center') firstBaseline = boxY + (boxH - blockH) / 2 + size * 0.98 // Pro-measured: title baseline 53.01 vs 52.98
  else firstBaseline = boxY + size * 1.0

  const tx = el.align === 'center' ? boxX + boxW / 2 : el.align === 'right' ? boxX + boxW : boxX
  let y = firstBaseline
  for (const line of lines) {
    if (line) d.text(line, tx, y, el.align)
    y += lineH
  }
}

async function drawPictureEl (d: Drawer, el: PictureEl, defaultLogo?: string): Promise<void> {
  const x = el.xIn * PT_PER_IN
  const y = el.yIn * PT_PER_IN
  const w = el.wIn * PT_PER_IN
  const h = el.hIn * PT_PER_IN
  const dataUrl = el.dataUrl || defaultLogo
  if (dataUrl) {
    if (el.whiteBg) {
      d.setFill(255, 255, 255)
      d.rect(x, y, w, h, 'F')
    }
    const fmt = /^data:image\/jpe?g/i.test(dataUrl) ? 'JPEG' : 'PNG'
    // contain + element anchor: Pro-measured, BottomLeftCorner pictures sit at
    // the box bottom with the slack at top - never centered, never distorted.
    try {
      await d.image(dataUrl, fmt, x, y, w, h, 'contain', el.anchorH || 'left', el.anchorV || 'bottom')
      return
    } catch (e) { /* fall through */ }
  }
  d.setFill(235, 235, 235)
  d.setStroke(170, 170, 170)
  d.setLineWidth(0.75)
  d.rect(x, y, w, h, 'FD')
  d.setFont('italic', Math.min(8, h * 0.3))
  d.setTextColor(130, 130, 130)
  d.text(el.sourceName || 'image', x + w / 2, y + h / 2 + 3, 'center')
}

async function drawLegendEl (d: Drawer, el: LegendEl, rows: LegendRow[]): Promise<void> {
  const lx = el.xIn * PT_PER_IN
  const ly = el.yIn * PT_PER_IN
  const lw = el.wIn * PT_PER_IN
  const lh = el.hIn * PT_PER_IN

  d.setFill(255, 255, 255)
  d.setStroke(150, 150, 150)
  d.setLineWidth(0.5)
  d.rect(lx, ly, lw, lh, 'FD')

  d.setFont('bold', 10)
  d.setTextColor(30, 30, 30)
  d.text('Legend', lx + 8, ly + 15)

  let cy = ly + 30
  const bottom = ly + lh - 8
  for (const row of rows) {
    if (cy > bottom - 8) {
      d.setFont('italic', 7)
      d.setTextColor(120, 120, 120)
      d.text('…more items not shown', lx + 8, bottom)
      break
    }
    if (row.kind === 'layer') {
      d.setFont('bold', 8)
      d.setTextColor(30, 30, 30)
      d.text(splitText(d, row.label, lw - 16)[0] || '', lx + 8, cy)
      cy += 12
    } else {
      if (row.dataUrl) {
        try { await d.image(row.dataUrl, 'PNG', lx + 11, cy - 7.5, 10, 10) } catch (e) {
          d.setFill(200, 200, 200); d.rect(lx + 11, cy - 7.5, 10, 10, 'F')
        }
      } else {
        d.setFill(200, 200, 200); d.rect(lx + 11, cy - 7.5, 10, 10, 'F')
      }
      d.setFont('normal', 7)
      d.setTextColor(50, 50, 50)
      d.text(splitText(d, row.label || '', lw - 40)[0] || '', lx + 26, cy)
      cy += 12
    }
  }
}

/* ------------------------------------------------------------------ */
/* page composition                                                    */
/* ------------------------------------------------------------------ */

export function getMapFrame (layout: PrintLayout): MapFrameEl {
  const mf = (layout.elements || []).find(e => e.type === 'mapFrame') as MapFrameEl
  if (!mf) throw new Error('Layout has no map frame element. Re-import the .pagx.')
  return mf
}

export async function composePage (
  d: Drawer,
  layout: PrintLayout,
  cap: CaptureResult,
  legendRows: LegendRow[],
  title: string,
  opts: RenderOptions = {}
): Promise<void> {
  const tokens: TextTokens = {
    title, printedScale: cap.printedScale,
    author: opts.author, copyright: opts.copyright, attribution: opts.attribution
  }
  for (const raw of (layout.elements || [])) {
    const el = raw as LayoutElement
    switch (el.type) {
      case 'mapFrame': {
        const mf = el as MapFrameEl
        const x = mf.xIn * PT_PER_IN
        const y = mf.yIn * PT_PER_IN
        const w = mf.wIn * PT_PER_IN
        const h = mf.hIn * PT_PER_IN
        await d.image(cap.dataUrl, layout.imageFormat === 'png' ? 'PNG' : 'JPEG', x, y, w, h)
        if (mf.borderColor && mf.borderWidthPt > 0) {
          d.setStroke(mf.borderColor[0], mf.borderColor[1], mf.borderColor[2])
          d.setLineWidth(mf.borderWidthPt)
          d.rect(x, y, w, h, 'S')
        }
        break
      }
      case 'line': {
        const ln = el as LineEl
        d.setStroke(ln.color[0], ln.color[1], ln.color[2])
        d.setLineWidth(ln.widthPt)
        for (let i = 0; i < ln.points.length - 1; i++) {
          d.line(
            ln.points[i][0] * PT_PER_IN, ln.points[i][1] * PT_PER_IN,
            ln.points[i + 1][0] * PT_PER_IN, ln.points[i + 1][1] * PT_PER_IN
          )
        }
        break
      }
      case 'text':
        drawTextEl(d, el as TextEl, tokens)
        break
      case 'northArrow':
        drawNorthArrowEl(d, el as NorthArrowEl, cap.rotation, opts.northArrowStyle || 'splitArrow')
        break
      case 'scaleBar':
        drawScaleBarEl(d, el as ScaleBarEl, cap.printedScale, opts)
        break
      case 'picture':
        await drawPictureEl(d, el as PictureEl, opts.defaultLogo)
        break
      case 'legend':
        await drawLegendEl(d, el as LegendEl, legendRows)
        break
    }
  }
}

/* ------------------------------------------------------------------ */
/* format encoders                                                     */
/* ------------------------------------------------------------------ */

function canvasRgba (canvas: HTMLCanvasElement): { data: Uint8ClampedArray, w: number, h: number } {
  const ctx = canvas.getContext('2d')
  if (!ctx) throw new Error('Canvas context unavailable.')
  return { data: ctx.getImageData(0, 0, canvas.width, canvas.height).data, w: canvas.width, h: canvas.height }
}

function encodePng8 (canvas: HTMLCanvasElement): Blob {
  const { data, w, h } = canvasRgba(canvas)
  const buf: ArrayBuffer = UPNG.encode([data.buffer], w, h, 256)
  return new Blob([buf], { type: 'image/png' })
}

function encodeTiff (canvas: HTMLCanvasElement): Blob {
  const { data, w, h } = canvasRgba(canvas)
  const buf: ArrayBuffer = UTIF.encodeImage(data.buffer, w, h)
  return new Blob([buf], { type: 'image/tiff' })
}

function encodeGif (canvas: HTMLCanvasElement): Blob {
  const { data, w, h } = canvasRgba(canvas)
  const { quantize, applyPalette, GIFEncoder } = gifenc
  const palette = quantize(data, 256)
  const index = applyPalette(data, palette)
  const gif = GIFEncoder()
  gif.writeFrame(index, w, h, { palette })
  gif.finish()
  return new Blob([gif.bytes()], { type: 'image/gif' })
}

/** Level-2 PostScript EPS with the page embedded as DCTDecode (JPEG). */
function encodeEps (canvas: HTMLCanvasElement, pageWPt: number, pageHPt: number): Blob {
  const jpegBytes = dataUrlToBytes(canvas.toDataURL('image/jpeg', 0.92))
  const w = canvas.width
  const h = canvas.height
  const hexChunks: string[] = []
  let line = ''
  for (let i = 0; i < jpegBytes.length; i++) {
    line += jpegBytes[i].toString(16).padStart(2, '0')
    if (line.length >= 128) { hexChunks.push(line); line = '' }
  }
  if (line) hexChunks.push(line)

  const eps =
    '%!PS-Adobe-3.0 EPSF-3.0\n' +
    '%%BoundingBox: 0 0 ' + Math.ceil(pageWPt) + ' ' + Math.ceil(pageHPt) + '\n' +
    '%%LanguageLevel: 2\n' +
    '%%Creator: print-advanced (City of Grand Junction)\n' +
    '%%EndComments\n' +
    'gsave\n' +
    pageWPt.toFixed(2) + ' ' + pageHPt.toFixed(2) + ' scale\n' +
    '/DeviceRGB setcolorspace\n' +
    '<<\n' +
    '  /ImageType 1\n' +
    '  /Width ' + w + '\n' +
    '  /Height ' + h + '\n' +
    '  /BitsPerComponent 8\n' +
    '  /Decode [0 1 0 1 0 1]\n' +
    '  /ImageMatrix [' + w + ' 0 0 -' + h + ' 0 ' + h + ']\n' +
    '  /DataSource currentfile /ASCIIHexDecode filter /DCTDecode filter\n' +
    '>> image\n' +
    hexChunks.join('\n') + '>\n' +
    'grestore\n' +
    '%%EOF\n'
  return new Blob([eps], { type: 'application/postscript' })
}

async function gzipBlob (text: string): Promise<Blob> {
  const CS: any = (window as any).CompressionStream
  if (!CS) {
    throw new Error('SVGZ requires a browser with CompressionStream (Chrome/Edge 80+). Use SVG instead.')
  }
  const stream = new Blob([text]).stream().pipeThrough(new CS('gzip'))
  return await new Response(stream).blob()
}

/* ------------------------------------------------------------------ */
/* custom font loading (by URL, session-cached, nothing embedded)      */
/* ------------------------------------------------------------------ */

const fontCache = new Map<string, ArrayBuffer>()
const registeredFaces = new Set<string>()
const pdfB64Cache = new Map<string, string>()

/** Fix common URL mistakes; reject URLs that can never yield a TTF. */
function normalizeFontUrl (url: string): string {
  const u = url.trim()
  // GitHub page URL -> raw file URL
  const gh = u.match(/^https:\/\/github\.com\/([^/]+)\/([^/]+)\/blob\/(.+)$/)
  if (gh) return `https://raw.githubusercontent.com/${gh[1]}/${gh[2]}/${gh[3]}`
  if (/fonts\.googleapis\.com/.test(u)) {
    throw new Error('That is a Google Fonts CSS link, which serves WOFF2 - PDF embedding needs a TTF file. Open the font in the github.com/google/fonts repository and use the Raw URL of the .ttf.')
  }
  if (/fonts\.google\.com/.test(u)) {
    throw new Error('That is a Google Fonts page link, not a font file. Open the font in the github.com/google/fonts repository and use the Raw URL of the .ttf.')
  }
  return u
}

/** Identify what a downloaded buffer actually is by magic number. */
function sniffFont (buf: ArrayBuffer): 'ttf' | 'otf-cff' | 'woff' | 'woff2' | 'text' | 'unknown' {
  if (buf.byteLength < 4) return 'unknown'
  const b = new Uint8Array(buf, 0, 4)
  const tag = String.fromCharCode(b[0], b[1], b[2], b[3])
  if (b[0] === 0x00 && b[1] === 0x01 && b[2] === 0x00 && b[3] === 0x00) return 'ttf'
  if (tag === 'true' || tag === 'ttcf') return 'ttf'
  if (tag === 'OTTO') return 'otf-cff'
  if (tag === 'wOFF') return 'woff'
  if (tag === 'wOF2') return 'woff2'
  if (b[0] === 0x3c || b[0] === 0x7b) return 'text' // '<' html or '{' json
  return 'unknown'
}

async function fetchFontBuffer (rawUrl: string): Promise<ArrayBuffer> {
  const url = normalizeFontUrl(rawUrl)
  const hit = fontCache.get(url)
  if (hit) return hit
  const resp = await fetch(url, { mode: 'cors' })
  if (!resp.ok) throw new Error('Font download failed (' + resp.status + '): ' + url)
  const buf = await resp.arrayBuffer()
  const kind = sniffFont(buf)
  if (kind !== 'ttf') {
    const why: Record<string, string> = {
      'otf-cff': 'The URL returned an OTF (CFF outlines), which PDF embedding does not support - use the TTF version of the font.',
      woff: 'The URL returned a WOFF file - use the raw .ttf instead.',
      woff2: 'The URL returned a WOFF2 file (typical of Google Fonts CSS links) - use the raw .ttf, e.g. the Raw URL of the .ttf in github.com/google/fonts.',
      text: 'The URL returned a web page, not a font - on GitHub, use the Raw file URL (raw.githubusercontent.com), not the page URL.',
      unknown: 'The URL did not return a recognizable font file.'
    }
    throw new Error(why[kind] + ' (' + url + ')')
  }
  fontCache.set(url, buf)
  return buf
}

function bufferToB64 (url: string, buf: ArrayBuffer): string {
  const hit = pdfB64Cache.get(url)
  if (hit) return hit
  const bytes = new Uint8Array(buf)
  let bin = ''
  const CHUNK = 0x8000
  for (let i = 0; i < bytes.length; i += CHUNK) {
    bin += String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK) as any)
  }
  const b64 = btoa(bin)
  pdfB64Cache.set(url, b64)
  return b64
}

/** Register the custom font with the browser (canvas/SVG backends). */
async function registerFontFace (name: string, url: string, boldUrl?: string): Promise<void> {
  const key = name + '|' + url + '|' + (boldUrl || '')
  if (registeredFaces.has(key)) return
  const normal = new FontFace(name, await fetchFontBuffer(url))
  await normal.load()
  ;(document as any).fonts.add(normal)
  if (boldUrl) {
    const bold = new FontFace(name, await fetchFontBuffer(boldUrl), { weight: 'bold' } as any)
    await bold.load()
    ;(document as any).fonts.add(bold)
  }
  registeredFaces.add(key)
}

/** Register the custom font with a jsPDF document. jsPDF swallows TTF parse
 *  errors internally ("PubSub Error ... No unicode cmap"), so verify via
 *  getFontList afterwards and abort cleanly instead of exporting a broken font. */
async function registerPdfFont (doc: jsPDF, name: string, url: string, boldUrl?: string): Promise<void> {
  const nb = bufferToB64(url, await fetchFontBuffer(url))
  const nfile = name + '-normal.ttf'
  ;(doc as any).addFileToVFS(nfile, nb)
  ;(doc as any).addFont(nfile, name, 'normal')
  const bUrl = boldUrl || url // no bold file -> reuse normal so 'bold' resolves
  const bb = bufferToB64(bUrl, await fetchFontBuffer(bUrl))
  const bfile = name + '-bold.ttf'
  ;(doc as any).addFileToVFS(bfile, bb)
  ;(doc as any).addFont(bfile, name, 'bold')
  // Verification must work on jsPDF 2.x AND 4.x. On 2.x a failed parse is
  // absent from getFontList; on 4.x it is listed but unusable (text() then
  // fails silently via PubSub). So check the list, then probe actual use.
  const list = (doc as any).getFontList ? (doc as any).getFontList() : null
  let ok = !list || !!list[name]
  if (ok) {
    try {
      ;(doc as any).setFont(name, 'normal')
      const w = (doc as any).getStringUnitWidth ? (doc as any).getStringUnitWidth('Ag') : 1
      ok = typeof w === 'number' && isFinite(w) && w > 0
    } catch (e) { ok = false }
    try { (doc as any).setFont('helvetica', 'normal') } catch (e) { /* ignore */ }
  }
  if (!ok) {
    throw new Error('jsPDF could not parse "' + name + '" (no unicode cmap). Some variable-font TTFs are not supported - use a static instance TTF (e.g. the files under static/ in github.com/google/fonts, or export a static TTF from the variable font).')
  }
}

/* ------------------------------------------------------------------ */
/* main entry                                                          */
/* ------------------------------------------------------------------ */

const EXT: Record<OutputFormat, string> = {
  pdf: 'pdf', png32: 'png', png8: 'png', jpg: 'jpg', gif: 'gif',
  tiff: 'tif', eps: 'eps', svg: 'svg', svgz: 'svgz', aix: 'aix'
}

export async function renderLayout (
  liveView: MapView,
  layout: PrintLayout,
  format: OutputFormat,
  title: string,
  fileName: string,
  maxImagePx: number,
  options: RenderOptions,
  onProgress: RenderProgress
): Promise<RenderResult> {
  if (format === 'aix') {
    throw new Error('AIX is a proprietary format only Esri print services can generate. For Illustrator-editable vector output, use SVG.')
  }
  let lastUrl = ''
  let lastSize = 0
  const mfSrc = getMapFrame(layout)
  let useLayout: PrintLayout = layout
  if (options.mapOnly) {
    const ar = mfSrc.wIn / mfSrc.hIn
    const w = Number(options.mapOnlyWidth) || 0
    const h = Number(options.mapOnlyHeight) || 0
    let pw = mfSrc.wIn, ph = mfSrc.hIn, dpi = layout.dpi
    if (w > 0 || h > 0) {
      // explicit pixel output at 96 dpi (px -> inches); derive the missing side from frame aspect
      if (w > 0 && h > 0) { pw = w / 96; ph = h / 96 } else if (w > 0) { pw = w / 96; ph = (w / ar) / 96 } else { ph = h / 96; pw = (h * ar) / 96 }
      dpi = 96
    }
    useLayout = ({ ...layout, dpi, pageWidthIn: pw, pageHeightIn: ph,
      elements: [{ ...mfSrc, xIn: 0, yIn: 0, wIn: pw, hIn: ph }] } as PrintLayout)
  }
  const pageW = useLayout.pageWidthIn * PT_PER_IN
  const pageH = useLayout.pageHeightIn * PT_PER_IN
  const mf = getMapFrame(useLayout)

  const cap = await captureMapHiRes(liveView, mf.wIn, mf.hIn, useLayout, maxImagePx, options, onProgress)

  const hasLegend = !options.mapOnly && options.includeLegend !== false && (useLayout.elements || []).some(e => e.type === 'legend')
  const legendRows = hasLegend
    ? await buildLegendRows(
        liveView,
        Math.max(1, ((useLayout.elements.find(e => e.type === 'legend') as LegendEl)?.maxItems) || 30),
        onProgress
      )
    : []

  onProgress('Composing page…')
  const safeName = (fileName || 'map').replace(/[\\/:*?"<>|]+/g, '_')
  const outName = safeName + '.' + EXT[format]

  if (format === 'pdf') {
    const doc = new jsPDF({
      orientation: pageW >= pageH ? 'landscape' : 'portrait',
      unit: 'pt',
      format: [pageW, pageH].sort((a, b) => a - b) as any,
      compress: true
    })
    const pd = new PdfDrawer(doc)
    pd.setFontFamily(options.fontFamily || 'sans')
    if (options.customFont) {
      onProgress('Loading font ' + options.customFont.name + '…')
      await registerPdfFont(doc, options.customFont.name, options.customFont.url, options.customFont.boldUrl)
      pd.setCustomFont(options.customFont.name)
    }
    await composePage(pd, useLayout, cap, legendRows, title, options)
    const pdfBlob: Blob = doc.output('blob')
    lastUrl = downloadBlob(pdfBlob, outName); lastSize = pdfBlob.size
  } else if (format === 'svg' || format === 'svgz') {
    const drawer = new SvgDrawer(pageW, pageH)
    drawer.setFontFamily(options.fontFamily || 'sans')
    if (options.customFont) {
      onProgress('Loading font ' + options.customFont.name + '…')
      await registerFontFace(options.customFont.name, options.customFont.url, options.customFont.boldUrl)
      drawer.setCustomFont(options.customFont.name)
    }
    await composePage(drawer, useLayout, cap, legendRows, title, options)
    const svgText = drawer.toSvg()
    onProgress('Encoding ' + format.toUpperCase() + '…')
    const blob = format === 'svg'
      ? new Blob([svgText], { type: 'image/svg+xml' })
      : await gzipBlob(svgText)
    lastUrl = downloadBlob(blob, outName); lastSize = blob.size
  } else {
    let pageDpi = useLayout.dpi
    const longEdgePx = Math.max(useLayout.pageWidthIn, useLayout.pageHeightIn) * pageDpi
    const CANVAS_CAP = 8000
    if (longEdgePx > CANVAS_CAP) pageDpi = Math.floor(CANVAS_CAP / Math.max(useLayout.pageWidthIn, useLayout.pageHeightIn))
    const drawer = new CanvasDrawer(pageW, pageH, pageDpi)
    drawer.setFontFamily(options.fontFamily || 'sans')
    if (options.customFont) {
      onProgress('Loading font ' + options.customFont.name + '…')
      await registerFontFace(options.customFont.name, options.customFont.url, options.customFont.boldUrl)
      drawer.setCustomFont(options.customFont.name)
    }
    await composePage(drawer, useLayout, cap, legendRows, title, options)
    onProgress('Encoding ' + format.toUpperCase() + '…')

    let blob: Blob
    switch (format) {
      case 'png32': blob = new Blob([dataUrlToBytes(drawer.canvas.toDataURL('image/png'))], { type: 'image/png' }); break
      case 'png8': blob = encodePng8(drawer.canvas); break
      case 'jpg': blob = new Blob([dataUrlToBytes(drawer.canvas.toDataURL('image/jpeg', 0.92))], { type: 'image/jpeg' }); break
      case 'gif': blob = encodeGif(drawer.canvas); break
      case 'tiff': blob = encodeTiff(drawer.canvas); break
      case 'eps': blob = encodeEps(drawer.canvas, pageW, pageH); break
      default: throw new Error('Unsupported format: ' + format)
    }
    lastUrl = downloadBlob(blob, outName); lastSize = blob.size
  }

  return {
    fileName: outName,
    effectiveDpi: Math.round(cap.effectiveDpi),
    printedScale: Math.round(cap.printedScale),
    url: lastUrl || undefined,
    sizeKb: lastSize ? Math.round(lastSize / 1024) : undefined
  }
}
