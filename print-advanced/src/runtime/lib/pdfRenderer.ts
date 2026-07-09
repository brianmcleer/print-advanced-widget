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
import { metersPerMapUnit, extentFitScale, resolvePrintedScale, printExtent, PrintScaleMode } from './scaleMath'
import * as reactiveUtils from 'esri/core/reactiveUtils'
import { loadArcGISJSAPIModules } from 'jimu-arcgis'
import * as symbolUtils from 'esri/symbols/support/symbolUtils'
import { jsPDF } from 'jspdf'
import {
    PrintLayout, ScaleBarUnits, ScaleBarStyle, NorthArrowStyle, FontFamily, LayoutElement,
    TextEl, ScaleBarEl, LegendEl, MapFrameEl, PictureEl, NorthArrowEl, LineEl, OverviewConfig, GridConfig } from '../../config'
import { Drawer, PdfDrawer, CanvasDrawer, SvgDrawer, splitText } from './drawing'

/* eslint-disable @typescript-eslint/no-var-requires */
const UPNG = require('upng-js')
const UTIF = require('utif')
const gifenc = require('gifenc')
/* eslint-enable @typescript-eslint/no-var-requires */

// Pure UI constants live in printConstants.ts so the settings panel can use
// them without pulling this module's esri/* imports into the settings bundle.
// Re-exported here so runtime imports keep working unchanged.
import { OutputFormat } from '../../printConstants'
export { FORMAT_LABELS, FONT_FAMILIES, NORTH_ARROW_STYLES, SCALE_BAR_STYLES, SCALE_BAR_UNITS } from '../../printConstants'
export type { OutputFormat } from '../../printConstants'

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
    /** Runtime user toggles (default on when the layout configures them). */
    showOverview?: boolean
    showGrid?: boolean
    /** Internal: prebuilt grid geometry (projection-engine graticules). */
    gridGeomOverride?: GridGeometry
    /** Internal: overview inset payload assembled by renderLayout. */
    overview?: {
        cap: CaptureResult
        box: { xIn: number, yIn: number, wIn: number, hIn: number }
        indicator: { xIn: number, yIn: number, wIn: number, hIn: number }
        cfg: OverviewConfig
    }
    /** Output coordinate system WKID; map is re-rendered in this SR client-side. */
    outputWkid?: number
}

export interface RenderProgress { (message: string): void }

