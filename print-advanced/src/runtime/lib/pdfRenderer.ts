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
    TextEl, ScaleBarEl, LegendEl, MapFrameEl, PictureEl, NorthArrowEl, LineEl, OverviewConfig, GridConfig, LegendConfig, LegendPatchSize } from '../../config'
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
    /** Internal capture timeout override, in milliseconds. */
    maxWaitMs?: number
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
    /** Runtime user overrides from the widget's advanced options. */
    legendPositionOverride?: string
    gridTypeOverride?: string
    /** Bound Legend widget id ('' = automatic: first legend DOM found). */
    legendWidgetId?: string
    /** Internal: reports the computed legend panel so the live print-extent
     *  preview can match the shrunken frame on subsequent updates. */
    onPanelComputed?: (panel: { position: string, wIn: number, hIn: number }) => void
    /** Internal: prebuilt grid geometry (projection-engine graticules). */
    gridGeomOverride?: GridGeometry
    /** Internal: legend panel box (page inches) when the legend sits
     *  adjacent to the map instead of overlaying a corner. */
    legendBox?: { xIn: number, yIn: number, wIn: number, hIn: number }
    /** Internal: the ORIGINAL map frame bounds and border, stroked around
     *  map + legend panel together so the authored composition (corner
     *  stubs, heavy neatline) stays intact when the map shrinks. */
    legendPanelOuter?: { xIn: number, yIn: number, wIn: number, hIn: number, color: [number, number, number] | null, widthPt: number }
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