export interface RenderResult {
    fileName: string
    effectiveDpi: number
    printedScale: number
    url?: string
    sizeKb?: number
    /** Set when the map may not have finished drawing before capture. */
    warning?: string
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

function fmtNumber(n: number, decimals = 0): string {
    const fixed = n.toFixed(decimals)
    const parts = fixed.split('.')
    parts[0] = parts[0].replace(/\B(?=(\d{3})+(?!\d))/g, ',')
    return parts.join('.')
}

function today(): string {
    // Pro renders <dyn type="date" format=""/> as the short date (7/1/2026).
    return new Date().toLocaleDateString('en-US')
}

/** Replace runtime tokens produced by the pagx importer. */
interface TextTokens { title: string, printedScale: number, author?: string, copyright?: string, attribution?: string }

function replaceTokens(tpl: string, tk: TextTokens): string {
    return (tpl || '')
        .replace(/\{title\}/g, tk.title || '')
        .replace(/\{author\}/g, tk.author || '')
        .replace(/\{copyright\}/g, tk.copyright || '')
        .replace(/\{attribution\}/g, tk.attribution || '')
        .replace(/\{date\}/g, today())
        .replace(/\{scale\}/g, fmtNumber(tk.printedScale))
        .replace(/\{scaleRatio:(\w+):(\d+)\}/g, (_m, unit: string, dp: string) => {
            const per = INCHES_PER_UNIT[unit] || 12
            const v = tk.printedScale / per
            let decimals = parseInt(dp, 10) || 0
            // Pro prints "1 inch equals 0 miles" when decimalPlaces rounds a
            // nonzero value to 0 (common at city scales with mapUnits="mi").
            // Escalate to two significant digits instead of printing 0.
            if (v > 0 && parseFloat(v.toFixed(decimals)) === 0) {
                decimals = Math.min(6, Math.ceil(-Math.log10(v)) + 1)
                const trimmed = String(parseFloat(v.toFixed(decimals)))
                decimals = (trimmed.split('.')[1] || '').length
            }
            return fmtNumber(v, decimals)
        })
}

function niceBarDistance(printedScale: number, units: ScaleBarUnits, maxIn: number): { dist: number, barIn: number } {
    const mpu = METERS_PER_UNIT[units]
    const maxGround = (maxIn * 0.0254 * printedScale) / mpu
    const pow = Math.pow(10, Math.floor(Math.log10(Math.max(maxGround, 1e-6))))
    let best = pow
    for (const mult of [1, 2, 2.5, 4, 5, 10]) {
        if (mult * pow <= maxGround) best = mult * pow
    }
    const barIn = (best * mpu) / (0.0254 * printedScale)
    return { dist: best, barIn }
}

function downloadBlob(blob: Blob, fileName: string): string {
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
function dataUrlToBytes(dataUrl: string) {
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
    /** Set when the map may not have finished drawing before capture. */
    warning?: string
    /** Ground extent of the capture in the view's spatial reference
     *  (valid when rotation = 0 and the output SR matches the map). */
    groundExtent?: { xmin: number, ymin: number, xmax: number, ymax: number }
    /** Projection family for grid math. */
    projection?: 'webMercator' | 'geographic' | 'projected'
    /** True when an output WKID reprojected the capture away from the
     *  live map's SR (ground extent no longer applies). */
    reprojected?: boolean
}

/* ------------------------------------------------------------------ */
/* GPU capability probe                                                 */
/* ------------------------------------------------------------------ */

let _gpuMaxPx: number | null = null

/** Longest canvas side the GPU can render (min of MAX_TEXTURE_SIZE and
 *  MAX_RENDERBUFFER_SIZE), probed once. Falls back to 8192. */
export function gpuMaxCapturePx (): number {
    if (_gpuMaxPx !== null) return _gpuMaxPx
    let max = 8192
    try {
        const c = document.createElement('canvas')
        const gl = (c.getContext('webgl2') || c.getContext('webgl')) as WebGLRenderingContext | null
        if (gl) {
            const t = Number(gl.getParameter(gl.MAX_TEXTURE_SIZE)) || 8192
            const r = Number(gl.getParameter(gl.MAX_RENDERBUFFER_SIZE)) || 8192
            max = Math.max(2048, Math.min(t, r))
            const lose = gl.getExtension('WEBGL_lose_context')
            if (lose) lose.loseContext()
        }
    } catch (e) { /* keep fallback */ }
    _gpuMaxPx = max
    return max
}

export async function captureMapHiRes(
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
    // Cap the longest side: admin setting if provided, otherwise auto
    // (GPU limit, but no higher than 8192 to keep memory sane). The GPU
    // limit always wins - a canvas larger than MAX_TEXTURE_SIZE renders
    // blank or fails on takeScreenshot.
    const gpuMax = gpuMaxCapturePx()
    const capLimit = Math.min(maxImagePx > 0 ? maxImagePx : Math.min(gpuMax, 8192), gpuMax)
    const maxDim = Math.max(capW, capH)
    if (maxDim > capLimit) {
        const s = capLimit / maxDim
        capW = Math.round(capW * s)
        capH = Math.round(capH * s)
        onProgress('Map capture capped at ' + capLimit + ' px (' +
            (maxImagePx > 0 && capLimit === maxImagePx ? 'settings limit' : 'graphics card limit') +
            '); effective ' + Math.round(capW / frameWIn) + ' DPI.')
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

        // If the view is still drawing after the wait (slow services, big
        // captures), the screenshot would silently miss layers. Capture
        // anyway, but say so honestly on the result.
        let warning: string | undefined
        if (tmp.updating) {
            warning = 'Some layers may not have finished drawing. Export again, or lower the DPI or max capture size.'
            onProgress('Map is still drawing after 45 s; capturing anyway. ' + warning)
        }

        onProgress('Capturing map image…')
        let shot: any
        try {
            shot = await tmp.takeScreenshot({
                width: capW,
                height: capH,
                format: layout.imageFormat === 'png' ? 'png' : 'jpg',
                quality: 95
            } as any)
        } catch (err: any) {
            throw new Error('Map capture failed at ' + capW + ' x ' + capH + ' px' +
                (err && err.message ? ' (' + err.message + ')' : '') +
                '. Lower the DPI, or set a smaller Max map capture in settings.')
        }
        if (!shot || !shot.dataUrl) {
            throw new Error('Map capture returned no image at ' + capW + ' x ' + capH + ' px. ' +
                'Lower the DPI, or set a smaller Max map capture in settings.')
        }

        const liveWkid = (liveView.spatialReference && (liveView.spatialReference as any).wkid) || 0
        const reprojected = !!(opts.outputWkid && opts.outputWkid > 0 && opts.outputWkid !== liveWkid)
        // Ground extent for grid math: the offscreen view knows its own
        // extent in the CAPTURE spatial reference, so grids stay correct
        // even when an output WKID reprojects the map. Fall back to the
        // live-SR computation only when not reprojected.
        const capWkid = reprojected ? Number(opts.outputWkid) : liveWkid
        let ground: { xmin: number, ymin: number, xmax: number, ymax: number } | undefined
        const tExt: any = (tmp as any).extent
        if (tExt && isFinite(tExt.xmin) && tExt.xmax > tExt.xmin) {
            ground = { xmin: tExt.xmin, ymin: tExt.ymin, xmax: tExt.xmax, ymax: tExt.ymax }
        } else if ((tmp as any).center && (tmp as any).resolution) {
            // The view's extent property was not ready; rebuild it from the
            // temp view's own center/scale in the CAPTURE spatial reference.
            const tc: any = (tmp as any).center
            const mpuTmp = metersPerMapUnit((tmp as any).scale, (tmp as any).resolution)
            const gx = printExtent(tc.x, tc.y, mpuTmp, frameWIn, frameHIn, printedScale)
            ground = { xmin: gx.xmin, ymin: gx.ymin, xmax: gx.xmax, ymax: gx.ymax }
        } else if (!reprojected) {
            const gx = printExtent(center.x, center.y, mpuLive, frameWIn, frameHIn, printedScale)
            ground = { xmin: gx.xmin, ymin: gx.ymin, xmax: gx.xmax, ymax: gx.ymax }
        }
        return {
            dataUrl: shot.dataUrl,
            widthPx: capW,
            heightPx: capH,
            printedScale,
            effectiveDpi,
            rotation: (() => {
                const raw = liveView.rotation || 0
                const norm = ((raw % 360) + 360) % 360
                return (norm < 0.05 || norm > 359.95) ? 0 : raw
            })(),
            warning,
            groundExtent: ground,
            projection: (capWkid === 3857 || capWkid === 102100 || capWkid === 102113)
                ? 'webMercator'
                : (capWkid === 4326 ? 'geographic' : 'projected'),
            reprojected
        }
    } finally {
        // CRITICAL: temp view shares the live WebMap - detach before destroy.
        if (tmp) {
            try {
                (tmp as any).map = null
                    ; (tmp as any).container = null
                tmp.destroy()
            } catch (e) { /* ignore */ }
        }
        container.remove()
    }
}

/* ------------------------------------------------------------------ */
/* legend extraction (client-side)                                     */
/* ------------------------------------------------------------------ */

async function symbolToDataUrl(symbol: any): Promise<string | null> {
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

export async function buildLegendRows(view: MapView, maxItems: number, onProgress: RenderProgress): Promise<LegendRow[]> {
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

function drawNorthArrowEl(d: Drawer, el: NorthArrowEl, rotationDeg: number, style: NorthArrowStyle = 'splitArrow'): void {
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
function drawBarOfStyle(
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

function drawScaleBarEl(d: Drawer, el: ScaleBarEl, printedScale: number, opts: RenderOptions): void {
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

function drawTextEl(d: Drawer, el: TextEl, tokens: TextTokens): void {
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

async function drawPictureEl(d: Drawer, el: PictureEl, defaultLogo?: string): Promise<void> {
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

async function drawLegendEl(d: Drawer, el: LegendEl, rows: LegendRow[]): Promise<void> {
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

/* ------------------------------------------------------------------ */
/* Grids and graticules (ArcGIS Pro style, settings-defined)            */
/* ------------------------------------------------------------------ */

const R_MERC = 6378137

export function lonToMercX (lonDeg: number): number { return R_MERC * lonDeg * Math.PI / 180 }
export function mercXToLon (x: number): number { return (x / R_MERC) * 180 / Math.PI }
export function latToMercY (latDeg: number): number { return R_MERC * Math.asinh(Math.tan(latDeg * Math.PI / 180)) }
export function mercYToLat (y: number): number { return Math.atan(Math.sinh(y / R_MERC)) * 180 / Math.PI }

/** Clean 1 / 2 / 2.5 / 5 x 10^k interval targeting ~divisions lines. */
export function niceGridInterval (span: number, divisions = 4): number {
    const raw = span / Math.max(1, divisions)
    const pow = Math.pow(10, Math.floor(Math.log10(Math.max(raw, 1e-12))))
    let best = pow
    for (const mult of [1, 2, 2.5, 5, 10]) {
        if (mult * pow <= raw) best = mult * pow
    }
    return best
}

/** Pro-style graticule ladder (degrees down to seconds). */
const DEG_LADDER = [45, 30, 15, 10, 5, 2, 1,
    30 / 60, 15 / 60, 10 / 60, 5 / 60, 2 / 60, 1 / 60,
    30 / 3600, 15 / 3600, 10 / 3600, 5 / 3600, 2 / 3600, 1 / 3600]

export function niceGraticuleInterval (spanDeg: number, divisions = 4): number {
    const raw = spanDeg / Math.max(1, divisions)
    for (const step of DEG_LADDER) {
        if (step <= raw) return step
    }
    return DEG_LADDER[DEG_LADDER.length - 1]
}

/** Degrees -> D°MM'SS" trimming units the interval never needs. */
export function fmtDMS (deg: number, intervalDeg: number): string {
    const sign = deg < 0 ? '-' : ''
    const a = Math.abs(deg)
    let d = Math.floor(a)
    let mFloat = (a - d) * 60
    let mm = Math.floor(mFloat)
    let ss = Math.round((mFloat - mm) * 60)
    if (ss === 60) { ss = 0; mm += 1 }
    if (mm === 60) { mm = 0; d += 1 }
    if (intervalDeg >= 1) return sign + d + '\u00B0'
    if (intervalDeg >= 1 / 60) {
        return sign + d + '\u00B0' + String(mm).padStart(2, '0') + "'"
    }
    return sign + d + '\u00B0' + String(mm).padStart(2, '0') + "'" + String(ss).padStart(2, '0') + '"'
}

/** Clip a segment to a rectangle (Liang-Barsky). Returns null when fully outside. */
export function clipSegToRect (
    x1: number, y1: number, x2: number, y2: number,
    rx: number, ry: number, rw: number, rh: number
): [number, number, number, number] | null {
    let t0 = 0, t1 = 1
    const dx = x2 - x1, dy = y2 - y1
    const p = [-dx, dx, -dy, dy]
    const q = [x1 - rx, rx + rw - x1, y1 - ry, ry + rh - y1]
    for (let i = 0; i < 4; i++) {
        if (p[i] === 0) { if (q[i] < 0) return null; continue }
        const r = q[i] / p[i]
        if (p[i] < 0) { if (r > t1) return null; if (r > t0) t0 = r }
        else { if (r < t0) return null; if (r < t1) t1 = r }
    }
    return [x1 + t0 * dx, y1 + t0 * dy, x1 + t1 * dx, y1 + t1 * dy]
}

/** Graticule from an arbitrary projector pair. Samples the extent border to
 *  find the lat/lon range (extremes can sit mid-edge in projected systems),
 *  then draws each meridian/parallel as a sampled polyline clipped to the
 *  frame, so curved graticules render correctly in any projection. */
export function buildGraticuleGeometry (
    ext: { xmin: number, ymin: number, xmax: number, ymax: number },
    mf: { xIn: number, yIn: number, wIn: number, hIn: number },
    cfg: GridConfig,
    toGeo: (x: number, y: number) => [number, number],
    fromGeo: (lon: number, lat: number) => [number, number],
    samples = 24
): GridGeometry {
    const g: GridGeometry = { lines: [], crosses: [], ticks: [], labels: [] }
    const pageX = (x: number): number => mf.xIn + (x - ext.xmin) / (ext.xmax - ext.xmin) * mf.wIn
    const pageY = (y: number): number => mf.yIn + (ext.ymax - y) / (ext.ymax - ext.ymin) * mf.hIn
    const markScale = gridMarkScale(mf)

    // Border sampling for the geographic range
    let lonMin = Infinity, lonMax = -Infinity, latMin = Infinity, latMax = -Infinity
    const N = 8
    for (let i = 0; i <= N; i++) {
        const fx = ext.xmin + (i / N) * (ext.xmax - ext.xmin)
        const fy = ext.ymin + (i / N) * (ext.ymax - ext.ymin)
        for (const [px, py] of [[fx, ext.ymin], [fx, ext.ymax], [ext.xmin, fy], [ext.xmax, fy]]) {
            const ll = toGeo(px, py)
            if (!ll || !isFinite(ll[0]) || !isFinite(ll[1])) continue
            lonMin = Math.min(lonMin, ll[0]); lonMax = Math.max(lonMax, ll[0])
            latMin = Math.min(latMin, ll[1]); latMax = Math.max(latMax, ll[1])
        }
    }
    if (!isFinite(lonMin) || lonMax <= lonMin || latMax <= latMin) return g

    const step = cfg.intervalMode === 'fixed' && Number(cfg.fixedInterval) > 0
        ? Number(cfg.fixedInterval)
        : niceGraticuleInterval(Math.max(lonMax - lonMin, latMax - latMin))
    const tickLen = 0.12 * markScale, crossLen = 0.08 * markScale
    const fx0 = mf.xIn, fy0 = mf.yIn, fw = mf.wIn, fh = mf.hIn

    const addPolyline = (pts: Array<[number, number]>): void => {
        for (let i = 1; i < pts.length; i++) {
            const c = clipSegToRect(pts[i - 1][0], pts[i - 1][1], pts[i][0], pts[i][1], fx0, fy0, fw, fh)
            if (c) g.lines.push({ x1In: c[0], y1In: c[1], x2In: c[2], y2In: c[3] })
        }
    }

    const meridians: number[] = []
    for (let lon = Math.ceil(lonMin / step) * step; lon <= lonMax + 1e-12; lon += step) meridians.push(lon)
    const parallels: number[] = []
    for (let lat = Math.ceil(latMin / step) * step; lat <= latMax + 1e-12; lat += step) parallels.push(lat)

    for (const lon of meridians) {
        const pts: Array<[number, number]> = []
        for (let i = 0; i <= samples; i++) {
            const lat = latMin + (i / samples) * (latMax - latMin)
            const xy = fromGeo(lon, lat)
            if (xy && isFinite(xy[0])) pts.push([pageX(xy[0]), pageY(xy[1])])
        }
        addPolyline(pts)
        if (cfg.labels !== false && pts.length) {
            // label where the meridian meets top and bottom edges
            for (const edge of ['top', 'bottom'] as const) {
                const targetY = edge === 'top' ? fy0 : fy0 + fh
                let best: [number, number] | null = null
                for (const pt of pts) if (!best || Math.abs(pt[1] - targetY) < Math.abs(best[1] - targetY)) best = pt
                if (best && best[0] >= fx0 - 0.05 && best[0] <= fx0 + fw + 0.05) {
                    g.labels.push({ text: fmtGeoLabel(lon, step, 'lon'), xIn: Math.min(Math.max(best[0], fx0), fx0 + fw), yIn: targetY, edge })
                }
            }
        }
        // ticks at edges
        const first = pts[0]; const last = pts[pts.length - 1]
        if (first) g.ticks.push({ x1In: Math.min(Math.max(first[0], fx0), fx0 + fw), y1In: fy0 + fh - tickLen, x2In: Math.min(Math.max(first[0], fx0), fx0 + fw), y2In: fy0 + fh })
        if (last) g.ticks.push({ x1In: Math.min(Math.max(last[0], fx0), fx0 + fw), y1In: fy0, x2In: Math.min(Math.max(last[0], fx0), fx0 + fw), y2In: fy0 + tickLen })
    }
    for (const lat of parallels) {
        const pts: Array<[number, number]> = []
        for (let i = 0; i <= samples; i++) {
            const lon = lonMin + (i / samples) * (lonMax - lonMin)
            const xy = fromGeo(lon, lat)
            if (xy && isFinite(xy[0])) pts.push([pageX(xy[0]), pageY(xy[1])])
        }
        addPolyline(pts)
        if (cfg.labels !== false && pts.length) {
            for (const edge of ['left', 'right'] as const) {
                const targetX = edge === 'left' ? fx0 : fx0 + fw
                let best: [number, number] | null = null
                for (const pt of pts) if (!best || Math.abs(pt[0] - targetX) < Math.abs(best[0] - targetX)) best = pt
                if (best && best[1] >= fy0 - 0.05 && best[1] <= fy0 + fh + 0.05) {
                    g.labels.push({ text: fmtGeoLabel(lat, step, 'lat'), xIn: targetX, yIn: Math.min(Math.max(best[1], fy0), fy0 + fh), edge })
                }
            }
        }
        const first = pts[0]; const last = pts[pts.length - 1]
        if (first) g.ticks.push({ x1In: fx0, y1In: Math.min(Math.max(first[1], fy0), fy0 + fh), x2In: fx0 + tickLen, y2In: Math.min(Math.max(first[1], fy0), fy0 + fh) })
        if (last) g.ticks.push({ x1In: fx0 + fw - tickLen, y1In: Math.min(Math.max(last[1], fy0), fy0 + fh), x2In: fx0 + fw, y2In: Math.min(Math.max(last[1], fy0), fy0 + fh) })
    }
    // crosses at meridian/parallel intersections
    for (const lon of meridians) {
        for (const lat of parallels) {
            const xy = fromGeo(lon, lat)
            if (!xy || !isFinite(xy[0])) continue
            const px = pageX(xy[0]), py = pageY(xy[1])
            if (px < fx0 || px > fx0 + fw || py < fy0 || py > fy0 + fh) continue
            g.crosses.push({ x1In: px - crossLen / 2, y1In: py, x2In: px + crossLen / 2, y2In: py })
            g.crosses.push({ x1In: px, y1In: py - crossLen / 2, x2In: px, y2In: py + crossLen / 2 })
        }
    }
    return g
}

/** Marks (ticks, crosses) scale with the map frame so they stay visible on
 *  large formats: 1x at letter size, ~4x on a 36x48 sheet. */
export function gridMarkScale (mf: { wIn: number, hIn: number }): number {
    return Math.max(1, Math.min(5, Math.min(mf.wIn, mf.hIn) / 6.5))
}

/** Cartographic geographic label: 108°30'W rather than -108°30'. */
export function fmtGeoLabel (deg: number, intervalDeg: number, axis: 'lon' | 'lat'): string {
    const base = fmtDMS(Math.abs(deg), intervalDeg)
    if (Math.abs(deg) < 1e-12) return base
    return base + (axis === 'lon' ? (deg < 0 ? 'W' : 'E') : (deg < 0 ? 'S' : 'N'))
}

export interface GridLine { x1In: number, y1In: number, x2In: number, y2In: number }
export interface GridLabel { text: string, xIn: number, yIn: number, edge: 'top' | 'bottom' | 'left' | 'right' }
export interface GridGeometry { lines: GridLine[], crosses: GridLine[], ticks: GridLine[], labels: GridLabel[] }

/** Pure geometry builder for graticule / measured grids (rotation 0).
 *  Returns page-inch line work + edge label anchors; the caller styles it. */
export function buildGridGeometry (
    cap: { groundExtent?: { xmin: number, ymin: number, xmax: number, ymax: number }, projection?: string },
    mf: { xIn: number, yIn: number, wIn: number, hIn: number },
    cfg: GridConfig
): GridGeometry | null {
    const g: GridGeometry = { lines: [], crosses: [], ticks: [], labels: [] }
    const ext = cap.groundExtent
    if (!ext) return null
    const markScale = gridMarkScale(mf)
    const tickLen = 0.12 * markScale
    const crossLen = 0.08 * markScale

    // Value axes: either lon/lat degrees (graticule) or map units (measured).
    let xs: Array<{ v: number, pageX: number, label: string }> = []
    let ys: Array<{ v: number, pageY: number, label: string }> = []

    if (cfg.type === 'graticule') {
        if (cap.projection !== 'webMercator' && cap.projection !== 'geographic') return null
        const merc = cap.projection === 'webMercator'
        return buildGraticuleGeometry(ext, mf, cfg,
            merc ? (x, y) => [mercXToLon(x), mercYToLat(y)] : (x, y) => [x, y],
            merc ? (lon, lat) => [lonToMercX(lon), latToMercY(lat)] : (lon, lat) => [lon, lat])
    }
    { // measured
        const step = cfg.intervalMode === 'fixed' && Number(cfg.fixedInterval) > 0
            ? Number(cfg.fixedInterval)
            : niceGridInterval(Math.max(ext.xmax - ext.xmin, ext.ymax - ext.ymin))
        const fmt = (v: number): string => {
            const r = Math.round(v)
            return String(r).replace(/\B(?=(\d{3})+(?!\d))/g, ',')
        }
        for (let x = Math.ceil(ext.xmin / step) * step; x <= ext.xmax + 1e-9; x += step) {
            xs.push({ v: x, pageX: mf.xIn + (x - ext.xmin) / (ext.xmax - ext.xmin) * mf.wIn, label: fmt(x) })
        }
        for (let y = Math.ceil(ext.ymin / step) * step; y <= ext.ymax + 1e-9; y += step) {
            ys.push({ v: y, pageY: mf.yIn + (ext.ymax - y) / (ext.ymax - ext.ymin) * mf.hIn, label: fmt(y) })
        }
    }

    for (const x of xs) {
        g.lines.push({ x1In: x.pageX, y1In: mf.yIn, x2In: x.pageX, y2In: mf.yIn + mf.hIn })
        g.ticks.push({ x1In: x.pageX, y1In: mf.yIn, x2In: x.pageX, y2In: mf.yIn + tickLen })
        g.ticks.push({ x1In: x.pageX, y1In: mf.yIn + mf.hIn - tickLen, x2In: x.pageX, y2In: mf.yIn + mf.hIn })
        if (cfg.labels !== false) {
            g.labels.push({ text: x.label, xIn: x.pageX, yIn: mf.yIn, edge: 'top' })
            g.labels.push({ text: x.label, xIn: x.pageX, yIn: mf.yIn + mf.hIn, edge: 'bottom' })
        }
    }
    for (const y of ys) {
        g.lines.push({ x1In: mf.xIn, y1In: y.pageY, x2In: mf.xIn + mf.wIn, y2In: y.pageY })
        g.ticks.push({ x1In: mf.xIn, y1In: y.pageY, x2In: mf.xIn + tickLen, y2In: y.pageY })
        g.ticks.push({ x1In: mf.xIn + mf.wIn - tickLen, y1In: y.pageY, x2In: mf.xIn + mf.wIn, y2In: y.pageY })
        if (cfg.labels !== false) {
            g.labels.push({ text: y.label, xIn: mf.xIn, yIn: y.pageY, edge: 'left' })
            g.labels.push({ text: y.label, xIn: mf.xIn + mf.wIn, yIn: y.pageY, edge: 'right' })
        }
    }
    for (const x of xs) {
        for (const y of ys) {
            g.crosses.push({ x1In: x.pageX - crossLen / 2, y1In: y.pageY, x2In: x.pageX + crossLen / 2, y2In: y.pageY })
            g.crosses.push({ x1In: x.pageX, y1In: y.pageY - crossLen / 2, x2In: x.pageX, y2In: y.pageY + crossLen / 2 })
        }
    }
    return g
}

/** Reference (alphanumeric index) grid: pure page-space. */
export function buildReferenceGrid (
    mf: { xIn: number, yIn: number, wIn: number, hIn: number },
    cols: number, rows: number, labels: boolean
): GridGeometry {
    const g: GridGeometry = { lines: [], crosses: [], ticks: [], labels: [] }
    const c = Math.max(1, Math.min(26, Math.round(cols) || 4))
    const r = Math.max(1, Math.min(99, Math.round(rows) || 4))
    const tickLen = 0.12 * gridMarkScale(mf)
    for (let i = 1; i < c; i++) {
        const x = mf.xIn + (i / c) * mf.wIn
        g.lines.push({ x1In: x, y1In: mf.yIn, x2In: x, y2In: mf.yIn + mf.hIn })
        g.ticks.push({ x1In: x, y1In: mf.yIn, x2In: x, y2In: mf.yIn + tickLen })
        g.ticks.push({ x1In: x, y1In: mf.yIn + mf.hIn - tickLen, x2In: x, y2In: mf.yIn + mf.hIn })
    }
    for (let j = 1; j < r; j++) {
        const y = mf.yIn + (j / r) * mf.hIn
        g.lines.push({ x1In: mf.xIn, y1In: y, x2In: mf.xIn + mf.wIn, y2In: y })
        g.ticks.push({ x1In: mf.xIn, y1In: y, x2In: mf.xIn + tickLen, y2In: y })
        g.ticks.push({ x1In: mf.xIn + mf.wIn - tickLen, y1In: y, x2In: mf.xIn + mf.wIn, y2In: y })
    }
    if (labels !== false) {
        for (let i = 0; i < c; i++) {
            const x = mf.xIn + ((i + 0.5) / c) * mf.wIn
            const letter = String.fromCharCode(65 + i)
            g.labels.push({ text: letter, xIn: x, yIn: mf.yIn, edge: 'top' })
            g.labels.push({ text: letter, xIn: x, yIn: mf.yIn + mf.hIn, edge: 'bottom' })
        }
        for (let j = 0; j < r; j++) {
            const y = mf.yIn + ((j + 0.5) / r) * mf.hIn
            g.labels.push({ text: String(j + 1), xIn: mf.xIn, yIn: y, edge: 'left' })
            g.labels.push({ text: String(j + 1), xIn: mf.xIn + mf.wIn, yIn: y, edge: 'right' })
        }
    }
    return g
}

/** Draw a built grid over the map frame. */
function drawGrid (d: Drawer, geom: GridGeometry, cfg: GridConfig): void {
    const lc = cfg.lineColor || [90, 90, 90]
    d.setStroke(lc[0], lc[1], lc[2])
    d.setLineWidth(cfg.lineWidthPt > 0 ? cfg.lineWidthPt : 0.5)
    const seg = cfg.lineStyle === 'ticks' ? geom.ticks
        : cfg.lineStyle === 'crosses' ? geom.ticks.concat(geom.crosses)
            : geom.lines
    for (const L of seg) {
        d.line(L.x1In * PT_PER_IN, L.y1In * PT_PER_IN, L.x2In * PT_PER_IN, L.y2In * PT_PER_IN)
    }
    if (geom.labels.length) {
        const size = cfg.labelSizePt > 0 ? cfg.labelSizePt : 7
        const pad = 3 // pt
        d.setFont('normal', size)
        const inside = cfg.labelsInside !== false
        for (const lb of geom.labels) {
            const x = lb.xIn * PT_PER_IN
            const y = lb.yIn * PT_PER_IN
            let tx = x
            let baseline = y
            let align: 'left' | 'center' | 'right' = 'center'
            if (lb.edge === 'top') { baseline = inside ? y + size + pad : y - pad; align = 'center' }
            // Bottom-inside labels need descender + halo clearance or the
            // glyphs collide with the frame border below the baseline.
            else if (lb.edge === 'bottom') { baseline = inside ? y - pad - size * 0.3 : y + size + pad; align = 'center' }
            else if (lb.edge === 'left') { tx = inside ? x + pad : x - pad; baseline = y + size * 0.35; align = inside ? 'left' : 'right' }
            else { tx = inside ? x - pad : x + pad; baseline = y + size * 0.35; align = inside ? 'right' : 'left' }
            // Cartographic halo: white stroke behind the glyphs so labels
            // read over imagery and grid lines without a boxy backing.
            d.setTextColor(lc[0], lc[1], lc[2])
            if (typeof d.haloText === 'function') {
                d.haloText(lb.text, tx, baseline, align, [255, 255, 255], Math.max(1.2, size * 0.11))
            } else {
                const tw = d.textWidth(lb.text)
                const bx = align === 'center' ? tx - tw / 2 : align === 'right' ? tx - tw : tx
                d.setFill(255, 255, 255)
                d.rect(bx - 2, baseline - size, tw + 4, size + 3, 'F')
                d.text(lb.text, tx, baseline, align)
            }
        }
    }
}

/** Inset box (page inches, top-left origin) for a settings-defined overview,
 *  positioned in a corner of the main map frame and clamped inside it. */
export function overviewBoxIn (
    mf: { xIn: number, yIn: number, wIn: number, hIn: number },
    ov: OverviewConfig
): { xIn: number, yIn: number, wIn: number, hIn: number } {
    const margin = Math.max(0, Number(ov.marginIn) || 0)
    const w = Math.min(Math.max(0.5, Number(ov.widthIn) || 2.5), Math.max(0.5, mf.wIn - 2 * margin))
    const h = Math.min(Math.max(0.5, Number(ov.heightIn) || 2), Math.max(0.5, mf.hIn - 2 * margin))
    const left = ov.position === 'topLeft' || ov.position === 'bottomLeft'
    const top = ov.position === 'topLeft' || ov.position === 'topRight'
    return {
        xIn: left ? mf.xIn + margin : mf.xIn + mf.wIn - margin - w,
        yIn: top ? mf.yIn + margin : mf.yIn + mf.hIn - margin - h,
        wIn: w,
        hIn: h
    }
}

/** Extent indicator (page inches) inside the overview box. Both captures
 *  share center and rotation, so the printed map's footprint is a centered
 *  axis-aligned rectangle scaled by printedScale / overviewScale. */
export function overviewIndicatorIn (
    box: { xIn: number, yIn: number, wIn: number, hIn: number },
    mainWIn: number, mainHIn: number,
    printedScale: number, overviewScale: number
): { xIn: number, yIn: number, wIn: number, hIn: number } {
    const r = overviewScale > 0 ? printedScale / overviewScale : 0
    const w = Math.min(mainWIn * r, box.wIn)
    const h = Math.min(mainHIn * r, box.hIn)
    return {
        xIn: box.xIn + (box.wIn - w) / 2,
        yIn: box.yIn + (box.hIn - h) / 2,
        wIn: w,
        hIn: h
    }
}

/** Lazy projector: ArcGIS SDK 5.x (esri/geometry/operators/projectOperator)
 *  first, 4.x (esri/geometry/projection) as fallback for EB 1.19. Loaded at
 *  export time via jimu-arcgis so a missing module can never break widget
 *  class load. Resolves to { project(point, outSR), Point } or null. */
let _projector: { project: (pt: any, sr: any) => any, Point: any } | null | undefined
async function getProjector (): Promise<{ project: (pt: any, sr: any) => any, Point: any } | null> {
    if (_projector !== undefined) return _projector
    try {
        const [op, Pt] = await loadArcGISJSAPIModules(['esri/geometry/operators/projectOperator', 'esri/geometry/Point'])
        if (op && typeof op.execute === 'function') {
            if (typeof op.load === 'function' && !(typeof op.isLoaded === 'function' && op.isLoaded())) await op.load()
            _projector = { project: (pt: any, sr: any) => op.execute(pt, sr), Point: Pt }
            return _projector
        }
    } catch (e) { /* fall through to 4.x */ }
    try {
        const [proj, Pt] = await loadArcGISJSAPIModules(['esri/geometry/projection', 'esri/geometry/Point'])
        if (proj && typeof proj.project === 'function') {
            if (typeof proj.load === 'function') await proj.load()
            _projector = { project: (pt: any, sr: any) => proj.project(pt, sr), Point: Pt }
            return _projector
        }
    } catch (e) { /* unavailable */ }
    _projector = null
    return null
}

export function getMapFrame(layout: PrintLayout): MapFrameEl {
    const mf = (layout.elements || []).find(e => e.type === 'mapFrame') as MapFrameEl
    if (!mf) throw new Error('Layout has no map frame element. Re-import the .pagx.')
    return mf
}

export async function composePage(
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
                // Settings-defined grid/graticule over the map, under the border.
                const gridCfg = layout.grid
                if (gridCfg && gridCfg.enabled && opts.showGrid !== false && cap.rotation === 0 &&
                    (gridCfg.type === 'reference' || cap.groundExtent)) {
                    const geom = opts.gridGeomOverride || (gridCfg.type === 'reference'
                        ? buildReferenceGrid(mf, Number(gridCfg.refCols) || 4, Number(gridCfg.refRows) || 4, gridCfg.labels !== false)
                        : buildGridGeometry(cap, mf, gridCfg))
                    try {
                        console.info('[print-advanced] grid gate OPEN: type=' + gridCfg.type +
                            ' geom=' + (geom ? (geom.lines.length + ' lines, ' + geom.ticks.length + ' ticks, ' + geom.crosses.length + ' crosses, ' + geom.labels.length + ' labels') : 'null'))
                    } catch (e) { /* noop */ }
                    if (geom) drawGrid(d, geom, gridCfg)
                } else if (gridCfg) {
                    try {
                        console.info('[print-advanced] grid gate CLOSED: enabled=' + String(gridCfg.enabled) +
                            ' showGrid=' + String(opts.showGrid) + ' rotation=' + String(cap.rotation) +
                            ' groundExtent=' + String(!!cap.groundExtent))
                    } catch (e) { /* noop */ }
                }
                if (mf.borderColor && mf.borderWidthPt > 0) {
                    d.setStroke(mf.borderColor[0], mf.borderColor[1], mf.borderColor[2])
                    d.setLineWidth(mf.borderWidthPt)
                    d.rect(x, y, w, h, 'S')
                }
                // Settings-defined overview inset: zoomed-out capture in a
                // corner of the map frame with an extent indicator.
                if (opts.overview) {
                    const ov = opts.overview
                    const bx = ov.box.xIn * PT_PER_IN
                    const by = ov.box.yIn * PT_PER_IN
                    const bw = ov.box.wIn * PT_PER_IN
                    const bh = ov.box.hIn * PT_PER_IN
                    await d.image(ov.cap.dataUrl, layout.imageFormat === 'png' ? 'PNG' : 'JPEG', bx, by, bw, bh)
                    const bc = ov.cfg.borderColor || [0, 0, 0]
                    d.setStroke(bc[0], bc[1], bc[2])
                    d.setLineWidth(ov.cfg.borderWidthPt > 0 ? ov.cfg.borderWidthPt : 1)
                    d.rect(bx, by, bw, bh, 'S')
                    const ic = ov.cfg.indicatorColor || [221, 0, 0]
                    d.setStroke(ic[0], ic[1], ic[2])
                    d.setLineWidth(ov.cfg.indicatorWidthPt > 0 ? ov.cfg.indicatorWidthPt : 1)
                    d.rect(ov.indicator.xIn * PT_PER_IN, ov.indicator.yIn * PT_PER_IN,
                        ov.indicator.wIn * PT_PER_IN, ov.indicator.hIn * PT_PER_IN, 'S')
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

function canvasRgba(canvas: HTMLCanvasElement): { data: Uint8ClampedArray, w: number, h: number } {
    const ctx = canvas.getContext('2d')
    if (!ctx) throw new Error('Canvas context unavailable.')
    return { data: ctx.getImageData(0, 0, canvas.width, canvas.height).data, w: canvas.width, h: canvas.height }
}

function encodePng8(canvas: HTMLCanvasElement): Blob {
    const { data, w, h } = canvasRgba(canvas)
    const buf: ArrayBuffer = UPNG.encode([data.buffer], w, h, 256)
    return new Blob([buf], { type: 'image/png' })
}

function encodeTiff(canvas: HTMLCanvasElement): Blob {
    const { data, w, h } = canvasRgba(canvas)
    const buf: ArrayBuffer = UTIF.encodeImage(data.buffer, w, h)
    return new Blob([buf], { type: 'image/tiff' })
}

function encodeGif(canvas: HTMLCanvasElement): Blob {
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
function encodeEps(canvas: HTMLCanvasElement, pageWPt: number, pageHPt: number): Blob {
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

async function gzipBlob(text: string): Promise<Blob> {
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
function normalizeFontUrl(url: string): string {
    const u = url.trim()
    // GitHub page URL -> raw file URL
    const gh = u.match(/^https:\/\/github\.com\/([^/]+)\/([^/]+)\/blob\/(.+)$/)
    if (gh) return `https://raw.githubusercontent.com/${gh[1]}/${gh[2]}/${gh[3]}`
    // Check the real hostname (anchored) rather than a substring match, so a URL
    // like https://evil.example/?x=fonts.googleapis.com cannot slip through.
    let host = ''
    try { host = new URL(u).hostname.toLowerCase() } catch (e) { host = '' }
    if (host === 'fonts.googleapis.com') {
        throw new Error('That is a Google Fonts CSS link, which serves WOFF2 - PDF embedding needs a TTF file. Open the font in the github.com/google/fonts repository and use the Raw URL of the .ttf.')
    }
    if (host === 'fonts.google.com') {
        throw new Error('That is a Google Fonts page link, not a font file. Open the font in the github.com/google/fonts repository and use the Raw URL of the .ttf.')
    }
    return u
}

/** Identify what a downloaded buffer actually is by magic number. */
function sniffFont(buf: ArrayBuffer): 'ttf' | 'otf-cff' | 'woff' | 'woff2' | 'text' | 'unknown' {
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

async function fetchFontBuffer(rawUrl: string): Promise<ArrayBuffer> {
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

function bufferToB64(url: string, buf: ArrayBuffer): string {
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
async function registerFontFace(name: string, url: string, boldUrl?: string): Promise<void> {
    const key = name + '|' + url + '|' + (boldUrl || '')
    if (registeredFaces.has(key)) return
    const normal = new FontFace(name, await fetchFontBuffer(url))
    await normal.load()
        ; (document as any).fonts.add(normal)
    if (boldUrl) {
        const bold = new FontFace(name, await fetchFontBuffer(boldUrl), { weight: 'bold' } as any)
        await bold.load()
            ; (document as any).fonts.add(bold)
    }
    registeredFaces.add(key)
}

/** Register the custom font with a jsPDF document. jsPDF swallows TTF parse
 *  errors internally ("PubSub Error ... No unicode cmap"), so verify via
 *  getFontList afterwards and abort cleanly instead of exporting a broken font. */
async function registerPdfFont(doc: jsPDF, name: string, url: string, boldUrl?: string): Promise<void> {
    const nb = bufferToB64(url, await fetchFontBuffer(url))
    const nfile = name + '-normal.ttf'
        ; (doc as any).addFileToVFS(nfile, nb)
        ; (doc as any).addFont(nfile, name, 'normal')
    const bUrl = boldUrl || url // no bold file -> reuse normal so 'bold' resolves
    const bb = bufferToB64(bUrl, await fetchFontBuffer(bUrl))
    const bfile = name + '-bold.ttf'
        ; (doc as any).addFileToVFS(bfile, bb)
        ; (doc as any).addFont(bfile, name, 'bold')
    // Verification must work on jsPDF 2.x AND 4.x. On 2.x a failed parse is
    // absent from getFontList; on 4.x it is listed but unusable (text() then
    // fails silently via PubSub). So check the list, then probe actual use.
    const list = (doc as any).getFontList ? (doc as any).getFontList() : null
    let ok = !list || !!list[name]
    if (ok) {
        try {
            ; (doc as any).setFont(name, 'normal')
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

export async function renderLayout(
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
        useLayout = ({
            ...layout, dpi, pageWidthIn: pw, pageHeightIn: ph,
            elements: [{ ...mfSrc, xIn: 0, yIn: 0, wIn: pw, hIn: ph }]
        } as PrintLayout)
    }
    const pageW = useLayout.pageWidthIn * PT_PER_IN
    const pageH = useLayout.pageHeightIn * PT_PER_IN
    const mf = getMapFrame(useLayout)

    const cap = await captureMapHiRes(liveView, mf.wIn, mf.hIn, useLayout, maxImagePx, options, onProgress)

    // A grid cannot be drawn correctly on a rotated capture or when an
    // output WKID reprojected the map; say so on the result instead of
    // drawing wrong lines.
    const gCfg = useLayout.grid
    // Forensic: report exactly what reached the renderer (harmless info log).
    try {
        console.info('[print-advanced] layout "' + useLayout.name + '" grid=' +
            JSON.stringify(gCfg || null) + ' overview=' + JSON.stringify(useLayout.overview || null) +
            ' showGrid=' + String(options.showGrid) + ' showOverview=' + String(options.showOverview) +
            ' rotation=' + String(cap.rotation) + ' groundExtent=' + String(!!cap.groundExtent) +
            ' projection=' + String(cap.projection))
    } catch (e) { /* logging must never break an export */ }
    if (gCfg && gCfg.enabled && options.showGrid !== false && !options.mapOnly) {
        if (cap.rotation !== 0) {
            cap.warning = (cap.warning ? cap.warning + ' ' : '') +
                'Grid skipped: the map is rotated. Reset rotation to 0 to print the grid.'
            onProgress('Grid skipped: the map is rotated.')
        } else if (gCfg.type !== 'reference' && !cap.groundExtent) {
            cap.warning = (cap.warning ? cap.warning + ' ' : '') +
                'Grid skipped: the map extent could not be determined for this capture.'
            onProgress('Grid skipped: no map extent.')
        } else if (gCfg.type === 'graticule' && cap.projection === 'projected') {
            // Lat/lon lines on an arbitrary projected output: build the
            // geometry with the JSAPI client-side projection engine.
            onProgress('Adding graticule (projecting coordinates)…')
            try {
                const projector = await getProjector()
                if (!projector) throw new Error('projection engine unavailable')
                const PointCls: any = projector.Point
                const capSR = new SpatialReference({ wkid: (options.outputWkid && options.outputWkid > 0)
                    ? options.outputWkid
                    : ((liveView.spatialReference as any)?.wkid || 4326) })
                const wgs = new SpatialReference({ wkid: 4326 })
                const toGeo = (x: number, y: number): [number, number] => {
                    const out: any = projector.project(new PointCls({ x, y, spatialReference: capSR }), wgs)
                    return out ? [out.x, out.y] : [NaN, NaN]
                }
                const fromGeo = (lon: number, lat: number): [number, number] => {
                    const out: any = projector.project(new PointCls({ x: lon, y: lat, spatialReference: wgs }), capSR)
                    return out ? [out.x, out.y] : [NaN, NaN]
                }
                const geomBuilt = buildGraticuleGeometry(cap.groundExtent, getMapFrame(useLayout), gCfg, toGeo, fromGeo)
                if (geomBuilt.lines.length || geomBuilt.ticks.length) {
                    options = { ...options, gridGeomOverride: geomBuilt }
                } else {
                    cap.warning = (cap.warning ? cap.warning + ' ' : '') +
                        'Graticule produced no lines for this extent; try a smaller fixed interval.'
                    onProgress('Graticule produced no lines for this extent.')
                }
            } catch (err: any) {
                cap.warning = (cap.warning ? cap.warning + ' ' : '') +
                    'Graticule unavailable: the projection engine failed to load.'
                onProgress('Graticule unavailable: projection engine failed to load.')
            }
        } else {
            onProgress(gCfg.type === 'reference' ? 'Adding reference grid…'
                : (gCfg.type === 'graticule' ? 'Adding graticule…' : 'Adding measured grid…'))
        }
    }

    // Settings-defined overview inset (skipped for map-only exports).
    const ovCfg = useLayout.overview
    if (ovCfg && ovCfg.enabled && options.showOverview !== false && !options.mapOnly) {
        const box = overviewBoxIn(mf, ovCfg)
        const mult = Number(ovCfg.scaleMultiplier) > 0 ? Number(ovCfg.scaleMultiplier) : 10
        const ovScale = Number(ovCfg.fixedScale) > 0 ? Number(ovCfg.fixedScale) : cap.printedScale * mult
        onProgress('Rendering overview map at 1:' + Math.round(ovScale).toLocaleString() + '…')
        const ovCap = await captureMapHiRes(
            liveView, box.wIn, box.hIn,
            { ...useLayout, dpi: Math.min(useLayout.dpi || 96, 150) },
            maxImagePx,
            {
                ...options,
                scaleMode: 'fixed',
                fixedScale: ovScale,
                lockedCenter: options.lockedCenter && typeof options.lockedCenter.x === 'number'
                    ? options.lockedCenter
                    : { x: liveView.center.x, y: liveView.center.y }
            },
            onProgress)
        options = {
            ...options,
            overview: {
                cap: ovCap,
                box,
                indicator: overviewIndicatorIn(box, mf.wIn, mf.hIn, cap.printedScale, ovScale),
                cfg: ovCfg
            }
        }
    }

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
        warning: cap.warning,
        printedScale: Math.round(cap.printedScale),
        url: lastUrl || undefined,
        sizeKb: lastSize ? Math.round(lastSize / 1024) : undefined
    }
}