export interface LegendRow {
    kind: 'layer' | 'heading' | 'item' | 'note'
    label: string
    dataUrl?: string | null
    /** Flat color swatch alternative to an image (color ramps). */
    color?: [number, number, number] | null
    /** Nesting depth (group layers). */
    indent?: number
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
            new Promise(resolve => setTimeout(resolve, Number((opts as any).maxWaitMs) > 0 ? Number((opts as any).maxWaitMs) : 45000))
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

const _symbolSwatchCache = new Map<string, Promise<string | null>>()

async function symbolToDataUrl(symbol: any): Promise<string | null> {
    // cache by symbol JSON: identical symbols render once
    try {
        const key = symbol && typeof symbol.toJSON === 'function' ? JSON.stringify(symbol.toJSON()) : null
        if (key) {
            let hit = _symbolSwatchCache.get(key)
            if (!hit) {
                hit = symbolToDataUrlUncached(symbol)
                _symbolSwatchCache.set(key, hit)
                hit.then(v => { if (v === null) _symbolSwatchCache.delete(key) })
            }
            return hit
        }
    } catch (e) { /* fall through to uncached */ }
    return symbolToDataUrlUncached(symbol)
}

async function symbolToDataUrlUncached(symbol: any): Promise<string | null> {
    try {
        const el: HTMLElement = await (symbolUtils as any).renderPreviewHTML(symbol, { size: 18 })
        if (!el) return null
        const canvas = el instanceof HTMLCanvasElement ? el : el.querySelector('canvas')
        if (canvas) return (canvas as HTMLCanvasElement).toDataURL('image/png')
        // picture marker previews render as <img>
        const pimg = el.querySelector && el.querySelector('img')
        if (pimg && (pimg as HTMLImageElement).src) {
            const norm = await urlToDataUrl((pimg as HTMLImageElement).src)
            if (norm) return norm
        }
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

const MAX_LEGEND_ROWS = 400

/** Upgrade harvested legend rows with high-resolution REST swatches.
 *  Matching uses the row's label within the context of the most recent
 *  heading/layer names (map service sublayer names). Pure and exported
 *  for tests: services = [{ layers: [{ layerName, legend: [...] }] }]. */
export function matchRestSwatches (rows: LegendRow[], services: any[]): number {
    const norm = (x: any): string => String(x || '').trim().toLowerCase()
    interface Entry { layerName: string, items: Array<{ label: string, data: string }> }
    const entries: Entry[] = []
    for (const svc of services || []) {
        for (const lyr of (svc && svc.layers) || []) {
            const items = ((lyr && lyr.legend) || [])
                .filter((it: any) => it && it.imageData)
                .map((it: any) => ({
                    label: norm(it.label),
                    data: 'data:' + (it.contentType || 'image/png') + ';base64,' + it.imageData
                }))
            if (items.length) entries.push({ layerName: norm(lyr.layerName), items })
        }
    }
    if (!entries.length) return 0
    let upgraded = 0
    const context: string[] = []
    for (const r of rows) {
        if (r.kind === 'layer' || r.kind === 'heading') {
            context.push(norm(r.label))
            if (context.length > 4) context.shift()
            continue
        }
        if (r.kind !== 'item') continue
        const inContext = entries.filter(e => context.includes(e.layerName))
        const pool = inContext.length ? inContext : entries
        const lbl = norm(r.label)
        let hit: string | null = null
        if (lbl) {
            for (const e of pool) {
                const m = e.items.find(it => it.label === lbl)
                if (m) { hit = m.data; break }
            }
        } else {
            // unlabeled single-symbol sublayer: match by the nearest heading
            for (let c = context.length - 1; c >= 0 && !hit; c--) {
                const e = entries.find(en => en.layerName === context[c])
                if (e && e.items.length === 1) hit = e.items[0].data
            }
        }
        if (hit) { r.dataUrl = hit; upgraded++ }
    }
    return upgraded
}

/** Extract a swatch data URL from a legend symbol cell (canvas, img, or
 *  inline svg), normalizing anything that is not already a data URL. */
async function swatchFromCell (cell: Element | null): Promise<string | null> {
    if (!cell) return null
    try {
        const canvas = cell.querySelector('canvas') as HTMLCanvasElement | null
        if (canvas) {
            try { return canvas.toDataURL('image/png') } catch (e) { /* tainted */ }
        }
        const img = cell.querySelector('img') as HTMLImageElement | null
        if (img && img.src) {
            // already-rendered same-origin images can be copied via canvas
            try {
                if (img.complete && img.naturalWidth > 0) {
                    const c = document.createElement('canvas')
                    c.width = img.naturalWidth
                    c.height = img.naturalHeight
                    c.getContext('2d')?.drawImage(img, 0, 0)
                    return c.toDataURL('image/png')
                }
            } catch (e) { /* tainted -> fetch */ }
            return await urlToDataUrl(img.src)
        }
        const svg = cell.querySelector('svg')
        if (svg) {
            const xml = new XMLSerializer().serializeToString(svg)
            const url = 'data:image/svg+xml;base64,' + btoa(unescape(encodeURIComponent(xml)))
            return await new Promise<string | null>((resolve) => {
                const im = new Image()
                im.onload = () => {
                    try {
                        const SS = 3 // supersample vectors for crisp print swatches
                        const c = document.createElement('canvas')
                        c.width = (im.width || 36) * SS
                        c.height = (im.height || 36) * SS
                        const ctx = c.getContext('2d')
                        if (ctx) { ctx.scale(SS, SS); ctx.drawImage(im, 0, 0) }
                        resolve(c.toDataURL('image/png'))
                    } catch (e) { resolve(null) }
                }
                im.onerror = () => resolve(null)
                im.src = url
            })
        }
    } catch (e) { /* best-effort */ }
    return null
}

/** Harvest legend rows from a LIVE Legend widget's rendered DOM: exactly
 *  what the user sees, in the same order, swatches included. Returns []
 *  when the widget is not on screen (closed panel, different page). */
export async function harvestLegendDom (root: Element, labelsOnly?: boolean): Promise<LegendRow[]> {
    const rows: LegendRow[] = []
    const pending: Array<{ row: LegendRow, cell: Element | null }> = []
    const nodes = root.querySelectorAll(
        '.esri-legend__service-label, .esri-legend__layer-caption, .esri-legend__layer-row')
    for (let i = 0; i < nodes.length && rows.length < MAX_LEGEND_ROWS; i++) {
        const node = nodes[i]
        let indent = 0
        let layerDepth = 0
        let anc: Element | null = node.parentElement
        while (anc && anc !== root) {
            if (anc.classList) {
                if (anc.classList.contains('esri-legend__group-layer-child')) indent++
                if (anc.classList.contains('esri-legend__layer')) layerDepth++
            }
            anc = anc.parentElement
        }
        // nested sublayer tables (map services) indent like the widget
        indent += Math.max(0, layerDepth - 1)
        if (node.classList.contains('esri-legend__service-label')) {
            const label = (node.textContent || '').trim()
            if (label) rows.push({ kind: 'layer', label, indent })
        } else if (node.classList.contains('esri-legend__layer-caption')) {
            const label = (node.textContent || '').trim()
            if (label) rows.push({ kind: 'heading', label, indent })
        } else {
            const symCell = node.querySelector('.esri-legend__layer-cell--symbols')
            const infoCell = node.querySelector('.esri-legend__layer-cell--info')
            const label = infoCell ? (infoCell.textContent || '').trim() : ''
            const row: LegendRow = { kind: 'item', label, dataUrl: labelsOnly ? (symCell ? 'data:,' : null) : null, indent }
            rows.push(row)
            if (!labelsOnly) pending.push({ row, cell: symCell })
        }
    }
    // parallel swatch extraction (bounded): rows keep document order, only
    // the pixel work is concurrent
    if (pending.length) {
        const CONC = 8
        let next = 0
        const workers = new Array(Math.min(CONC, pending.length)).fill(0).map(async () => {
            while (next < pending.length) {
                const mine = pending[next++]
                mine.row.dataUrl = await swatchFromCell(mine.cell)
            }
        })
        await Promise.all(workers)
    }
    // drop leading orphan items with neither label nor swatch
    return rows.filter(r => r.kind !== 'item' || r.label || r.dataUrl)
}

/** Locate the bound (or any) Legend widget's legend DOM on the page.
 *  ExB wraps widgets differently across versions, so several container
 *  conventions are tried; if the bound widget cannot be located, this
 *  degrades to the first legend on the page (automatic behavior) rather
 *  than losing the legend entirely. */
export function findLegendDom (widgetId?: string): Element | null {
    try {
        if (widgetId) {
            const esc = (window as any).CSS && (CSS as any).escape ? (CSS as any).escape(widgetId) : widgetId
            const holders = [
                '[data-widgetid="' + widgetId + '"]',
                '[data-widget-id="' + widgetId + '"]',
                '.widget-renderer[data-widgetid="' + widgetId + '"]',
                '#' + esc,
                '.exbmap-ui [data-widgetid="' + widgetId + '"]'
            ]
            for (const sel of holders) {
                try {
                    const holder = document.querySelector(sel)
                    if (holder) {
                        const el = holder.querySelector('.esri-legend')
                        if (el) {
                            return el
                        }
                    }
                } catch (e2) { /* try next */ }
            }
        }
        return document.querySelector('.esri-legend')
    } catch (e) { return null }
}

/** Build legend rows from the JSAPI Legend widget's own model
 *  (activeLayerInfos), so the printed legend mirrors exactly what the
 *  Legend widget shows: layer visibility, legendEnabled, scale ranges,
 *  group layers, map-service sublayers, and every renderer type the API
 *  supports. Falls back to a renderer walk when the module is missing. */
export async function buildLegendRows(view: MapView, maxItems: number, onProgress: RenderProgress, legendWidgetId?: string): Promise<LegendRow[]> {
    onProgress('Building legend\u2026')
    // 1) a live Legend widget's rendered DOM: exactly what the user sees
    try {
        const dom = findLegendDom(legendWidgetId)
        if (dom) {
            const rows = await harvestLegendDom(dom)
            const items = rows.filter(r => r.kind === 'item')
            const withSwatch = items.filter(r => isEmbeddableSwatch(r.dataUrl)).length
            if (rows.length && withSwatch > 0) {
                // upgrade map-service swatches to print resolution: the DOM
                // bitmaps are screen-density; the REST legend at high dpi is not
                try {
                    const services: any[] = []
                    const svcLayers = (view.map.allLayers || ({ toArray: () => [] } as any))
                        .filter((l: any) => l.visible !== false && (l.type === 'map-image' || l.type === 'tile') && typeof l.url === 'string')
                    const arr: any[] = svcLayers.toArray ? svcLayers.toArray() : svcLayers
                    await Promise.all(arr.map(async (l: any) => {
                        try { services.push(await fetchRestLegend(l.url)) } catch (e) { /* per-service best-effort */ }
                    }))
                    const upgraded = matchRestSwatches(rows, services)
                } catch (e) { /* enrichment is best-effort */ }
                return rows.slice(0, MAX_LEGEND_ROWS)
            }
        } else {
        }
    } catch (e) { /* fall through */ }
    // 2) headless Legend model (+ REST swatch repair)
    try {
        const rows = await buildRowsFromLegendModel(view)
        if (rows.length) return rows.slice(0, MAX_LEGEND_ROWS)
    } catch (e) { /* fall through to renderer walk */ }
    // 3) renderer walk
    return buildRowsFromRenderers(view, Math.max(maxItems, 200))
}

/** Map a service /legend?f=json response for one sublayer into rows.
 *  Pure and exported for tests. */
export function mapRestLegendToRows (json: any, sublayerId: number, indent: number): LegendRow[] {
    const rows: LegendRow[] = []
    const entry = (json && json.layers || []).find((l: any) => l.layerId === sublayerId)
    if (!entry) return rows
    for (const item of (entry.legend || [])) {
        const data = item && item.imageData
            ? 'data:' + (item.contentType || 'image/png') + ';base64,' + item.imageData
            : null
        rows.push({ kind: 'item', label: (item && item.label) ? String(item.label) : '', dataUrl: data, indent })
    }
    return rows
}

/** Only data: URLs can be embedded by every export backend. */
export function isEmbeddableSwatch (src: string | null | undefined): boolean {
    return !!src && String(src).startsWith('data:')
}

let _esriRequestP: Promise<any> | null = null
function esriRequestModule (): Promise<any> {
    if (!_esriRequestP) _esriRequestP = loadArcGISJSAPIModules(['esri/request']).then(m => m[0])
    return _esriRequestP
}

const _swatchUrlCache = new Map<string, Promise<string | null>>()

/** Normalize an http(s)/blob swatch URL to a data URL so jsPDF and the
 *  raster/SVG backends can embed it. Goes through esri/request so portal
 *  tokens apply to secured services. Cached per URL: repeated symbols
 *  cost one fetch, not one per legend row. */
async function urlToDataUrl (src: string): Promise<string | null> {
    if (!src) return null
    if (src.startsWith('data:')) return src
    let p = _swatchUrlCache.get(src)
    if (!p) {
        p = (async () => {
            try {
                const esriRequest = await esriRequestModule()
                const res = await esriRequest(src, { responseType: 'blob' })
                const blob = res && res.data
                if (!blob) return null
                return await new Promise<string | null>((resolve) => {
                    const fr = new FileReader()
                    fr.onload = () => resolve(String(fr.result))
                    fr.onerror = () => resolve(null)
                    fr.readAsDataURL(blob)
                })
            } catch (e) { return null }
        })()
        _swatchUrlCache.set(src, p)
        // do not let a transient failure poison the cache forever
        p.then(v => { if (v === null) _swatchUrlCache.delete(src) })
    }
    return p
}

/** Server-rendered swatch resolution. ~3x screen density downscales
 *  crisply at print sizes. */
const LEGEND_SWATCH_DPI = 288

const _restLegendCache = new Map<string, Promise<any>>()

/** Fetch a map service's REST legend (server-rendered swatches), through
 *  esri/request so portal tokens and interceptors apply. Cached per URL. */
async function fetchRestLegend (serviceUrl: string, dpi: number = LEGEND_SWATCH_DPI): Promise<any> {
    const key = serviceUrl + '#' + dpi
    let p = _restLegendCache.get(key)
    if (!p) {
        p = (async () => {
            const esriRequest = await esriRequestModule()
            const res = await esriRequest(serviceUrl.replace(/\/$/, '') + '/legend', {
                query: { f: 'json', dpi },
                responseType: 'json'
            })
            return res && res.data
        })()
        _restLegendCache.set(key, p)
    }
    return p
}

/** Service URL + sublayer id for an ActiveLayerInfo that wraps a map
 *  service sublayer; null for anything else. */
function sublayerRestTarget (ali: any): { url: string, id: number } | null {
    const lyr = ali && ali.layer
    if (!lyr) return null
    const id = lyr.id
    if (typeof id !== 'number' || !isFinite(id)) return null
    const parent = lyr.layer // Sublayer -> parent MapImageLayer/TileLayer
    const url = (parent && typeof parent.url === 'string' && parent.url) ||
        (typeof lyr.url === 'string' ? lyr.url.replace(/\/\d+\/?$/, '') : '')
    if (!url) return null
    return { url, id }
}

async function buildRowsFromLegendModel(view: MapView): Promise<LegendRow[]> {
    const [LegendCls] = await loadArcGISJSAPIModules(['esri/widgets/Legend'])
    const holder = document.createElement('div')
    holder.style.cssText = 'position:absolute;left:-10000px;top:0;width:300px;height:10px;overflow:hidden;'
    document.body.appendChild(holder)
    const legend: any = new LegendCls({ view, container: holder })
    try {
        // Wait for the legend model to settle: activeLayerInfos populated and
        // each info past its loading state (children included).
        const deadline = Date.now() + 8000
        const settled = (): boolean => {
            const alis = legend.activeLayerInfos
            if (!alis || alis.length === 0) return false
            let ok = true
            alis.forEach((a: any) => { if (!infoSettled(a)) ok = false })
            return ok
        }
        const infoSettled = (a: any): boolean => {
            if (a.ready === false) return false
            if (a.children && a.children.length) {
                let ok = true
                a.children.forEach((c: any) => { if (!infoSettled(c)) ok = false })
                return ok
            }
            // a leaf without legend elements is usually still loading
            // (map service legends arrive async); the deadline bounds this
            return !!(a.legendElements && a.legendElements.length)
        }
        while (!settled() && Date.now() < deadline) {
            await new Promise(r => setTimeout(r, 150))
        }
        const rows: LegendRow[] = []
        const walk = async (ali: any, depth: number): Promise<void> => {
            if (rows.length >= MAX_LEGEND_ROWS) return
            const elements = (ali.legendElements || []) as any[]
            const kids = ali.children && ali.children.length ? ali.children.toArray ? ali.children.toArray() : ali.children : []
            if (!elements.length && !kids.length) return
            rows.push({ kind: 'layer', label: ali.title || 'Layer', indent: depth })
            for (const el of elements) {
                if (rows.length >= MAX_LEGEND_ROWS) return
                if (el.type === 'symbol-table') {
                    if (el.title && typeof el.title === 'string') {
                        rows.push({ kind: 'heading', label: el.title, indent: depth })
                    }
                    for (const info of (el.infos || [])) {
                        if (rows.length >= MAX_LEGEND_ROWS) return
                        // nested symbol tables (e.g. unique value groups)
                        if (info && info.type === 'symbol-table') {
                            if (info.title) rows.push({ kind: 'heading', label: String(info.title), indent: depth })
                            for (const sub of (info.infos || [])) {
                                if (rows.length >= MAX_LEGEND_ROWS) return
                                rows.push(await infoToRow(sub, depth))
                            }
                        } else {
                            rows.push(await infoToRow(info, depth))
                        }
                    }
                } else if (el.type === 'color-ramp' || el.type === 'size-ramp' || el.type === 'heatmap-ramp' || el.type === 'opacity-ramp') {
                    if (el.title && typeof el.title === 'string') {
                        rows.push({ kind: 'heading', label: String(el.title), indent: depth })
                    }
                    for (const info of (el.infos || [])) {
                        if (rows.length >= MAX_LEGEND_ROWS) return
                        const col = info && info.color
                            ? [info.color.r ?? info.color[0] ?? 0, info.color.g ?? info.color[1] ?? 0, info.color.b ?? info.color[2] ?? 0] as [number, number, number]
                            : null
                        const label = (info && (info.label || info.value != null)) ? String(info.label ?? info.value) : ''
                        if (label || col) rows.push({ kind: 'item', label, color: col, dataUrl: null, indent: depth })
                    }
                }
            }
            // Map service sublayers: server-side symbols often arrive as DOM
            // previews the headless model cannot serve. Replace any empty
            // swatches for this layer with the service's REST legend, which
            // returns the swatches as base64 images.
            const mine = rows.filter(r => r.kind === 'item' && r.indent === depth)
            const startedAt = rows.length
            const emptyItems = mine.filter(r => !isEmbeddableSwatch(r.dataUrl) && !r.color)
            if (emptyItems.length) {
                const target = sublayerRestTarget(ali)
                if (target) {
                    try {
                        const json = await fetchRestLegend(target.url)
                        const restRows = mapRestLegendToRows(json, target.id, depth)
                        if (restRows.length) {
                            // remove THIS layer's just-added item rows, keep its
                            // heading rows, append the REST-derived items
                            for (let i = rows.length - 1; i >= 0; i--) {
                                const r = rows[i]
                                if (r.kind === 'item' && r.indent === depth && !isEmbeddableSwatch(r.dataUrl) && !r.color) rows.splice(i, 1)
                                if (r.kind === 'layer' && r.indent === depth) break
                            }
                            rows.push(...restRows)
                        }
                    } catch (e) { /* REST legend is best-effort */ }
                }
            }
            void startedAt
            for (const kid of kids) await walk(kid, depth + 1)
        }
        const alis = legend.activeLayerInfos
        const top: any[] = alis && alis.toArray ? alis.toArray() : (alis || [])
        for (const ali of top) await walk(ali, 0)
        return rows
    } finally {
        try { legend.destroy() } catch (e) { /* noop */ }
        try { holder.remove() } catch (e) { /* noop */ }
    }
}

async function infoToRow(info: any, depth: number): Promise<LegendRow> {
    let dataUrl: string | null = null
    try {
        if (info && info.symbol) dataUrl = await symbolToDataUrl(info.symbol)
        if (!dataUrl && info && info.preview && info.preview.querySelector) {
            const canvas = info.preview.querySelector('canvas')
            if (canvas) {
                try { dataUrl = (canvas as HTMLCanvasElement).toDataURL('image/png') } catch (e) { /* tainted */ }
            }
            if (!dataUrl) {
                const img = info.preview.querySelector('img')
                if (img && img.src) dataUrl = await urlToDataUrl(img.src)
            }
        }
    } catch (e) { /* swatch is best-effort */ }
    return { kind: 'item', label: (info && info.label) ? String(info.label) : '', dataUrl, indent: depth }
}

/** Fallback: manual renderer walk (no JSAPI Legend module available). */
async function buildRowsFromRenderers(view: MapView, maxItems: number): Promise<LegendRow[]> {
    const rows: LegendRow[] = []
    let count = 0
    try {
        const layers = view.map.allLayers
            .filter((l: any) => l.visible && l.legendEnabled !== false && l.type === 'feature' && l.listMode !== 'hide')
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
                    rows.push({ kind: 'note', label: '(symbology not supported)' })
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
    // radial styles (circles, starbursts) must respect the element WIDTH
    // too: authored north-arrow frames are often tall and narrow, and a
    // height-based radius spills into neighboring furniture
    const radialR = Math.min(halfH, (W - pad * 2) / 2)
    const rScale = halfH > 0 ? radialR / halfH : 1
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
            d.circle(acx, acy, radialR, 'FD')
            const t2 = rot(0, -radialR * 0.8)
            const l2 = rot(-Math.min(arrowHalfW, radialR * 0.5) * 0.8, radialR * 0.7)
            const r2 = rot(Math.min(arrowHalfW, radialR * 0.5) * 0.8, radialR * 0.7)
            const k2 = rot(0, radialR * 0.35)
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
            const Rlong = radialR
            const Rshort = rose ? radialR * 0.45 : radialR * 0.62
            const inner = radialR * 0.13
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
            d.circle(acx, acy, radialR, 'F')
            const t2 = rot(0, -radialR * 0.62)
            const l2 = rot(-Math.min(arrowHalfW, radialR * 0.5) * 0.7, radialR * 0.28)
            const r2 = rot(Math.min(arrowHalfW, radialR * 0.5) * 0.7, radialR * 0.28)
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
        case 'alternating2': {
            // alternating fill with division ticks rising above the bar
            const tick = Math.min(3, barH * 0.5)
            for (let i = 0; i < segments; i++) {
                d.setFill(i % 2 === 0 ? r1 : r2, i % 2 === 0 ? g1 : g2, i % 2 === 0 ? b1 : b2)
                d.rect(x + i * segPt, top, segPt, barH, 'FD')
            }
            for (let i = 0; i <= segments; i++) {
                d.line(x + i * segPt, top, x + i * segPt, top - tick)
            }
            break
        }
        case 'line2': {
            // baseline at the top, ticks descend (labels sit below the bar)
            d.setLineWidth(1.2)
            d.line(x, top, x + barPt, top)
            for (let i = 0; i <= segments; i++) d.line(x + i * segPt, top, x + i * segPt, top + barH)
            break
        }
        case 'scaleLine2': {
            // center axis with full ticks crossing it
            d.setLineWidth(1.2)
            const cy = top + barH / 2
            d.line(x, cy, x + barPt, cy)
            for (let i = 0; i <= segments; i++) {
                d.line(x + i * segPt, top, x + i * segPt, top + barH)
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
            // baseline at the bottom, ticks rise (Pro's Line scale bar)
            d.setLineWidth(1.2)
            d.line(x, top + barH, x + barPt, top + barH)
            for (let i = 0; i <= segments; i++) d.line(x + i * segPt, top + barH, x + i * segPt, top)
            break
        }
        case 'steppedFilled': {
            // two-height alternation reads crisply at print sizes
            for (let i = 0; i < segments; i++) {
                const h = i % 2 === 0 ? barH : barH * 0.55
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

    // Dual semantics (Pro dual scale bars): a user-selected Double style is
    // a dual-measurement bar, ALWAYS two units. The second unit defaults to
    // the natural complement and can be overridden. Layout-default style
    // keeps the authored CIM bar untouched.
    const COMPLEMENT_UNIT: Record<ScaleBarUnits, ScaleBarUnits> = {
        miles: 'feet', feet: 'miles', meters: 'kilometers', kilometers: 'meters'
    }
    const userStyle = opts.scaleBarStyle
    const dualMode = userStyle === 'doubleAlternating' || userStyle === 'hollowDouble'
    const style: ScaleBarStyle = userStyle || el.style || 'doubleAlternating'
    const units: ScaleBarUnits = opts.scaleBarUnits || el.units
    const units2: ScaleBarUnits | undefined = dualMode
        ? ((opts.scaleBarUnits2 && opts.scaleBarUnits2 !== units) ? opts.scaleBarUnits2 : (COMPLEMENT_UNIT[units] || 'feet'))
        : undefined

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
        // 'line2' inverts the arrangement: bar first, numbers row below.
        const labelsBelow = style === 'line2'
        const groupH = labelSize + labelGap + barH
        const groupTop = boxY + Math.max(0, (boxH - groupH) / 2)
        const labelBaseline = labelsBelow ? groupTop + barH + labelGap + labelSize : groupTop + labelSize
        const barTop = labelsBelow ? groupTop : groupTop + labelSize + labelGap

        // Reserve space so a centred "0" fits on the left and the unit label fits on the right.
        const unitStr = UNIT_LABEL[units]
        const leftInset = labelSize * 0.35
        const unitReserve = textW(unitStr, unitSize) + textW('10,000', labelSize) / 2 + 12
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
        // single-mode unit on numbers row: '0 ... 0.5 ... 1 Miles', clear of
        // the centered end number (same convention as the dual bar)
        d.setFont('normal', Math.min(unitSize, labelSize + 2))
        d.text(unitStr, x0 + barPt + textW(fmt(dist), labelSize) / 2 + 5, labelBaseline, 'left')
        return
    }

    // Dual scale bar (Pro: upper and lower unit sharing the zero point). The whole
    // [upper labels | upper bar | lower bar | lower labels] group is centred in the frame.
    // double-banded styles need height for two visible rows; borrow from
    // the label bands if the frame is tight rather than collapsing to hairlines
    const isDoubleStyle = style === 'doubleAlternating' || style === 'hollowDouble'
    let labelBand = labelSize + 3
    const desiredBarH = isDoubleStyle ? Math.max(8, el.barHeightPt || 8) : (el.barHeightPt || 8) * 0.75
    let barH = Math.max(3, Math.min(desiredBarH, (boxH - 2 * labelBand) / 2))
    if (isDoubleStyle && barH < 6) {
        labelBand = labelSize + 1
        barH = Math.max(4, Math.min(desiredBarH, (boxH - 2 * labelBand) / 2))
    }
    const totalH = 2 * labelBand + 2 * barH
    const top0 = boxY + Math.max(0, (boxH - totalH) / 2)
    const upperTop = top0 + labelBand
    const axis = upperTop + barH

    const dualUnitSize = Math.min(unitSize, labelSize + 2)
    const uStr = UNIT_LABEL[units]
    const u2Str = UNIT_LABEL[units2]
    const leftInset = labelSize * 0.35
    // units sit on the number rows, after the end numbers: reserve room for
    // half the widest end number plus the unit word
    const endNumHalf = textW('10,000', labelSize) / 2
    const reserve = Math.max(textW(uStr, dualUnitSize), textW(u2Str, dualUnitSize)) + endNumHalf + 12
    const availIn = Math.max(0.2, (boxW - leftInset - reserve) / PT_PER_IN)
    const up = niceBarDistance(printedScale, units, availIn)
    const lo = niceBarDistance(printedScale, units2, availIn)
    const upPt = up.barIn * PT_PER_IN
    const loPt = lo.barIn * PT_PER_IN
    const x0 = boxX + leftInset

    // each measurement bar draws as the single-row counterpart of the
    // chosen Double style: two stacked single bars ARE the dual bar
    const barStyle: ScaleBarStyle = style === 'doubleAlternating' ? 'alternating'
        : style === 'hollowDouble' ? 'hollow' : style
    drawBarOfStyle(d, barStyle, x0, upperTop, upPt, barH, segments, el.color1, el.color2)
    drawBarOfStyle(d, barStyle, x0, axis, loPt, barH, segments, el.color2, el.color1)

    d.setTextColor(30, 30, 30)
    d.setFont('normal', labelSize)
    const upY = upperTop - 3
    d.text('0', x0, upY, 'center')
    if (midLabels) d.text(fmt(up.dist / 2), x0 + upPt / 2, upY, 'center')
    d.text(fmt(up.dist), x0 + upPt, upY, 'center')
    const loY = Math.max(axis + barH + labelSize * 0.9, Math.min(axis + barH + labelSize, boxY + boxH - labelSize * 0.1))
    if (midLabels) d.text(fmt(lo.dist / 2), x0 + loPt / 2, loY, 'center')
    d.text(fmt(lo.dist), x0 + loPt, loY, 'center')
    // unit words share the number rows (Pro-style: '... 1 Miles'), placed
    // clear of the centered end numbers
    d.setFont('normal', dualUnitSize)
    const upEndHalf = textW(fmt(up.dist), labelSize) / 2
    const loEndHalf = textW(fmt(lo.dist), labelSize) / 2
    d.text(uStr, x0 + upPt + upEndHalf + 5, upY, 'left')
    d.text(u2Str, x0 + loPt + loEndHalf + 5, loY, 'left')
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

/* ------------------------------------------------------------------ */
/* Legend layout engine (pure, testable)                                */
/* ------------------------------------------------------------------ */

export const LEGEND_DEFAULTS: LegendConfig = {
    enabled: false,
    position: 'rightPanel',
    widthIn: 3,
    heightIn: 3.5,
    marginIn: 0.25,
    title: 'Legend',
    showTitle: true,
    columns: 0,
    baseFontPt: 8,
    patchSize: 'medium',
    showLayerNames: true,
    background: true,
    bgColor: [255, 255, 255],
    borderColor: [150, 150, 150],
    borderWidthPt: 0.5
}

export interface PlacedLegendItem {
    row: LegendRow
    xPt: number
    yPt: number
    labelLines: string[]
    fontPt: number
    patchWPt: number
    patchHPt: number
    heightPt: number
}

export interface LegendLayout {
    columns: number
    colWidthPt: number
    fontPt: number
    items: PlacedLegendItem[]
    truncated: number
    titleFontPt: number
    usedHeightPt: number
}

export function legendPatchPt (size: LegendPatchSize | undefined, fontPt: number): { w: number, h: number } {
    const base = size === 'small' ? 9 : size === 'large' ? 18 : 13
    // Patches shrink proportionally with the font (Pro's AdjustFontSize
    // behavior); otherwise a fixed patch height defeats the shrink pass.
    const scaled = base * Math.min(1, fontPt / 8)
    const h = Math.max(fontPt + 2, scaled)
    return { w: h * 1.5, h }
}

/** Fit legend rows into a box. Strategy chain in the spirit of Pro's
 *  fitting strategies: try column counts (auto), then shrink the font,
 *  then truncate with an honest "+ N more" footer. Pure and testable:
 *  the measurement callback abstracts the Drawer. */
export function layoutLegend (
    rows: LegendRow[],
    boxWPt: number,
    boxHPt: number,
    cfg: LegendConfig,
    measure: (text: string, fontPt: number) => number
): LegendLayout {
    const pad = 8
    const gutter = 10
    const innerW = boxWPt - pad * 2
    const titleFontPt = cfg.showTitle !== false ? Math.max(9, (cfg.baseFontPt || 8) + 3) : 0
    const titleH = cfg.showTitle !== false ? titleFontPt + 10 : 4
    const innerH = boxHPt - pad - titleH - pad / 2

    const filtered = rows.filter(r => cfg.showLayerNames !== false || r.kind !== 'layer')

    interface Block { rows: LegendRow[] }
    const blocks: Block[] = []
    let cur: Block | null = null
    for (const r of filtered) {
        if (r.kind === 'layer') { cur = { rows: [r] }; blocks.push(cur) }
        else {
            if (!cur) { cur = { rows: [] }; blocks.push(cur) }
            cur.rows.push(r)
        }
    }

    let hardBreaks = 0
    const wrap = (text: string, width: number, fontPt: number, maxLines: number): string[] => {
        // tokens wider than the column split on slash/hyphen boundaries,
        // then character-by-character as a last resort, so unbreakable
        // labels like STORM/IRRIGATION can never overrun the neatline
        const words: string[] = []
        for (const raw of (text || '').split(/\s+/).filter(Boolean)) {
            if (measure(raw, fontPt) <= width) { words.push(raw); continue }
            const parts: string[] = []
            let buf = ''
            for (const ch of raw) {
                buf += ch
                if (ch === '/' || ch === '-') { parts.push(buf); buf = '' }
            }
            if (buf) parts.push(buf)
            for (const part of parts) {
                if (measure(part, fontPt) <= width) { words.push(part); continue }
                // character-level chunking is a last resort: count it so the
                // fit search can prefer layouts that avoid it, and hyphenate
                const hyphenW = measure('-', fontPt)
                let chunk = ''
                for (const ch of part) {
                    if (!chunk || measure(chunk + ch, fontPt) <= width - hyphenW) chunk += ch
                    else { hardBreaks++; words.push(chunk + '-'); chunk = ch }
                }
                if (chunk) words.push(chunk)
            }
        }
        const joins = (a: string, b2: string): string =>
            (a.endsWith('/')) ? a + b2 : a + ' ' + b2
        const lines: string[] = []
        let line = ''
        for (const w of words) {
            const cand = line ? joins(line, w) : w
            if (measure(cand, fontPt) <= width || !line) line = cand
            else {
                lines.push(line); line = w
                if (lines.length === maxLines) break
            }
        }
        if (line && lines.length < maxLines) lines.push(line)
        if (lines.length === 0) lines.push('')
        const kept = lines.join(' ').length
        if (kept + 2 < (text || '').trim().length) {
            let last = lines[lines.length - 1]
            while (last.length && measure(last + '\u2026', fontPt) > width) last = last.slice(0, -1)
            lines[lines.length - 1] = last + '\u2026'
        }
        // safety clamp: no line may exceed the column, ellipsis if needed
        for (let i = 0; i < lines.length; i++) {
            if (measure(lines[i], fontPt) > width) {
                let t = lines[i]
                while (t.length && measure(t + '\u2026', fontPt) > width) t = t.slice(0, -1)
                lines[i] = t + '\u2026'
            }
        }
        return lines
    }

    const measureRow = (r: LegendRow, fontPt: number, colW: number): { h: number, lines: string[] } => {
        const indentPt = (r.indent || 0) * 8
        if (r.kind === 'layer') {
            const lines = wrap(r.label, colW - indentPt, fontPt + 1, 2)
            return { h: lines.length * (fontPt + 5) + 3, lines }
        }
        if (r.kind === 'heading') {
            return { h: fontPt + 5, lines: wrap(r.label, colW - indentPt - 4, fontPt, 1) }
        }
        if (r.kind === 'note') {
            return { h: fontPt + 4, lines: wrap(r.label, colW - indentPt, Math.max(5, fontPt - 1), 1) }
        }
        const patch = legendPatchPt(cfg.patchSize, fontPt)
        const maxItemLines = 3
        const lines = wrap(r.label, colW - indentPt - patch.w - 8, fontPt, maxItemLines)
        return { h: Math.max(patch.h + 5, lines.length * (fontPt + 2) + 4), lines }
    }

    const tryFit = (cols: number, fontPt: number): LegendLayout | null => {
        const colW = (innerW - gutter * (cols - 1)) / cols
        if (colW < 50) return null
        const patch = legendPatchPt(cfg.patchSize, fontPt)
        const flow = (target: number): LegendLayout | null => {
            const items: PlacedLegendItem[] = []
            let col = 0
            let y = 0
            let maxBottom = 0
            for (const blk of blocks) {
                const headH = blk.rows.length ? measureRow(blk.rows[0], fontPt, colW).h : 0
                const firstItemH = blk.rows.length > 1 ? measureRow(blk.rows[1], fontPt, colW).h : 0
                if (y > 0 && y + headH + firstItemH > target) { col++; y = 0 }
                for (const r of blk.rows) {
                    const mm = measureRow(r, fontPt, colW)
                    if (y + mm.h > (y === 0 ? innerH : target)) { col++; y = 0 }
                    if (col >= cols) return null
                    items.push({
                        row: r,
                        xPt: pad + col * (colW + gutter),
                        yPt: titleH + pad / 2 + y,
                        labelLines: mm.lines,
                        fontPt,
                        patchWPt: patch.w,
                        patchHPt: patch.h,
                        heightPt: mm.h
                    })
                    y += mm.h
                    maxBottom = Math.max(maxBottom, titleH + pad / 2 + y)
                }
            }
            return { columns: cols, colWidthPt: colW, fontPt, items, truncated: 0, titleFontPt, usedHeightPt: maxBottom + pad }
        }
        // balance columns: aim for equal heights, fall back to strict fill
        if (cols > 1) {
            let total = 0
            for (const blk of blocks) for (const r of blk.rows) total += measureRow(r, fontPt, colW).h
            const target = Math.min(innerH, Math.max(total / cols * 1.05, innerH * 0.25))
            const balanced = flow(target)
            if (balanced) return balanced
        }
        return flow(innerH)
    }

    const prefCols = cfg.columns && cfg.columns > 0 ? Math.min(6, Math.round(cfg.columns)) : 0
    const colsList = prefCols ? Array.from({ length: prefCols }, (_, i) => i + 1) : [1, 2, 3, 4]
    const baseFont = Math.max(5, cfg.baseFontPt || 8)
    const noShrink = !!(cfg as any).noShrink

    // Break-aware search: for each column count, find the largest font that
    // fits, and the largest that fits with ZERO forced word breaks. A clean
    // layout always beats a mangled one; then larger font; then the
    // configured column preference; then wider columns (fewer of them).
    interface Cand { lay: LegendLayout, cols: number, font: number, breaks: number }
    const clean: Cand[] = []
    const any: Cand[] = []
    for (const cols of colsList) {
        const fonts: number[] = []
        if (noShrink) fonts.push(baseFont)
        else for (let f = baseFont; f >= 5; f -= 0.5) fonts.push(f)
        let recordedAny = false
        for (const f of fonts) {
            hardBreaks = 0
            const lay = tryFit(cols, f)
            if (!lay) continue
            const cand = { lay, cols, font: f, breaks: hardBreaks }
            if (!recordedAny) { any.push(cand); recordedAny = true }
            if (cand.breaks === 0) { clean.push(cand); break }
        }
    }
    const pick = (list: Cand[]): LegendLayout | null => {
        if (!list.length) return null
        list.sort((a2, b2) =>
            (b2.font - a2.font) ||
            ((prefCols ? (a2.cols === prefCols ? 0 : 1) - (b2.cols === prefCols ? 0 : 1) : 0)) ||
            (a2.cols - b2.cols))
        return list[0].lay
    }
    const chosen = pick(clean) || pick(any)
    if (chosen) return chosen
    const maxCols = colsList[colsList.length - 1]
    // Truncate at minimum font, honest footer with the remainder count.
    const minFont = (cfg as any).noShrink ? baseFont : 5
    const colW = (innerW - gutter * (maxCols - 1)) / maxCols
    const items: PlacedLegendItem[] = []
    const patch = legendPatchPt(cfg.patchSize, minFont)
    const footerH = minFont + 9
    const flat = blocks.flatMap(bk => bk.rows)
    let col = 0
    let y = 0
    let i = 0
    for (; i < flat.length; i++) {
        const mm = measureRow(flat[i], minFont, colW)
        const reserve = col === maxCols - 1 ? footerH : 0
        if (y + mm.h > innerH - reserve) { col++; y = 0 }
        if (col >= maxCols) break
        items.push({ row: flat[i], xPt: pad + col * (colW + gutter), yPt: titleH + pad / 2 + y, labelLines: mm.lines, fontPt: minFont, patchWPt: patch.w, patchHPt: patch.h, heightPt: mm.h })
        y += mm.h
    }
    // widow control on the truncated tail: never end on a bare heading
    while (items.length && (items[items.length - 1].row.kind === 'layer' || items[items.length - 1].row.kind === 'heading')) {
        items.pop()
    }
    const truncated = flat.slice(i).filter(r => r.kind === 'item').length
    return { columns: maxCols, colWidthPt: colW, fontPt: minFont, items, truncated, titleFontPt, usedHeightPt: boxHPt }
}

export function approxTextWidthPt (text: string, fontPt: number): number {
    return (text || '').length * fontPt * 0.52
}

export interface LegendPanelResult {
    box: { xIn: number, yIn: number, wIn: number, hIn: number }
    mapFrame: { xIn: number, yIn: number, wIn: number, hIn: number }
}

/** Dynamically size a legend panel ADJACENT to the map: the map frame
 *  shrinks to make room instead of the legend overlaying map content.
 *  Panel size follows the legend content at the configured font, clamped
 *  so the map keeps at least 55% of its original dimension. */
/** Trim a panel rectangle so it does not overlap other layout elements
 *  (pictures, texts, scale bars authored over the frame corners). Trims
 *  from whichever end preserves more panel; vertical for side panels,
 *  horizontal for the bottom panel. */
export function trimPanelBox (
    box: { xIn: number, yIn: number, wIn: number, hIn: number },
    others: Array<{ xIn: number, yIn: number, wIn: number, hIn: number }>,
    vertical: boolean
): { xIn: number, yIn: number, wIn: number, hIn: number } {
    const EPS = 0.02
    const GAP = 0.08
    let b = { ...box }
    for (const o of others || []) {
        if (!o || !(o.wIn > 0) || !(o.hIn > 0)) continue
        const ix = Math.min(b.xIn + b.wIn, o.xIn + o.wIn) - Math.max(b.xIn, o.xIn)
        const iy = Math.min(b.yIn + b.hIn, o.yIn + o.hIn) - Math.max(b.yIn, o.yIn)
        if (ix <= EPS || iy <= EPS) continue
        if (vertical) {
            const topSpace = o.yIn - b.yIn                    // panel kept above the element
            const bottomSpace = (b.yIn + b.hIn) - (o.yIn + o.hIn) // panel kept below it
            if (topSpace >= bottomSpace) {
                b = { ...b, hIn: Math.max(0, topSpace - GAP) }
            } else {
                const newTop = o.yIn + o.hIn + GAP
                b = { ...b, yIn: newTop, hIn: Math.max(0, b.yIn + b.hIn - newTop) }
            }
        } else {
            const leftSpace = o.xIn - b.xIn
            const rightSpace = (b.xIn + b.wIn) - (o.xIn + o.wIn)
            if (leftSpace >= rightSpace) {
                b = { ...b, wIn: Math.max(0, leftSpace - GAP) }
            } else {
                const newLeft = o.xIn + o.wIn + GAP
                b = { ...b, xIn: newLeft, wIn: Math.max(0, b.xIn + b.wIn - newLeft) }
            }
        }
    }
    return b
}

export function computeLegendPanel (
    rows: LegendRow[],
    mf: { xIn: number, yIn: number, wIn: number, hIn: number },
    cfg: LegendConfig,
    others: Array<{ xIn: number, yIn: number, wIn: number, hIn: number }> = []
): LegendPanelResult | null {
    const posn = cfg.position as string
    if (posn !== 'leftPanel' && posn !== 'rightPanel' && posn !== 'bottomPanel') return null
    const gapIn = 0.08
    const font = Math.max(5, cfg.baseFontPt || 8)
    const patch = legendPatchPt(cfg.patchSize, font)
    const PT = 72
    const rowH = (r: LegendRow): number => {
        if (r.kind === 'layer') return font + 9
        if (r.kind === 'heading' || r.kind === 'note') return font + 5
        return Math.max(patch.h + 5, font + 6)
    }
    const rowW = (r: LegendRow): number => {
        const indent = (r.indent || 0) * 8
        if (r.kind === 'layer') return indent + approxTextWidthPt(r.label, font + 1)
        if (r.kind === 'heading' || r.kind === 'note') return indent + approxTextWidthPt(r.label, font) + 4
        return indent + patch.w + 8 + approxTextWidthPt(r.label, font)
    }
    const totalH = rows.reduce((a, r) => a + rowH(r), 0)
    const maxRowW = rows.reduce((a, r) => Math.max(a, rowW(r)), 60)
    const pad = 8
    const gutter = 10
    const titleH = cfg.showTitle !== false ? Math.max(9, font + 3) + 10 : 4
    if (posn === 'bottomPanel') {
        const innerW = mf.wIn * PT - pad * 2
        const colW = Math.max(90, Math.min(maxRowW, 220))
        const cols = Math.max(1, Math.min(6, Math.floor((innerW + gutter) / (colW + gutter))))
        const hPt = titleH + Math.ceil(totalH / cols) + pad * 2
        const fixed = (cfg as any).panelSizeMode === 'fixed' && Number(cfg.heightIn) > 0
        const hIn = Math.min(mf.hIn * 0.45, Math.max(0.8, fixed ? Number(cfg.heightIn) : hPt / PT))
        return {
            box: trimPanelBox({ xIn: mf.xIn, yIn: mf.yIn + mf.hIn - hIn, wIn: mf.wIn, hIn }, others, false),
            mapFrame: { xIn: mf.xIn, yIn: mf.yIn, wIn: mf.wIn, hIn: mf.hIn - hIn - gapIn }
        }
    }
    const oneColH = titleH + totalH + pad * 2
    const cols = oneColH <= mf.hIn * PT ? 1 : 2
    const wPt = pad * 2 + cols * Math.min(maxRowW, 220) + (cols - 1) * gutter
    const fixed = (cfg as any).panelSizeMode === 'fixed' && Number(cfg.widthIn) > 0
    const wIn = Math.min(mf.wIn * 0.45, Math.max(1.4, fixed ? Number(cfg.widthIn) : wPt / PT))
    if (posn === 'leftPanel') {
        return {
            box: trimPanelBox({ xIn: mf.xIn, yIn: mf.yIn, wIn, hIn: mf.hIn }, others, true),
            mapFrame: { xIn: mf.xIn + wIn + gapIn, yIn: mf.yIn, wIn: mf.wIn - wIn - gapIn, hIn: mf.hIn }
        }
    }
    return {
        box: trimPanelBox({ xIn: mf.xIn + mf.wIn - wIn, yIn: mf.yIn, wIn, hIn: mf.hIn }, others, true),
        mapFrame: { xIn: mf.xIn, yIn: mf.yIn, wIn: mf.wIn - wIn - gapIn, hIn: mf.hIn }
    }
}

/** Split legend rows into as many full pages as needed, keeping the base
 *  font (no shrinking, no truncation across the whole document). Blocks
 *  that split across pages repeat their heading with '(continued)'.
 *  Pure and exported for tests. */
export function paginateLegendRows (
    rows: LegendRow[],
    boxWPt: number,
    boxHPt: number,
    cfg: LegendConfig,
    measure: (text: string, fontPt: number) => number,
    maxPages: number = 10
): LegendRow[][] {
    const pages: LegendRow[][] = []
    let remaining = rows.slice()
    let guard = 0
    while (remaining.length && pages.length < maxPages && guard++ < maxPages * 2) {
        const L = layoutLegend(remaining, boxWPt, boxHPt, { ...(cfg as any), noShrink: true } as LegendConfig, measure)
        const placedSet = new Set(L.items.map(it => it.row))
        let placed = remaining.filter(r => placedSet.has(r))
        if (!placed.length) {
            // a single row taller than the page: force it through alone
            placed = [remaining[0]]
        }
        pages.push(placed)
        const placedAll = new Set(placed)
        remaining = remaining.filter(r => !placedAll.has(r))
        if (remaining.length && remaining[0].kind === 'item') {
            // repeat the split block's heading for context
            for (let i = placed.length - 1; i >= 0; i--) {
                const r = placed[i]
                if (r.kind === 'heading' || r.kind === 'layer') {
                    remaining = [{ kind: r.kind, label: r.label + ' (continued)', indent: r.indent }, ...remaining]
                    break
                }
            }
        }
    }
    return pages
}

/** Compose a dedicated legend page: same sheet size and orientation as
 *  the map page, 0.5in margins, fitting engine given the whole sheet. */
export async function drawLegendPage (d: Drawer, pageWIn: number, pageHIn: number, rows: LegendRow[], cfgIn?: LegendConfig): Promise<void> {
    const margin = 0.5
    const el: LegendEl = {
        type: 'legend',
        name: 'legendPage',
        xIn: margin,
        yIn: margin,
        wIn: Math.max(1, pageWIn - margin * 2),
        hIn: Math.max(1, pageHIn - margin * 2),
        maxItems: 0
    } as LegendEl
    await drawLegendEl(d, el, rows, cfgIn, true)
}

async function drawLegendEl (d: Drawer, el: LegendEl, rows: LegendRow[], cfgIn?: LegendConfig, isPanel?: boolean): Promise<number> {
    const cfg: LegendConfig = { ...LEGEND_DEFAULTS, ...(cfgIn || {}), enabled: true }
    const lx = el.xIn * PT_PER_IN
    const ly = el.yIn * PT_PER_IN
    const lw = el.wIn * PT_PER_IN
    const lh = el.hIn * PT_PER_IN

    const layout = layoutLegend(rows, lw, lh, cfg, (t, f) => { d.setFont('normal', f); return d.textWidth(t) })
    // Panels sit beside the map inside the composition frame: no inner
    // border box, and the background covers the full panel strip.
    const boxH = isPanel ? lh : Math.min(lh, Math.max(layout.usedHeightPt, layout.titleFontPt + 20))

    if (cfg.background !== false) {
        const bg = cfg.bgColor || [255, 255, 255]
        d.setFill(bg[0], bg[1], bg[2])
        if (!isPanel && cfg.borderWidthPt > 0) {
            const bc = cfg.borderColor || [150, 150, 150]
            d.setStroke(bc[0], bc[1], bc[2])
            d.setLineWidth(cfg.borderWidthPt)
            d.roundedRect(lx, ly, lw, boxH, 2, 'FD')
        } else {
            d.rect(lx, ly, lw, boxH, 'F')
        }
    }

    if (cfg.showTitle !== false) {
        d.setFont('bold', layout.titleFontPt)
        d.setTextColor(30, 30, 30)
        d.text(cfg.title || 'Legend', lx + 8, ly + layout.titleFontPt + 6)
    }

    for (const it of layout.items) {
        const r = it.row
        const indentPt = (r.indent || 0) * 8
        const x = lx + it.xPt + indentPt
        const y = ly + it.yPt
        if (r.kind === 'layer') {
            d.setFont('bold', it.fontPt + 1)
            d.setTextColor(30, 30, 30)
            let ty = y + it.fontPt + 3
            for (const line of it.labelLines) { d.text(line, x, ty); ty += it.fontPt + 5 }
        } else if (r.kind === 'heading') {
            d.setFont('italic', it.fontPt)
            d.setTextColor(70, 70, 70)
            d.text(it.labelLines[0] || '', x + 2, y + it.fontPt + 1)
        } else if (r.kind === 'note') {
            d.setFont('italic', Math.max(5, it.fontPt - 1))
            d.setTextColor(120, 120, 120)
            d.text(it.labelLines[0] || '', x, y + it.fontPt + 1)
        } else {
            const py = y + 2
            if (r.dataUrl) {
                // contain fit: line swatches stay wide and thin, markers stay
                // round; never stretch a symbol into the patch box
                try { await d.image(r.dataUrl, 'PNG', x + 2, py, it.patchWPt, it.patchHPt, 'contain', 'left', 'center') } catch (e) {
                    d.setFill(210, 210, 210); d.rect(x + 2, py, it.patchWPt, it.patchHPt, 'F')
                }
            } else if (r.color) {
                d.setFill(r.color[0], r.color[1], r.color[2])
                d.setStroke(120, 120, 120)
                d.setLineWidth(0.4)
                d.rect(x + 2, py, it.patchWPt, it.patchHPt, 'FD')
            } else {
                d.setFill(228, 228, 228); d.rect(x + 2, py, it.patchWPt, it.patchHPt, 'F')
            }
            d.setFont('normal', it.fontPt)
            d.setTextColor(50, 50, 50)
            let ty = py + Math.min(it.patchHPt - 1, it.fontPt + 2)
            for (const line of it.labelLines) { d.text(line, x + it.patchWPt + 8, ty); ty += it.fontPt + 2 }
        }
    }

    if (layout.truncated > 0) {
        d.setFont('italic', Math.max(5, layout.fontPt))
        d.setTextColor(120, 120, 120)
        d.text('+ ' + layout.truncated + ' more item' + (layout.truncated === 1 ? '' : 's') + ' not shown',
            lx + 8, ly + boxH - 5)
    }
    return layout.truncated
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
interface BoxIn { xIn: number, yIn: number, wIn: number, hIn: number }

function boxesIntersect (a: BoxIn, b: BoxIn): boolean {
    const eps = 0.01
    return !(a.xIn + a.wIn <= b.xIn + eps || b.xIn + b.wIn <= a.xIn + eps ||
             a.yIn + a.hIn <= b.yIn + eps || b.yIn + b.hIn <= a.yIn + eps)
}

/** Corner-overlay placement that avoids overlapping other content inside
 *  the map frame (overview inset, authored elements over the frame).
 *  Strategy: keep the configured corner if free; otherwise slide within
 *  the corner column past the obstacles; otherwise try the other corners
 *  (same edge first). Pure and exported for tests. */
export function resolveLegendCorner (
    mf: BoxIn,
    cfg: { position: string, widthIn: number, heightIn: number, marginIn: number },
    obstacles: BoxIn[]
): BoxIn {
    const mk = (position: string): BoxIn => overviewBoxIn(mf, { ...cfg, position } as any)
    const inside = (b: BoxIn): boolean =>
        b.xIn >= mf.xIn - 0.01 && b.yIn >= mf.yIn - 0.01 &&
        b.xIn + b.wIn <= mf.xIn + mf.wIn + 0.01 && b.yIn + b.hIn <= mf.yIn + mf.hIn + 0.01
    const clear = (b: BoxIn): boolean => !obstacles.some(o => boxesIntersect(b, o))
    const pos = cfg.position || 'bottomLeft'
    const base = mk(pos)
    if (clear(base)) return base
    // slide vertically within the corner column, past every obstacle hit
    const gap = 0.08
    const top = pos === 'topLeft' || pos === 'topRight'
    let slid: BoxIn = { ...base }
    for (let pass = 0; pass < 4; pass++) {
        const hits = obstacles.filter(o => boxesIntersect(slid, o))
        if (!hits.length) break
        if (top) {
            const below = Math.max(...hits.map(o => o.yIn + o.hIn)) + gap
            slid = { ...slid, yIn: below }
        } else {
            const above = Math.min(...hits.map(o => o.yIn)) - gap - slid.hIn
            slid = { ...slid, yIn: above }
        }
    }
    if (inside(slid) && clear(slid)) return slid
    // try other corners: same horizontal edge first, then the rest
    const order = ['topLeft', 'topRight', 'bottomLeft', 'bottomRight']
        .filter(c => c !== pos)
        .sort((a2, b2) => {
            const sameEdge = (c: string): number => ((c.startsWith('top') === top) ? 0 : 1)
            return sameEdge(a2) - sameEdge(b2)
        })
    for (const c of order) {
        const cand = mk(c)
        if (clear(cand)) return cand
    }
    return base
}

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
                    if (geom) drawGrid(d, geom, gridCfg)
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
                {
                    const miss = await drawLegendEl(d, el as LegendEl, legendRows, layout.legend)
                    if (miss > 0) (opts as any)._legendTruncated = Math.max(Number((opts as any)._legendTruncated) || 0, miss)
                }
                break
        }
    }

    // Settings-defined legend (no legend frame in the .pagx): draw last so
    // it sits above the map, grid, and inset, in the configured corner of
    // the map frame. Suppressed by the runtime toggle via legendRows = [].
    const lCfg = layout.legend
    const pagxHasLegend = (layout.elements || []).some(e => (e as LayoutElement).type === 'legend')
    if (lCfg && lCfg.enabled && String(lCfg.position || '') !== 'secondPage' &&
        !pagxHasLegend && legendRows.length && opts.includeLegend !== false) {
        try {
            const mf = getMapFrame(layout)
            const box = opts.legendBox || (() => {
                const cornerCfg = {
                    position: String(lCfg.position || 'bottomLeft'),
                    widthIn: lCfg.widthIn || 3,
                    heightIn: lCfg.heightIn || 3.5,
                    marginIn: lCfg.marginIn ?? 0.25
                }
                const obstacles: Array<{ xIn: number, yIn: number, wIn: number, hIn: number }> = []
                const ovc: any = (layout as any).overview
                if (ovc && ovc.enabled && opts.showOverview !== false) {
                    obstacles.push(overviewBoxIn(mf, ovc))
                }
                for (const e of (layout.elements || []) as any[]) {
                    if (e.type === 'mapFrame' || e.type === 'line' || e.type === 'legend') continue
                    if (!(typeof e.xIn === 'number' && e.wIn > 0 && e.hIn > 0)) continue
                    // only elements intruding into the frame interior matter
                    if (e.xIn < mf.xIn + mf.wIn && e.xIn + e.wIn > mf.xIn &&
                        e.yIn < mf.yIn + mf.hIn && e.yIn + e.hIn > mf.yIn) {
                        obstacles.push({ xIn: e.xIn, yIn: e.yIn, wIn: e.wIn, hIn: e.hIn })
                    }
                }
                return resolveLegendCorner(mf, cornerCfg, obstacles)
            })()
            {
                const miss = await drawLegendEl(d, { type: 'legend', name: 'settingsLegend', xIn: box.xIn, yIn: box.yIn, wIn: box.wIn, hIn: box.hIn, maxItems: 0 } as LegendEl, legendRows, lCfg, !!opts.legendBox)
                if (miss > 0) (opts as any)._legendTruncated = Math.max(Number((opts as any)._legendTruncated) || 0, miss)
            }
        } catch (e) { /* legend is best-effort */ }
    }

    // Credits fallback: author/copyright always print when populated, even
    // if the layout has no text element consuming {author}/{copyright}.
    // Cartographic convention: a small credit line in the bottom page
    // margin, left-aligned with the layout's outermost border; if the
    // margin strip is occupied, attribution style inside the frame.
    if (!(opts as any).mapOnly && ((opts.author && String(opts.author).trim()) || (opts.copyright && String(opts.copyright).trim()))) {
        const consumes = (tok: string): boolean => (layout.elements || []).some(e =>
            (e as LayoutElement).type === 'text' && String(((e as TextEl).text) || '').indexOf(tok) >= 0)
        const creditParts: string[] = []
        if (opts.author && String(opts.author).trim() && !consumes('{author}')) creditParts.push('Author: ' + String(opts.author).trim())
        if (opts.copyright && String(opts.copyright).trim() && !consumes('{copyright}')) {
            const cp = String(opts.copyright).trim()
            creditParts.push(cp.startsWith('\u00a9') || cp.toLowerCase().startsWith('copyright') ? cp : '\u00a9 ' + cp)
        }
        if (creditParts.length) {
            const creditText = creditParts.join('    ')
            const size = 6.5
            let leftIn = 0.25
            try {
                const xs = (layout.elements || [])
                    .map(e => (e as any).xIn)
                    .filter((v: any) => typeof v === 'number' && isFinite(v) && v >= 0)
                if (xs.length) leftIn = Math.max(0.1, Math.min(...xs))
            } catch (e) { /* default margin */ }
            const boxes = ((layout.elements || []) as any[])
                .filter(e => e.type !== 'line' && typeof e.yIn === 'number' && e.hIn > 0)
            const bottomMost = boxes.length ? Math.max(...boxes.map(e => e.yIn + e.hIn)) : 0
            d.setFont('normal', size)
            d.setTextColor(70, 70, 70)
            if (layout.pageHeightIn - bottomMost >= 0.12) {
                // free bottom margin strip: baseline centered within it
                const stripTop = Math.max(bottomMost, layout.pageHeightIn - 0.3)
                const yPt = Math.min(
                    (stripTop + (layout.pageHeightIn - stripTop) / 2) * PT_PER_IN + size * 0.34,
                    layout.pageHeightIn * PT_PER_IN - 3)
                d.text(creditText, leftIn * PT_PER_IN, yPt, 'left')
            } else {
                // attribution style inside the frame, bottom-left, haloed
                const mfc = getMapFrame(layout)
                const tx = mfc.xIn * PT_PER_IN + 4
                const ty = (mfc.yIn + mfc.hIn) * PT_PER_IN - 4
                if (typeof (d as any).haloText === 'function') {
                    (d as any).haloText(creditText, tx, ty, 'left', [255, 255, 255], Math.max(1.2, size * 0.11))
                } else {
                    d.text(creditText, tx, ty, 'left')
                }
            }
        }
    }

    // Restore the authored composition: the ORIGINAL frame border wraps the
    // map and the legend panel together, so banner stubs and neatlines meet
    // the frame exactly where the layout author drew them.
    const outer = opts.legendPanelOuter
    if (outer && outer.color && outer.widthPt > 0) {
        d.setStroke(outer.color[0], outer.color[1], outer.color[2])
        d.setLineWidth(outer.widthPt)
        d.rect(outer.xIn * PT_PER_IN, outer.yIn * PT_PER_IN, outer.wIn * PT_PER_IN, outer.hIn * PT_PER_IN, 'S')
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
    // apply per-export user overrides from the widget's advanced options
    if (options.legendPositionOverride && useLayout.legend && useLayout.legend.enabled) {
        useLayout = { ...useLayout, legend: { ...useLayout.legend, position: options.legendPositionOverride as any } }
    }
    if (options.gridTypeOverride && useLayout.grid && useLayout.grid.enabled) {
        useLayout = { ...useLayout, grid: { ...useLayout.grid, type: options.gridTypeOverride as any } }
    }

    let mf = getMapFrame(useLayout)

    // Legend rows are built BEFORE the capture so an adjacent legend panel
    // can shrink the map frame to make room. Capture, grid, and overview
    // all derive from the frame, so the shrink propagates everywhere.
    const legendCfg = useLayout.legend
    const hasLegendEl = (useLayout.elements || []).some(e => e.type === 'legend')
    const hasLegend = !options.mapOnly && options.includeLegend !== false &&
        (hasLegendEl || (legendCfg && legendCfg.enabled))
    const legendRowsPromise: Promise<LegendRow[]> = hasLegend
        ? buildLegendRows(
            liveView,
            Math.max(1, ((useLayout.elements.find(e => e.type === 'legend') as LegendEl)?.maxItems) || 30),
            onProgress,
            options.legendWidgetId
        )
        : Promise.resolve([])
    // Second-page legends need a multi-page format: PDF keeps it; raster
    // and SVG formats fall back to a right panel with a note.
    let legendSecondPage = !options.mapOnly && !hasLegendEl && legendCfg && legendCfg.enabled &&
        options.includeLegend !== false && String(legendCfg.position || '') === 'secondPage'
    if (legendSecondPage && format !== 'pdf') {
        legendSecondPage = false
        useLayout = { ...useLayout, legend: { ...legendCfg, position: 'rightPanel' } as LegendConfig }
    }
    const legendCfg2 = useLayout.legend

    // Panel placements need the rows BEFORE capture (they shrink the frame);
    // overlay/pagx legends build concurrently with the capture instead.
    const panelPlacement = !options.mapOnly && !hasLegendEl && legendCfg2 && legendCfg2.enabled &&
        options.includeLegend !== false &&
        String(legendCfg2.position || '').endsWith('Panel')
    let legendRows: LegendRow[] = panelPlacement ? await legendRowsPromise : []

    if (panelPlacement && !options.mapOnly && !hasLegendEl && legendCfg2 && legendCfg2.enabled &&
        options.includeLegend !== false && legendRows.length) {
        const otherBoxes = (useLayout.elements || [])
            .filter(e => (e as LayoutElement).type !== 'mapFrame' && (e as LayoutElement).type !== 'line')
            .map(e => e as any)
            .filter(e => typeof e.xIn === 'number' && e.wIn > 0 && e.hIn > 0)
            .map(e => ({ xIn: e.xIn, yIn: e.yIn, wIn: e.wIn, hIn: e.hIn }))
        const panel = computeLegendPanel(legendRows, mf, legendCfg2, otherBoxes)
        if (panel && panel.mapFrame.wIn > 1 && panel.mapFrame.hIn > 1 &&
            panel.box.wIn > 0.9 && panel.box.hIn > 0.9) {
            onProgress('Placing legend panel beside the map...')
            const origFrame = { xIn: mf.xIn, yIn: mf.yIn, wIn: mf.wIn, hIn: mf.hIn }
            const mfBorder = (useLayout.elements || []).find(e => (e as LayoutElement).type === 'mapFrame') as MapFrameEl
            useLayout = {
                ...useLayout,
                elements: (useLayout.elements || []).map(e =>
                    (e as LayoutElement).type === 'mapFrame'
                        ? ({ ...(e as MapFrameEl), ...panel.mapFrame } as MapFrameEl)
                        : e)
            }
            mf = getMapFrame(useLayout)
            try {
                if (typeof options.onPanelComputed === 'function') {
                    options.onPanelComputed({ position: String(legendCfg2.position), wIn: panel.box.wIn, hIn: panel.box.hIn })
                }
            } catch (e) { /* preview feedback is best-effort */ }
            options = {
                ...options,
                legendBox: panel.box,
                legendPanelOuter: {
                    ...origFrame,
                    color: mfBorder && mfBorder.borderColor ? mfBorder.borderColor : null,
                    widthPt: mfBorder && mfBorder.borderWidthPt > 0 ? mfBorder.borderWidthPt : 0
                }
            }
        }
    }

    const cap = await captureMapHiRes(liveView, mf.wIn, mf.hIn, useLayout, maxImagePx, options, onProgress)
    if (!panelPlacement) legendRows = await legendRowsPromise

    // A grid cannot be drawn correctly on a rotated capture or when an
    // output WKID reprojected the map; say so on the result instead of
    // drawing wrong lines.
    const gCfg = useLayout.grid
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
            Math.min(maxImagePx, 2048),
            {
                ...options,
                maxWaitMs: 15000,
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
        if (!options.mapOnly && options.includeLegend !== false && legendRows.length &&
            useLayout.legend && useLayout.legend.enabled &&
            String(useLayout.legend.position || '') === 'secondPage' &&
            !(useLayout.elements || []).some(e => (e as LayoutElement).type === 'legend')) {
            const margin = 0.5
            const legendPages = paginateLegendRows(
                legendRows,
                Math.max(1, useLayout.pageWidthIn - margin * 2) * PT_PER_IN,
                Math.max(1, useLayout.pageHeightIn - margin * 2) * PT_PER_IN,
                useLayout.legend,
                (t, f) => { pd.setFont('normal', f); return pd.textWidth(t) }
            )
            for (let pi = 0; pi < legendPages.length; pi++) {
                onProgress('Composing legend page ' + (pi + 1) + ' of ' + legendPages.length + '\u2026')
                doc.addPage([pageW, pageH].sort((a, b) => a - b) as any, pageW >= pageH ? 'landscape' : 'portrait')
                await drawLegendPage(pd, useLayout.pageWidthIn, useLayout.pageHeightIn, legendPages[pi], useLayout.legend)
            }
        }
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
        warning: [cap.warning, (Number((options as any)._legendTruncated) || 0) > 0
            ? 'Legend truncated: ' + (options as any)._legendTruncated + ' item(s) not shown. Additional pages (PDF) includes everything.'
            : ''].filter(Boolean).join(' \u00b7 ') || undefined,
        printedScale: Math.round(cap.printedScale),
        url: lastUrl || undefined,
        sizeKb: lastSize ? Math.round(lastSize / 1024) : undefined
    }
}