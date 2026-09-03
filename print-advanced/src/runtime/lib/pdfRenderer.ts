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
    TextEl, ScaleBarEl, LegendEl, MapFrameEl, PictureEl, NorthArrowEl, LineEl, OverviewConfig, GridConfig, LegendConfig, LegendPatchSize
} from '../../config'
import { Drawer, PdfDrawer, CanvasDrawer, SvgDrawer, splitText } from './drawing'

/* eslint-disable @typescript-eslint/no-var-requires */
const UPNG = require('upng-js')
const UTIF = require('utif')
const gifenc = require('gifenc')
const fflate = require('fflate')
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
    /** Capture settle budget in ms (default 45000). Shorter for overview
     *  insets, longer for series index pages at never-loaded zoom levels. */
    maxWaitMs?: number
    /** Emit a world file (+ .prj) beside a MAP-ONLY raster export so it opens
     *  georeferenced in Pro/QGIS. Ignored for full layouts (the map is only
     *  a sub-region of the page) and rotated captures. */
    georeference?: boolean
    /** WKT of the output CRS for the .prj sidecar (map SR, or the output
     *  WKID's SR when an output coordinate system is set). */
    georefWkt?: string
    /** EPSG/WKID of the output CRS. Lets a TIFF export embed a true GeoTIFF
     *  (coordinate system inside the file - no sidecar, ArcGIS Pro reads it
     *  natively). PNG/JPG/GIF still use the world file + .prj sidecars. */
    georefWkid?: number
    /** Whether the output CRS is geographic (lat/lon). Picks the GeoTIFF key
     *  (GeographicTypeGeoKey vs ProjectedCSTypeGeoKey). When omitted the
     *  renderer infers it from the WKT, then from the WKID/extent. */
    georefGeographic?: boolean
    /** Internal: capture the map north-up (rotation 0) irrespective of the
     *  live view. Set for georeferenced map-only rasters. */
    forceNorthUp?: boolean
    /** Wrap a MAP-ONLY raster in a Google Earth KMZ: the image is packaged
     *  with a doc.kml GroundOverlay whose gx:LatLonQuad ties the four map
     *  corners to WGS84 lon/lat, so it drapes correctly on the globe for ANY
     *  source coordinate system (Web Mercator, geographic, or projected). */
    googleEarthKmz?: boolean
    /** Dynamic text context: ESRI WKT + SDK unit of the CAPTURE spatial
     *  reference (output WKID's when set, else the map's), the web map's
     *  title, and the signed-in user's display name. All best-effort. */
    srWkt?: string
    srUnit?: string
    mapName?: string
    user?: string
    /** Internal: map series page context for {pageNumber}/{pageCount}. */
    pageNumber?: number
    pageCount?: number
    pageName?: string
    /** Drop legend entries for layers whose visible scale range excludes the
     *  printed scale (default on). Title-matched; unmatched rows are kept. */
    legendScaleFilter?: boolean
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

/* ------------------------------------------------------------------ */
/* dynamic text: runtime token context + resolver                       */
/* ------------------------------------------------------------------ */

/** Everything a page's dynamic text can refer to. Built by composePage
 *  from the layout, the capture, and the export options. All fields but
 *  title/printedScale are optional: a missing source resolves to '' so
 *  Pro's emptyStr semantics apply (see replaceTokens). */
export interface TextTokens {
    title: string
    printedScale: number
    author?: string
    copyright?: string
    attribution?: string
    /** Layout name (Pro: layout property="name"). */
    layoutName?: string
    /** Web map title (Pro: mapFrame property="name" / "mapName"). */
    mapName?: string
    /** Signed-in user's display name (Pro: type="user"). */
    user?: string
    pageWidthIn?: number
    pageHeightIn?: number
    /** Capture rotation in degrees (0 when north-up). */
    rotation?: number
    dpi?: number
    /** Capture spatial reference: WKID, ESRI WKT (for names/params) and the
     *  SDK unit string ('meters' | 'feet' | 'us-feet' | 'degrees' | ...). */
    wkid?: number
    srWkt?: string
    srUnit?: string
    /** Capture geometry in the capture SR (for coordinate tokens). */
    center?: { x: number, y: number }
    groundExtent?: { xmin: number, ymin: number, xmax: number, ymax: number }
    projection?: 'webMercator' | 'geographic' | 'projected'
    /** Synchronous projector to WGS84 lon/lat for the capture SR, prepared
     *  by composePage (the SDK engine projects synchronously once loaded). */
    toWgs84?: (x: number, y: number) => [number, number] | null
    /** Map series page context (1/1 for a single page). */
    pageNumber?: number
    pageCount?: number
    pageName?: string
    /** Clock used for {date}/{time}; defaults to now (injectable for tests). */
    now?: Date
}

/* ---- ESRI WKT (well-known text, OGC WKT1 dialect) parsing ---- */

export interface WktNode { name: string, args: Array<string | number | WktNode> }

/** Minimal recursive-descent parser for ESRI/OGC WKT1:
 *  NAME["str", 1.5, CHILD[...], ...]. Pure/exported for tests. */
export function parseWkt (wkt: string): WktNode | null {
    const s = (wkt || '').trim()
    if (!s) return null
    let i = 0
    const skipWs = (): void => { while (i < s.length && /\s/.test(s[i])) i++ }
    const parseNode = (): WktNode | null => {
        skipWs()
        const m = /^[A-Za-z_][A-Za-z0-9_]*/.exec(s.slice(i))
        if (!m) return null
        const name = m[0]
        i += name.length
        skipWs()
        if (s[i] !== '[' && s[i] !== '(') return { name, args: [] }
        i++ // [
        const args: Array<string | number | WktNode> = []
        for (;;) {
            skipWs()
            if (i >= s.length) break
            const ch = s[i]
            if (ch === ']' || ch === ')') { i++; break }
            if (ch === ',') { i++; continue }
            if (ch === '"') {
                let j = i + 1
                let str = ''
                while (j < s.length) {
                    if (s[j] === '"') {
                        if (s[j + 1] === '"') { str += '"'; j += 2; continue }
                        break
                    }
                    str += s[j]; j++
                }
                i = j + 1
                args.push(str)
                continue
            }
            const num = /^[-+]?(?:\d+\.?\d*|\.\d+)(?:[eE][-+]?\d+)?/.exec(s.slice(i))
            if (num) { args.push(parseFloat(num[0])); i += num[0].length; continue }
            const child = parseNode()
            if (!child) { i++; continue } // skip garbage
            args.push(child)
        }
        return { name, args }
    }
    try { return parseNode() } catch (e) { return null }
}

export interface SrInfo {
    /** Display name: PCS name, else GCS name (underscores -> spaces). */
    name: string
    pcs: string
    gcs: string
    datum: string
    projection: string
    unit: string
    authority: string
    wkid: number
    /** PROJECTION parameters keyed by lower-case, space-separated name,
     *  e.g. 'central meridian', 'false easting', 'standard parallel 1'. */
    params: Record<string, number>
}

const pretty = (s: string): string => String(s || '').replace(/_/g, ' ').trim()

/** Extract the Pro dynamic-text spatial-reference properties from ESRI WKT.
 *  Missing WKT yields a WKID-only record. Pure/exported for tests. */
export function srInfoFromWkt (wkt: string | undefined, wkid: number, unitFallback?: string): SrInfo {
    const info: SrInfo = { name: '', pcs: '', gcs: '', datum: '', projection: '', unit: '', authority: '', wkid: wkid || 0, params: {} }
    const root = wkt ? parseWkt(wkt) : null
    const find = (n: WktNode | null, name: string): WktNode | null => {
        if (!n) return null
        if (n.name.toUpperCase() === name) return n
        for (const a of n.args) {
            if (typeof a === 'object') {
                const r = find(a, name)
                if (r) return r
            }
        }
        return null
    }
    if (root) {
        const up = root.name.toUpperCase()
        if (up === 'PROJCS') info.pcs = pretty(String(root.args[0] || ''))
        const geog = find(root, 'GEOGCS')
        if (geog) info.gcs = pretty(String(geog.args[0] || ''))
        const datum = find(root, 'DATUM')
        if (datum) info.datum = pretty(String(datum.args[0] || ''))
        const proj = find(root, 'PROJECTION')
        if (proj) info.projection = pretty(String(proj.args[0] || ''))
        // the root's own UNIT (linear for PROJCS, angular for GEOGCS)
        for (const a of root.args) {
            if (typeof a === 'object' && a.name.toUpperCase() === 'UNIT') info.unit = pretty(String(a.args[0] || ''))
            if (typeof a === 'object' && a.name.toUpperCase() === 'PARAMETER') {
                const k = pretty(String(a.args[0] || '')).toLowerCase()
                const v = Number(a.args[1])
                if (k && isFinite(v)) info.params[k] = v
            }
            if (typeof a === 'object' && a.name.toUpperCase() === 'AUTHORITY') {
                info.authority = String(a.args[0] || '')
                const code = Number(a.args[1])
                if (!info.wkid && isFinite(code)) info.wkid = code
            }
        }
        info.name = info.pcs || info.gcs
    }
    if (!info.unit && unitFallback) {
        const u = String(unitFallback).toLowerCase()
        info.unit = u === 'us-feet' ? 'Foot US'
            : u === 'feet' ? 'Foot'
                : u === 'meters' ? 'Meter'
                    : u === 'degrees' ? 'Degree'
                        : u.charAt(0).toUpperCase() + u.slice(1)
    }
    if (!info.name && info.wkid) info.name = 'WKID ' + info.wkid
    if (!info.authority && info.wkid) info.authority = info.wkid >= 100000 ? 'Esri' : 'EPSG'
    return info
}

/* ---- universal ESRI WKT lookup (any WKID, any user) ---- */

/** Offline seed: common definitions verified numerically identical to the
 *  EPSG registry (pyproj/GDAL). Everything else resolves at export time via
 *  lookupEsriWkt(), so no user is limited to this list. */
export const KNOWN_ESRI_WKT: Record<number, string> = {
    3857: 'PROJCS["WGS_1984_Web_Mercator_Auxiliary_Sphere",GEOGCS["GCS_WGS_1984",DATUM["D_WGS_1984",SPHEROID["WGS_1984",6378137.0,298.257223563]],PRIMEM["Greenwich",0.0],UNIT["Degree",0.0174532925199433]],PROJECTION["Mercator_Auxiliary_Sphere"],PARAMETER["False_Easting",0.0],PARAMETER["False_Northing",0.0],PARAMETER["Central_Meridian",0.0],PARAMETER["Standard_Parallel_1",0.0],PARAMETER["Auxiliary_Sphere_Type",0.0],UNIT["Meter",1.0]]',
    4326: 'GEOGCS["GCS_WGS_1984",DATUM["D_WGS_1984",SPHEROID["WGS_1984",6378137.0,298.257223563]],PRIMEM["Greenwich",0.0],UNIT["Degree",0.0174532925199433]]',
    4269: 'GEOGCS["GCS_North_American_1983",DATUM["D_North_American_1983",SPHEROID["GRS_1980",6378137.0,298.257222101]],PRIMEM["Greenwich",0.0],UNIT["Degree",0.0174532925199433]]',
    2232: 'PROJCS["NAD_1983_StatePlane_Colorado_Central_FIPS_0502_Feet",GEOGCS["GCS_North_American_1983",DATUM["D_North_American_1983",SPHEROID["GRS_1980",6378137.0,298.257222101]],PRIMEM["Greenwich",0.0],UNIT["Degree",0.0174532925199433]],PROJECTION["Lambert_Conformal_Conic"],PARAMETER["False_Easting",3000000.0],PARAMETER["False_Northing",1000000.0],PARAMETER["Central_Meridian",-105.5],PARAMETER["Standard_Parallel_1",39.75],PARAMETER["Standard_Parallel_2",38.45],PARAMETER["Latitude_Of_Origin",37.8333333333333],UNIT["US survey foot",0.304800609601219]]',
    26954: 'PROJCS["NAD_1983_StatePlane_Colorado_Central_FIPS_0502",GEOGCS["GCS_North_American_1983",DATUM["D_North_American_1983",SPHEROID["GRS_1980",6378137.0,298.257222101]],PRIMEM["Greenwich",0.0],UNIT["Degree",0.0174532925199433]],PROJECTION["Lambert_Conformal_Conic"],PARAMETER["False_Easting",914401.8289],PARAMETER["False_Northing",304800.6096],PARAMETER["Central_Meridian",-105.5],PARAMETER["Standard_Parallel_1",38.45],PARAMETER["Standard_Parallel_2",39.75],PARAMETER["Latitude_Of_Origin",37.8333333333333],UNIT["Meter",1.0]]',
    32612: 'PROJCS["WGS_1984_UTM_Zone_12N",GEOGCS["GCS_WGS_1984",DATUM["D_WGS_1984",SPHEROID["WGS_1984",6378137.0,298.257223563]],PRIMEM["Greenwich",0.0],UNIT["Degree",0.0174532925199433]],PROJECTION["Transverse_Mercator"],PARAMETER["False_Easting",500000.0],PARAMETER["False_Northing",0.0],PARAMETER["Central_Meridian",-111.0],PARAMETER["Scale_Factor",0.9996],PARAMETER["Latitude_Of_Origin",0.0],UNIT["Meter",1.0]]',
    32613: 'PROJCS["WGS_1984_UTM_Zone_13N",GEOGCS["GCS_WGS_1984",DATUM["D_WGS_1984",SPHEROID["WGS_1984",6378137.0,298.257223563]],PRIMEM["Greenwich",0.0],UNIT["Degree",0.0174532925199433]],PROJECTION["Transverse_Mercator"],PARAMETER["False_Easting",500000.0],PARAMETER["False_Northing",0.0],PARAMETER["Central_Meridian",-105.0],PARAMETER["Scale_Factor",0.9996],PARAMETER["Latitude_Of_Origin",0.0],UNIT["Meter",1.0]]',
    26912: 'PROJCS["NAD_1983_UTM_Zone_12N",GEOGCS["GCS_North_American_1983",DATUM["D_North_American_1983",SPHEROID["GRS_1980",6378137.0,298.257222101]],PRIMEM["Greenwich",0.0],UNIT["Degree",0.0174532925199433]],PROJECTION["Transverse_Mercator"],PARAMETER["False_Easting",500000.0],PARAMETER["False_Northing",0.0],PARAMETER["Central_Meridian",-111.0],PARAMETER["Scale_Factor",0.9996],PARAMETER["Latitude_Of_Origin",0.0],UNIT["Meter",1.0]]',
    26913: 'PROJCS["NAD_1983_UTM_Zone_13N",GEOGCS["GCS_North_American_1983",DATUM["D_North_American_1983",SPHEROID["GRS_1980",6378137.0,298.257222101]],PRIMEM["Greenwich",0.0],UNIT["Degree",0.0174532925199433]],PROJECTION["Transverse_Mercator"],PARAMETER["False_Easting",500000.0],PARAMETER["False_Northing",0.0],PARAMETER["Central_Meridian",-105.0],PARAMETER["Scale_Factor",0.9996],PARAMETER["Latitude_Of_Origin",0.0],UNIT["Meter",1.0]]'
}

/** Web Mercator ships under several WKIDs that share one definition. */
export function canonicalWkid (wkid: number): number {
    return (wkid === 102100 || wkid === 102113) ? 3857 : (Number(wkid) || 0)
}

/** Accept only something that is actually a WKT coordinate system. */
export function looksLikeWkt (s: string | null | undefined): boolean {
    return !!s && /^\s*(PROJCS|GEOGCS|GEOCCS|COMPD_CS|VERTCS|PROJCRS|GEOGCRS)\s*\[/i.test(s)
}

const wktCache = new Map<number, string | null>()

/** Resolve ESRI WKT for ANY spatial reference, in order: the SR object's own
 *  wkt (custom SRs carry one), the offline seed table, then the EPSG registry
 *  mirror at epsg.io (serves both EPSG and Esri-authority codes as ESRI WKT,
 *  CORS-enabled). Network is best-effort with a short timeout and a session
 *  cache; a miss resolves null and callers degrade (GeoTIFF never needs WKT,
 *  a world file still positions the image, {sr:name} prints 'WKID n'). */
export async function lookupEsriWkt (wkid: number, sr?: any, timeoutMs = 5000): Promise<string | null> {
    try {
        if (sr && (sr.wkt || sr.wkt2)) {
            const own = String(sr.wkt || sr.wkt2)
            if (looksLikeWkt(own)) return own
        }
    } catch (e) { /* fall through */ }
    const code = canonicalWkid(wkid)
    if (!(code > 0)) return null
    if (KNOWN_ESRI_WKT[code]) return KNOWN_ESRI_WKT[code]
    if (wktCache.has(code)) return wktCache.get(code) || null
    if (typeof fetch !== 'function') return null
    let result: string | null = null
    try {
        const ctl: any = (typeof AbortController === 'function') ? new AbortController() : null
        const timer = ctl ? setTimeout(() => { try { ctl.abort() } catch (e) { /* noop */ } }, timeoutMs) : null
        try {
            const resp = await fetch('https://epsg.io/' + code + '.esriwkt', { mode: 'cors', signal: ctl ? ctl.signal : undefined })
            if (resp.ok) {
                const text = (await resp.text()).trim()
                if (looksLikeWkt(text)) result = text
            }
        } finally { if (timer) clearTimeout(timer) }
    } catch (e) { result = null }
    wktCache.set(code, result)
    return result
}

/** True when WKT describes a geographic (lat/lon) coordinate system. */
export function isGeographicWkt (wkt: string | null | undefined): boolean | undefined {
    if (!wkt) return undefined
    const root = parseWkt(wkt)
    if (!root) return undefined
    const n = root.name.toUpperCase()
    if (n === 'GEOGCS' || n === 'GEOGCRS') return true
    if (n === 'PROJCS' || n === 'PROJCRS') return false
    return undefined
}

/* ---- coordinate formatting (Pro units: dd | dms | ddm | map units) ---- */

const DEG = '°'

/** Format one geographic axis value per Pro's units attribute. */
export function fmtDegrees (value: number, axis: 'lon' | 'lat', units: string, dp: number): string {
    const hemi = axis === 'lat' ? (value < 0 ? 'S' : 'N') : (value < 0 ? 'W' : 'E')
    const a = Math.abs(value)
    const u = (units || 'dd').toLowerCase()
    if (u === 'dms') {
        let d = Math.floor(a)
        let mFloat = (a - d) * 60
        let m = Math.floor(mFloat)
        let sec = (mFloat - m) * 60
        const secR = parseFloat(sec.toFixed(dp))
        if (secR >= 60) { sec = 0; m += 1 } else sec = secR
        if (m >= 60) { m = 0; d += 1 }
        return d + DEG + String(m).padStart(2, '0') + "'" + sec.toFixed(dp).padStart(dp > 0 ? 3 + dp : 2, '0') + '"' + hemi
    }
    if (u === 'ddm') {
        let d = Math.floor(a)
        let m = (a - d) * 60
        const mR = parseFloat(m.toFixed(dp))
        if (mR >= 60) { m = 0; d += 1 } else m = mR
        return d + DEG + m.toFixed(dp).padStart(dp > 0 ? 3 + dp : 2, '0') + "'" + hemi
    }
    // dd (also the fallback for mgrs/usng which are not supported here)
    return a.toFixed(dp) + DEG + hemi
}

/** Resolve a mapFrame coordinate property (center, center.x, lowerLeft, ...)
 *  to the (x, y) in the capture SR, from the extent/center context. */
function coordPoint (prop: string, tk: TextTokens): { x: number, y: number } | null {
    const e = tk.groundExtent
    const c = tk.center || (e ? { x: (e.xmin + e.xmax) / 2, y: (e.ymin + e.ymax) / 2 } : null)
    const p = prop.toLowerCase()
    if (p === 'center' || p === 'center.x' || p === 'center.y' || p === 'camera.x' || p === 'camera.y') return c
    if (!e) return null
    switch (p) {
        case 'lowerleft': return { x: e.xmin, y: e.ymin }
        case 'lowermid': return { x: (e.xmin + e.xmax) / 2, y: e.ymin }
        case 'lowerright': return { x: e.xmax, y: e.ymin }
        case 'midleft': return { x: e.xmin, y: (e.ymin + e.ymax) / 2 }
        case 'midright': return { x: e.xmax, y: (e.ymin + e.ymax) / 2 }
        case 'upperleft': return { x: e.xmin, y: e.ymax }
        case 'uppermid': return { x: (e.xmin + e.xmax) / 2, y: e.ymax }
        case 'upperright': return { x: e.xmax, y: e.ymax }
        default: return null
    }
}

/** Format a {coord:<prop>:<units>:<dp>} token. Geographic units (dd/dms/ddm)
 *  project the point to WGS84; an empty units attribute prints map units. */
export function fmtCoordToken (prop: string, units: string, dp: number, tk: TextTokens): string {
    const pt = coordPoint(prop, tk)
    if (!pt) return ''
    const p = prop.toLowerCase()
    const onlyX = p.endsWith('.x')
    const onlyY = p.endsWith('.y')
    const u = (units || '').toLowerCase()
    const geographic = u === 'dd' || u === 'dms' || u === 'ddm' || u === 'mgrs' || u === 'usng'
    if (geographic) {
        let ll: [number, number] | null = null
        if (tk.projection === 'geographic') ll = [pt.x, pt.y]
        else if (tk.projection === 'webMercator') ll = [mercXToLon(pt.x), mercYToLat(pt.y)]
        else if (tk.toWgs84) ll = tk.toWgs84(pt.x, pt.y)
        if (!ll || !isFinite(ll[0]) || !isFinite(ll[1])) return ''
        const lon = fmtDegrees(ll[0], 'lon', u, dp)
        const lat = fmtDegrees(ll[1], 'lat', u, dp)
        return onlyX ? lon : onlyY ? lat : lon + ' ' + lat
    }
    // map units (Pro default when no units attribute): x y
    const fx = fmtNumber(pt.x, dp)
    const fy = fmtNumber(pt.y, dp)
    return onlyX ? fx : onlyY ? fy : fx + ' ' + fy
}

/* ---- date / time formatting (Pro uses .NET-style patterns) ---- */

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December']
const DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday']

/** Format a Date with a .NET-style custom pattern (yyyy MM dd HH mm ss tt,
 *  MMMM/MMM/dddd/ddd, quoted literals). Pure/exported for tests. */
export function formatDotNet (d: Date, pattern: string): string {
    const pad = (n: number, w = 2): string => String(n).padStart(w, '0')
    const h12 = d.getHours() % 12 === 0 ? 12 : d.getHours() % 12
    return (pattern || '').replace(/yyyy|yy|MMMM|MMM|MM|M|dddd|ddd|dd|d|HH|H|hh|h|mm|m|ss|s|tt|t|'[^']*'/g, (m) => {
        switch (m) {
            case 'yyyy': return String(d.getFullYear())
            case 'yy': return pad(d.getFullYear() % 100)
            case 'MMMM': return MONTHS[d.getMonth()]
            case 'MMM': return MONTHS[d.getMonth()].slice(0, 3)
            case 'MM': return pad(d.getMonth() + 1)
            case 'M': return String(d.getMonth() + 1)
            case 'dddd': return DAYS[d.getDay()]
            case 'ddd': return DAYS[d.getDay()].slice(0, 3)
            case 'dd': return pad(d.getDate())
            case 'd': return String(d.getDate())
            case 'HH': return pad(d.getHours())
            case 'H': return String(d.getHours())
            case 'hh': return pad(h12)
            case 'h': return String(h12)
            case 'mm': return pad(d.getMinutes())
            case 'm': return String(d.getMinutes())
            case 'ss': return pad(d.getSeconds())
            case 's': return String(d.getSeconds())
            case 'tt': return d.getHours() < 12 ? 'AM' : 'PM'
            case 't': return d.getHours() < 12 ? 'A' : 'P'
            default: return m.slice(1, -1) // quoted literal
        }
    })
}

/** {date} / {date:<fmt>}: '' or 'short' = 9/2/2026, 'long' = Wednesday,
 *  September 2, 2026, anything else = a .NET custom pattern. */
export function fmtDateToken (d: Date, fmt: string): string {
    const f = (fmt || '').trim()
    if (!f || f.toLowerCase() === 'short') return d.toLocaleDateString('en-US')
    if (f.toLowerCase() === 'long') return d.toLocaleDateString('en-US', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' })
    return formatDotNet(d, f)
}

/** {time} / {time:<fmt>}: '' or 'short' = 3:42 PM, 'long' = 3:42:07 PM,
 *  anything else = a .NET custom pattern. */
export function fmtTimeToken (d: Date, fmt: string): string {
    const f = (fmt || '').trim()
    if (!f || f.toLowerCase() === 'short') return d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })
    if (f.toLowerCase() === 'long') return d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', second: '2-digit' })
    return formatDotNet(d, f)
}

/* ---- the resolver ---- */

/** Resolve one bare token name (without braces) against the context.
 *  Returns null for an unknown token so the literal text is preserved. */
export function resolveToken (name: string, tk: TextTokens): string | null {
    const now = tk.now || new Date()
    const parts = name.split(':')
    const head = parts[0]
    switch (head) {
        case 'title': return tk.title || ''
        case 'author': return tk.author || ''
        case 'copyright': return tk.copyright || ''
        case 'attribution': return tk.attribution || ''
        case 'user': return tk.user || ''
        case 'computer': return ''
        case 'layoutName': return tk.layoutName || ''
        case 'mapName': return tk.mapName || ''
        case 'date': return fmtDateToken(now, parts.slice(1).join(':'))
        case 'time': return fmtTimeToken(now, parts.slice(1).join(':'))
        case 'scale': return fmtNumber(tk.printedScale)
        case 'scaleRatio': {
            const unit = parts[1] || 'ft'
            const per = INCHES_PER_UNIT[unit] || 12
            const v = tk.printedScale / per
            let decimals = parseInt(parts[2] || '0', 10) || 0
            // Pro prints "1 inch equals 0 miles" when decimalPlaces rounds a
            // nonzero value to 0 (common at city scales with mapUnits="mi").
            // Escalate to two significant digits instead of printing 0.
            if (v > 0 && parseFloat(v.toFixed(decimals)) === 0) {
                decimals = Math.min(6, Math.ceil(-Math.log10(v)) + 1)
                const trimmed = String(parseFloat(v.toFixed(decimals)))
                decimals = (trimmed.split('.')[1] || '').length
            }
            return fmtNumber(v, decimals)
        }
        case 'rotation': {
            const r = Number(tk.rotation) || 0
            return String(Math.round(r * 100) / 100)
        }
        case 'dpi': return tk.dpi ? String(Math.round(tk.dpi)) : ''
        case 'pageWidth': return tk.pageWidthIn ? String(Math.round(tk.pageWidthIn * 100) / 100) : ''
        case 'pageHeight': return tk.pageHeightIn ? String(Math.round(tk.pageHeightIn * 100) / 100) : ''
        case 'pageUnits': return tk.pageWidthIn ? 'Inches' : ''
        case 'pageNumber': return String(tk.pageNumber || 1)
        case 'pageCount': return String(tk.pageCount || 1)
        case 'pageName': return tk.pageName || String(tk.pageNumber || 1)
        case 'pageIndex': return String((tk.pageNumber || 1) - 1)
        case 'wkid': return tk.wkid ? String(tk.wkid) : ''
        case 'mapUnits': return srInfoFromWkt(tk.srWkt, tk.wkid || 0, tk.srUnit).unit
        case 'sr': {
            const info = srInfoFromWkt(tk.srWkt, tk.wkid || 0, tk.srUnit)
            const prop = parts.slice(1).join(':').replace(/_/g, ' ').trim().toLowerCase()
            switch (prop) {
                case 'name': return info.name
                case 'pcs': return info.pcs
                case 'gcs': return info.gcs
                case 'datum': return info.datum
                case 'projection': return info.projection
                case 'units': return info.unit
                case 'authority': return info.authority
                case 'wkid': return info.wkid ? String(info.wkid) : ''
                case 'remarks': return ''
                default: {
                    // PROJECTION parameter (central meridian, false easting, ...)
                    const v = info.params[prop]
                    return isFinite(v) ? String(v) : ''
                }
            }
        }
        case 'coord': {
            const prop = parts[1] || 'center'
            const units = parts[2] || ''
            const dp = parseInt(parts[3] || '', 10)
            return fmtCoordToken(prop, units, isFinite(dp) ? dp : (units ? (units === 'dd' ? 4 : 0) : 2), tk)
        }
        default: return null
    }
}

/** Decode the pre/post/empty wrapper values (only '|', '{', '}' are encoded). */
const decodeWrap = (s: string): string => (s || '').replace(/%7C/gi, '|').replace(/%7B/gi, '{').replace(/%7D/gi, '}')

/** Replace runtime tokens produced by the pagx importer (or typed by hand).
 *  Two forms:
 *    {name}                                bare token
 *    {name|pre=..|post=..|empty=..}        Pro preStr/postStr/emptyStr: pre and
 *                                          post print only when the value is
 *                                          non-empty; otherwise empty prints.
 *  Unknown token names are left untouched. */
export function replaceTokens(tpl: string, tk: TextTokens): string {
    let out = (tpl || '')
    // wrapped form first (its inner name may itself contain ':' segments)
    out = out.replace(/\{([A-Za-z][\w.]*(?::[^|{}]*)?)((?:\|(?:pre|post|empty)=[^|{}]*)+)\}/g, (m, name: string, mods: string) => {
        const v = resolveToken(name, tk)
        if (v === null) return m
        let pre = '', post = '', empty = ''
        for (const seg of mods.split('|')) {
            if (!seg) continue
            const eq = seg.indexOf('=')
            const k = seg.slice(0, eq), val = decodeWrap(seg.slice(eq + 1))
            if (k === 'pre') pre = val
            else if (k === 'post') post = val
            else if (k === 'empty') empty = val
        }
        return v ? pre + v + post : empty
    })
    // bare form
    out = out.replace(/\{([A-Za-z][\w.]*(?::[^{}|]*)?)\}/g, (m, name: string) => {
        const v = resolveToken(name, tk)
        return v === null ? m : v
    })
    return out
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

/* ------------------------------------------------------------------ */
/* georeferencing (world file + .prj sidecars)                          */
/* ------------------------------------------------------------------ */

/** World-file extension for a raster format (ESRI convention: first + last
 *  letter of the extension + 'w'; jpeg/jpg -> jgw, tif -> tfw, png -> pgw,
 *  gif -> gfw). Returns null for formats that cannot carry a world file. */
export function worldFileExt (format: string): string | null {
    switch (format) {
        case 'png32': case 'png8': return 'pgw'
        case 'jpg': return 'jgw'
        case 'tiff': return 'tfw'
        case 'gif': return 'gfw'
        default: return null
    }
}

/** The six ESRI world-file coefficients for a north-up (unrotated) raster
 *  of W x H pixels that exactly covers ground extent [xmin..xmax, ymin..ymax].
 *  Lines are A, D, B, E, C, F where A/E are pixel size (E negative, north
 *  down), D/B are rotation (0), and C/F are the map coordinates of the
 *  CENTRE of the top-left pixel. Pure and exported for tests. */
export function worldFileCoeffs (
    W: number, H: number,
    ext: { xmin: number, ymin: number, xmax: number, ymax: number }
): { A: number, D: number, B: number, E: number, C: number, F: number } {
    const A = (ext.xmax - ext.xmin) / W          // +x per pixel east
    const E = -(ext.ymax - ext.ymin) / H         // -y per pixel south
    return {
        A, D: 0, B: 0, E,
        C: ext.xmin + A / 2,                      // centre of pixel (0,0)
        F: ext.ymax + E / 2
    }
}

/** Format the world file text (6 lines, high precision). */
export function worldFileText (
    W: number, H: number,
    ext: { xmin: number, ymin: number, xmax: number, ymax: number }
): string {
    const c = worldFileCoeffs(W, H, ext)
    const fmt = (n: number): string => {
        // enough precision for projected metres/feet and for degrees
        const s = n.toFixed(Math.abs(n) < 1 ? 12 : 8)
        return s.replace(/0+$/, '').replace(/\.$/, '.0')
    }
    return [c.A, c.D, c.B, c.E, c.C, c.F].map(fmt).join('\n') + '\n'
}

/** Write the world file (and, when WKT is known, a .prj) beside a raster
 *  export. Best-effort: any failure is swallowed so the raster still
 *  downloads. Returns the world-file name written, or null. */
function emitGeoSidecars (
    baseName: string, format: string,
    W: number, H: number,
    ext: { xmin: number, ymin: number, xmax: number, ymax: number },
    wkt?: string
): string | null {
    try {
        const ext3 = worldFileExt(format)
        if (!ext3 || !(W > 0) || !(H > 0) || !(ext.xmax > ext.xmin) || !(ext.ymax > ext.ymin)) return null
        const stem = baseName.replace(/\.[^.]+$/, '')
        const wf = worldFileText(W, H, ext)
        downloadBlob(new Blob([wf], { type: 'text/plain' }), stem + '.' + ext3)
        if (wkt && wkt.trim()) {
            downloadBlob(new Blob([wkt.trim() + '\n'], { type: 'text/plain' }), stem + '.prj')
        }
        return stem + '.' + ext3
    } catch (e) { return null }
}

/* ------------------------------------------------------------------ */
/* Google Earth (KMZ) packaging                                         */
/* ------------------------------------------------------------------ */

/** Four map-frame corners in WGS84 lon/lat, in gx:LatLonQuad winding order
 *  (lower-left, lower-right, upper-right, upper-left). */
export interface LatLonQuad {
    ll: [number, number]
    lr: [number, number]
    ur: [number, number]
    ul: [number, number]
}

/** Project the four corners of a NORTH-UP capture's ground extent to WGS84
 *  lon/lat for a Google Earth GroundOverlay. Web Mercator and geographic use
 *  a closed-form inverse (exact, no async); any other projected CRS goes
 *  through the JSAPI projection engine. Returns null when the corners cannot
 *  be resolved (no extent, or projection engine unavailable for a projected
 *  CRS). A gx:LatLonQuad carries all four corners independently, so a
 *  projected extent that maps to a slightly non-rectangular geographic quad
 *  drapes without stretch or shear. */
export async function extentCornersToWgs84 (
    ext: { xmin: number, ymin: number, xmax: number, ymax: number } | undefined,
    projection: 'webMercator' | 'geographic' | 'projected' | undefined,
    capWkid: number
): Promise<LatLonQuad | null> {
    if (!ext || !(ext.xmax > ext.xmin) || !(ext.ymax > ext.ymin)) return null
    if (projection === 'geographic') {
        return {
            ll: [ext.xmin, ext.ymin], lr: [ext.xmax, ext.ymin],
            ur: [ext.xmax, ext.ymax], ul: [ext.xmin, ext.ymax]
        }
    }
    if (projection === 'webMercator') {
        const lon = (x: number): number => mercXToLon(x)
        const lat = (y: number): number => mercYToLat(y)
        return {
            ll: [lon(ext.xmin), lat(ext.ymin)], lr: [lon(ext.xmax), lat(ext.ymin)],
            ur: [lon(ext.xmax), lat(ext.ymax)], ul: [lon(ext.xmin), lat(ext.ymax)]
        }
    }
    // Arbitrary projected CRS: use the client-side projection engine.
    if (!(capWkid > 0)) return null
    const projector = await getProjector()
    if (!projector) return null
    const PointCls: any = projector.Point
    const capSR = new SpatialReference({ wkid: capWkid })
    const wgs = new SpatialReference({ wkid: 4326 })
    const P = (x: number, y: number): [number, number] | null => {
        const out: any = projector.project(new PointCls({ x, y, spatialReference: capSR }), wgs)
        return out && isFinite(out.x) && isFinite(out.y) ? [out.x, out.y] : null
    }
    const ll = P(ext.xmin, ext.ymin), lr = P(ext.xmax, ext.ymin)
    const ur = P(ext.xmax, ext.ymax), ul = P(ext.xmin, ext.ymax)
    if (!ll || !lr || !ur || !ul) return null
    return { ll, lr, ur, ul }
}

/** XML-escape text for KML element content. */
function kmlEscape (s: string): string {
    return (s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

/** Build the doc.kml GroundOverlay that ties an overlay image to a quad.
 *  Pure/exported so the coordinate winding can be unit-tested. */
export function buildGroundOverlayKml (imgName: string, quad: LatLonQuad, title: string): string {
    const f = (n: number): string => n.toFixed(10)
    // gx:LatLonQuad winding: LL, LR, UR, UL (counter-clockwise from lower-left).
    const coords = [quad.ll, quad.lr, quad.ur, quad.ul]
        .map(c => f(c[0]) + ',' + f(c[1])).join(' ')
    return '<?xml version="1.0" encoding="UTF-8"?>\n' +
        '<kml xmlns="http://www.opengis.net/kml/2.2" xmlns:gx="http://www.google.com/kml/ext/2.2">\n' +
        '  <GroundOverlay>\n' +
        '    <name>' + kmlEscape(title || 'Map') + '</name>\n' +
        '    <Icon><href>' + kmlEscape(imgName) + '</href></Icon>\n' +
        '    <gx:LatLonQuad><coordinates>' + coords + '</coordinates></gx:LatLonQuad>\n' +
        '  </GroundOverlay>\n' +
        '</kml>\n'
}

/** Zip a doc.kml + overlay image into a KMZ. The image is already compressed
 *  (PNG/JPG) so it is stored (level 0); doc.kml deflates. doc.kml is written
 *  first, as KMZ readers expect the root KML as the archive's first entry. */
function buildKmzBlob (imgBytes: Uint8Array, imgName: string, quad: LatLonQuad, title: string): Blob {
    const kml = buildGroundOverlayKml(imgName, quad, title)
    const files: Record<string, any> = {}
    files['doc.kml'] = fflate.strToU8(kml)
    files[imgName] = [imgBytes, { level: 0 }]
    const zipped: Uint8Array = fflate.zipSync(files, { level: 6 })
    // Copy into a fresh ArrayBuffer-backed view so Blob accepts it regardless
    // of how @types/fflate widens the return (Uint8Array<ArrayBufferLike>).
    const safe = new Uint8Array(zipped.length)
    safe.set(zipped)
    return new Blob([safe], { type: 'application/vnd.google-earth.kmz' })
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
    /** WKID of the capture spatial reference (output WKID when reprojected,
     *  else the live map's). Feeds dynamic text {wkid} / {sr:*} tokens. */
    wkid?: number
    /** Capture center in the capture SR (dynamic text {coord:center...}). */
    center?: { x: number, y: number }
}

/* ------------------------------------------------------------------ */
/* GPU capability probe                                                 */
/* ------------------------------------------------------------------ */

let _gpuMaxPx: number | null = null

/** Longest canvas side the GPU can render (min of MAX_TEXTURE_SIZE and
 *  MAX_RENDERBUFFER_SIZE), probed once. Falls back to 8192. */
export function gpuMaxCapturePx(): number {
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

/** Draw series tile outlines and page numbers over an index-page capture.
 *  Ground-to-page via the capture's groundExtent, clipped to the frame. */
export function drawIndexOverlay(
    d: Drawer,
    layout: PrintLayout,
    cap: { groundExtent?: { xmin: number, ymin: number, xmax: number, ymax: number } },
    tiles: Array<{ page: number, xmin: number, ymin: number, xmax: number, ymax: number }>
): number {
    const ext = cap.groundExtent
    if (!ext || !tiles.length) return 0
    const mf = getMapFrame(layout)
    const fx = mf.xIn * PT_PER_IN; const fy = mf.yIn * PT_PER_IN
    const fw = mf.wIn * PT_PER_IN; const fh = mf.hIn * PT_PER_IN
    const gx = (x: number): number => fx + (x - ext.xmin) / (ext.xmax - ext.xmin) * fw
    const gy = (y: number): number => fy + (ext.ymax - y) / (ext.ymax - ext.ymin) * fh
    let drawn = 0
    for (const t of tiles) {
        // stroke state per tile: the page-number halo changes the draw
        // color, so without this every tile after the first strokes white
        d.setLineWidth(1)
        d.setStroke(200, 60, 40)
        const x1 = Math.max(fx, gx(t.xmin)); const x2 = Math.min(fx + fw, gx(t.xmax))
        const y1 = Math.max(fy, gy(t.ymax)); const y2 = Math.min(fy + fh, gy(t.ymin))
        if (x2 - x1 < 2 || y2 - y1 < 2) continue
        // 'S' (stroke), not jsPDF's 'D' alias: the canvas/SVG backends only
        // implement the typed ShapeStyle set, where 'D' would draw nothing
        d.rect(x1, y1, x2 - x1, y2 - y1, 'S')
        const label = String(t.page)
        const fs = Math.max(7, Math.min(14, (y2 - y1) * 0.25))
        d.setFont('bold', fs)
        d.setTextColor(200, 60, 40)
        if (typeof (d as any).haloText === 'function') {
            (d as any).haloText(label, (x1 + x2) / 2, (y1 + y2) / 2 + fs * 0.34, 'center', [255, 255, 255], Math.max(1.2, fs * 0.12))
        } else {
            d.text(label, (x1 + x2) / 2, (y1 + y2) / 2 + fs * 0.34, 'center')
        }
        drawn++
    }
    return drawn
}

/** Adjacent-page labels on a series page's frame edges (ArcGIS Pro map
 *  series convention): the right edge names the page to the right, the
 *  bottom edge the page below, and so on. Grid adjacency from row/col. */
export function drawSeriesAdjacency(
    d: Drawer,
    layout: PrintLayout,
    tile: { page: number, row: number, col: number },
    tiles: Array<{ page: number, row: number, col: number }>,
    /** Boxes (page inches) occupying space beside the frame - e.g. an
     *  adjacent legend panel. Side tabs that would land on one flip to
     *  just INSIDE the frame edge instead. */
    avoid?: Array<{ xIn: number, yIn: number, wIn: number, hIn: number }>
): void {
    const byRC = new Map<string, number>()
    for (const t of tiles) byRC.set(t.row + ':' + t.col, t.page)
    const mf = getMapFrame(layout)
    const fx = mf.xIn * PT_PER_IN; const fy = mf.yIn * PT_PER_IN
    const fw = mf.wIn * PT_PER_IN; const fh = mf.hIn * PT_PER_IN
    const size = 8
    d.setFont('bold', size)
    // edge TABS (Pro atlas style): white boxed labels flush to each edge,
    // with arrows, readable over any imagery
    // labels live OUTSIDE the map frame: plain black text with a white
    // halo, horizontal above and below, rotated along the sides
    const gap = 3
    const sideBlocked = (edge: 'left' | 'right'): boolean => {
        // anything occupying the strip immediately beside that frame edge
        const stripX = edge === 'left' ? mf.xIn - 0.25 : mf.xIn + mf.wIn
        return (avoid || []).some(b =>
            b && b.wIn > 0 && b.hIn > 0 &&
            b.xIn < stripX + 0.25 && b.xIn + b.wIn > stripX &&
            b.yIn < mf.yIn + mf.hIn && b.yIn + b.hIn > mf.yIn)
    }
    const tab = (label: string, edge: 'top' | 'bottom' | 'left' | 'right'): void => {
        d.setFont('bold', size)
        const tw = d.textWidth(label)
        if (edge === 'top' || edge === 'bottom') {
            // right-aligned to the frame edge, clear of centered titles and
            // authored furniture; bottom sits in the page margin strip,
            // mirroring the author/copyright credits on the left
            const y = edge === 'top'
                ? fy - gap - 1.5
                : layout.pageHeightIn * PT_PER_IN - 4
            if (typeof (d as any).haloText === 'function') {
                d.setTextColor(20, 20, 20)
                    ; (d as any).haloText(label, fx + fw / 2, y, 'center', [255, 255, 255], 1.6)
            } else {
                d.setTextColor(20, 20, 20)
                d.text(label, fx + fw / 2, y, 'center')
            }
        } else {
            const doc: any = (d as any).doc
            const inside = sideBlocked(edge)
            const x = edge === 'left'
                ? (inside ? fx + gap + 1.5 + size * 0.86 : fx - gap - 1.5)
                : (inside ? fx + fw - gap - 1.5 : fx + fw + gap + size * 0.86)
            const y = fy + fh / 2 + tw / 2
            if (doc && typeof doc.text === 'function') {
                // manual halo for rotated text: white ring then black center
                doc.setTextColor(255, 255, 255)
                for (const [ox, oy] of [[-1.2, 0], [1.2, 0], [0, -1.2], [0, 1.2], [-0.9, -0.9], [0.9, -0.9], [-0.9, 0.9], [0.9, 0.9]]) {
                    doc.text(label, x + ox, y + oy, { angle: 90 })
                }
                doc.setTextColor(20, 20, 20)
                doc.text(label, x, y, { angle: 90 })
            } else {
                d.setTextColor(20, 20, 20)
                d.text(label, x, y, 'center')
            }
        }
    }
    const n = (r: number, c: number): number | undefined => byRC.get(r + ':' + c)
    const up = n(tile.row - 1, tile.col)
    const down = n(tile.row + 1, tile.col)
    const left = n(tile.row, tile.col - 1)
    const right = n(tile.row, tile.col + 1)
    if (up !== undefined) tab('Page ' + up, 'top')
    if (down !== undefined) tab('Page ' + down, 'bottom')
    if (left !== undefined) tab('Page ' + left, 'left')
    if (right !== undefined) tab('Page ' + right, 'right')
}

/** True when a capture is essentially a blank white image: the telltale
 *  of screenshotting a zoom level whose basemap tiles have not painted
 *  yet. Samples a small downscale; best-effort (false on any error). */
async function captureLooksBlank(dataUrl: string): Promise<boolean> {
    try {
        if (typeof document === 'undefined') return false
        return await new Promise<boolean>((resolve) => {
            const img = new Image()
            img.onload = () => {
                try {
                    const c = document.createElement('canvas')
                    c.width = 48; c.height = 48
                    const ctx = c.getContext('2d')
                    if (!ctx) { resolve(false); return }
                    ctx.drawImage(img, 0, 0, 48, 48)
                    const px = ctx.getImageData(0, 0, 48, 48).data
                    let white = 0
                    const total = 48 * 48
                    for (let i = 0; i < px.length; i += 4) {
                        if (px[i] > 246 && px[i + 1] > 246 && px[i + 2] > 246) white++
                    }
                    c.width = 0; c.height = 0
                    resolve(white / total > 0.985)
                } catch (e) { resolve(false) }
            }
            img.onerror = () => resolve(false)
            img.src = dataUrl
        })
    } catch (e) { return false }
}

/** Key map (ArcGIS Pro map series convention): a small diagram of the
 *  whole page grid in the frame's top-right corner with the CURRENT page
 *  filled, so every printed sheet answers "where am I in the atlas?".
 *  Pure vector from tile geometry; no extra capture. */
export function drawSeriesKeymap(
    d: Drawer,
    layout: PrintLayout,
    tiles: Array<{ page: number, xmin: number, ymin: number, xmax: number, ymax: number }>,
    currentPage: number
): void {
    if (tiles.length < 2) return
    let exmin = Infinity; let eymin = Infinity; let exmax = -Infinity; let eymax = -Infinity
    for (const t of tiles) { exmin = Math.min(exmin, t.xmin); eymin = Math.min(eymin, t.ymin); exmax = Math.max(exmax, t.xmax); eymax = Math.max(eymax, t.ymax) }
    const ew = exmax - exmin; const eh = eymax - eymin
    const mf = getMapFrame(layout)
    const maxSide = 1.25 * PT_PER_IN
    const scale = Math.min(maxSide / ew, maxSide / eh)
    const kw = ew * scale; const kh = eh * scale
    const pad = 4
    const bx = (mf.xIn + mf.wIn) * PT_PER_IN - kw - pad * 2 - 6
    const by = mf.yIn * PT_PER_IN + 6
    d.setFill(255, 255, 255)
    d.setStroke(150, 150, 150)
    d.setLineWidth(0.6)
    d.rect(bx, by, kw + pad * 2, kh + pad * 2, 'FD')
    for (const t of tiles) {
        const x = bx + pad + (t.xmin - exmin) * scale
        const y = by + pad + (eymax - t.ymax) * scale
        const w = (t.xmax - t.xmin) * scale
        const h = (t.ymax - t.ymin) * scale
        d.setLineWidth(0.5)
        d.setStroke(120, 120, 120)
        const current = t.page === currentPage
        if (current) {
            d.setFill(225, 110, 20)
            d.rect(x, y, w, h, 'FD')
        } else {
            d.rect(x, y, w, h, 'S')
        }
        // page numbers in every cell: the active page in focus (bold white
        // on orange), the rest muted gray, so the key map reads even
        // without imagery
        const fs = Math.max(3.5, Math.min(9, Math.min(w, h) * 0.55))
        d.setFont(current ? 'bold' : 'normal', fs)
        d.setTextColor(current ? 255 : 150, current ? 255 : 150, current ? 255 : 150)
        d.text(String(t.page), x + w / 2, y + h / 2 + fs * 0.34, 'center')
    }
}

/** Current-page indicator for series pages: "Page i of n" in the lower
 *  right page margin, mirroring the author/copyright credit line on the
 *  left. Same baseline convention as the credits; falls back to a haloed
 *  label inside the frame corner when the margin strip is occupied. */
export function drawSeriesPageNumber(
    d: Drawer,
    layout: PrintLayout,
    pageIdx: number,
    pageCount: number,
    /** Original (pre-legend-panel) frame, so the label keeps its page
     *  alignment when an adjacent panel has shrunk the map frame. */
    outer?: { xIn: number, wIn: number }
): void {
    const label = 'Page ' + pageIdx + ' of ' + pageCount
    const size = 7
    const mf = getMapFrame(layout)
    const rightPt = Math.max(
        (mf.xIn + mf.wIn),
        outer && outer.wIn > 0 ? outer.xIn + outer.wIn : 0) * PT_PER_IN
    const boxes = ((layout.elements || []) as any[])
        .filter(e => e.type !== 'line' && typeof e.yIn === 'number' && e.hIn > 0)
    const bottomMost = boxes.length ? Math.max(...boxes.map(e => e.yIn + e.hIn)) : 0
    d.setFont('bold', size)
    d.setTextColor(70, 70, 70)
    if (layout.pageHeightIn - bottomMost >= 0.12) {
        const stripTop = Math.max(bottomMost, layout.pageHeightIn - 0.3)
        const yPt = Math.min(
            (stripTop + (layout.pageHeightIn - stripTop) / 2) * PT_PER_IN + size * 0.34,
            layout.pageHeightIn * PT_PER_IN - 3)
        d.text(label, rightPt, yPt, 'right')
    } else {
        // inside-frame fallback stays on the MAP, not on a legend panel
        const tx = (mf.xIn + mf.wIn) * PT_PER_IN - 4
        const ty = (mf.yIn + mf.hIn) * PT_PER_IN - 4
        if (typeof (d as any).haloText === 'function') {
            (d as any).haloText(label, tx, ty, 'right', [255, 255, 255], 1.2)
        } else {
            d.text(label, tx, ty, 'right')
        }
    }
}

/** Map series export: one PDF, a page per tile plus an index page.
 *  Captures run SEQUENTIALLY through the proven single-capture path so
 *  every safeguard (SR handling, iOS budgets, white background, honest
 *  warnings) applies per tile.
 *
 *  Legend placement matches the single-map export exactly: a panel
 *  placement runs the SAME computeLegendPanel math, shrinks the map frame
 *  to make room, and prints the panel on EVERY page (each sheet is a
 *  complete standalone map). When the frame shrinks, series.retile
 *  regenerates the tile grid against the effective frame so tiles keep
 *  the frame aspect and the printed scale stays uniform. Corner-overlay
 *  legends keep the previous behavior (page 1 only); 'secondPage'
 *  appends dedicated legend pages after the index, as single map does. */
export async function renderSeries(
    view: MapView,
    layout: PrintLayout,
    title: string,
    fileName: string,
    maxImagePx: number,
    series: {
        tiles: Array<{ page: number, row: number, col: number, xmin: number, ymin: number, xmax: number, ymax: number, centerX: number, centerY: number }>,
        scaleDenom: number,
        /** Regenerate tiles for the EFFECTIVE map frame (inches). Called
         *  once the legend panel (if any) has resized the frame, so the
         *  grid the pages print always matches the frame they print in. */
        retile?: (frameWIn: number, frameHIn: number) => {
            tiles: Array<{ page: number, row: number, col: number, xmin: number, ymin: number, xmax: number, ymax: number, centerX: number, centerY: number }>,
            scaleDenom: number
        }
    },
    options: RenderOptions,
    onProgress: RenderProgress
): Promise<{ url: string, fileName: string, sizeKb: number, pages: number, warning?: string }> {
    let tiles = series.tiles || []
    if (!tiles.length) throw new Error('Map series has no pages. Adjust the area or scale.')
    let scaleDenom = series.scaleDenom
    // per-export legend position override, exactly as renderLayout applies it
    let useLayout: PrintLayout = layout
    if (options.legendPositionOverride && useLayout.legend && useLayout.legend.enabled) {
        useLayout = { ...useLayout, legend: { ...useLayout.legend, position: options.legendPositionOverride as any } }
    }
    const pageW = useLayout.pageWidthIn * PT_PER_IN
    const pageH = useLayout.pageHeightIn * PT_PER_IN
    const doc = new jsPDF({
        orientation: pageW >= pageH ? 'landscape' : 'portrait',
        unit: 'pt',
        format: [pageW, pageH].sort((a, b) => a - b) as any,
        compress: true
    })
    const pd = new PdfDrawer(doc)
    pd.setFontFamily(options.fontFamily || 'sans')
    if (options.customFont) {
        await registerPdfFont(doc, options.customFont.name, options.customFont.url, options.customFont.boldUrl)
        pd.setCustomFont(options.customFont.name)
    }
    // Legend rows are built BEFORE any capture so an adjacent legend panel
    // can shrink the map frame first - the same order renderLayout uses.
    const legendCfg = useLayout.legend
    const hasLegendEl = (useLayout.elements || []).some(e => (e as LayoutElement).type === 'legend')
    const wantLegend = options.includeLegend !== false && (hasLegendEl || (legendCfg && legendCfg.enabled))
    let legendRows: LegendRow[] = []
    if (wantLegend) {
        try {
            legendRows = await buildLegendRows(view as any, 200, onProgress, (options as any).legendWidgetId)
            // every series page prints at one uniform scale: drop layers
            // that do not draw at it (they would be legend-only ghosts)
            if (options.legendScaleFilter !== false && scaleDenom > 0) {
                const before = legendRows.length
                legendRows = filterLegendRowsByScale(legendRows, collectLayerScaleRanges(view as any), scaleDenom)
                if (legendRows.length < before) onProgress('Legend: hid ' + (before - legendRows.length) + ' row(s) not drawn at 1:' + Math.round(scaleDenom).toLocaleString() + '.')
            }
        } catch (e) { legendRows = [] }
    }
    const legendPosition = String((legendCfg && legendCfg.position) || '')
    const panelPlacement = !hasLegendEl && legendCfg && legendCfg.enabled &&
        options.includeLegend !== false && legendPosition.endsWith('Panel')
    const legendSecondPage = !hasLegendEl && legendCfg && legendCfg.enabled &&
        options.includeLegend !== false && legendPosition === 'secondPage'
    if (panelPlacement && legendRows.length) {
        // SAME panel math as the single-map export: the map frame shrinks
        // to make room, so the legend prints in the same place whether or
        // not the export is a series.
        const mfFull = getMapFrame(useLayout)
        const otherBoxes = (useLayout.elements || [])
            .filter(e => (e as LayoutElement).type !== 'mapFrame' && (e as LayoutElement).type !== 'line')
            .map(e => e as any)
            .filter(e => typeof e.xIn === 'number' && e.wIn > 0 && e.hIn > 0)
            .map(e => ({ xIn: e.xIn, yIn: e.yIn, wIn: e.wIn, hIn: e.hIn }))
        const panel = computeLegendPanel(legendRows, mfFull, legendCfg, otherBoxes)
        if (panel && panel.mapFrame.wIn > 1 && panel.mapFrame.hIn > 1 &&
            panel.box.wIn > 0.9 && panel.box.hIn > 0.9) {
            onProgress('Placing legend panel beside the map...')
            const origFrame = { xIn: mfFull.xIn, yIn: mfFull.yIn, wIn: mfFull.wIn, hIn: mfFull.hIn }
            const mfBorder = (useLayout.elements || []).find(e => (e as LayoutElement).type === 'mapFrame') as MapFrameEl
            useLayout = {
                ...useLayout,
                elements: (useLayout.elements || []).map(e =>
                    (e as LayoutElement).type === 'mapFrame'
                        ? ({ ...(e as MapFrameEl), ...panel.mapFrame } as MapFrameEl)
                        : e)
            }
            try {
                if (typeof options.onPanelComputed === 'function') {
                    options.onPanelComputed({ position: legendPosition, wIn: panel.box.wIn, hIn: panel.box.hIn })
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
    // The tile grid must match the EFFECTIVE frame: regenerate it against
    // the final frame dimensions (shrunken or not) so the grid adjusts
    // dynamically exactly like the single-map print extent does.
    const mf0 = getMapFrame(useLayout)
    if (typeof series.retile === 'function') {
        try {
            const rt = series.retile(mf0.wIn, mf0.hIn)
            if (rt && rt.tiles && rt.tiles.length && rt.scaleDenom > 0) {
                tiles = rt.tiles
                scaleDenom = rt.scaleDenom
            }
        } catch (e) { /* keep the provided tiles */ }
    }
    const warnings: string[] = []
    const n = tiles.length
    // Panel and pagx-authored legends are page furniture: every sheet gets
    // them, like ArcGIS Pro map series. Corner overlays cover map content,
    // so they keep the page-1-only behavior.
    const rowsForPage = (i: number): LegendRow[] =>
        (panelPlacement || hasLegendEl) ? legendRows : (i === 0 && !legendSecondPage ? legendRows : [])
    for (let i = 0; i < n; i++) {
        const t = tiles[i]
        onProgress('Exporting page ' + (i + 1) + ' of ' + n + '\u2026')
        const tileOpts: RenderOptions = {
            ...options,
            scaleMode: 'fixed' as any,
            fixedScale: scaleDenom,
            lockedCenter: { x: t.centerX, y: t.centerY } as any,
            includeLegend: rowsForPage(i).length ? options.includeLegend : false,
            // Pro map-series page tokens: {pageNumber} {pageCount} {pageName}
            pageNumber: i + 1,
            pageCount: n,
            pageName: String((t as any).page || (i + 1))
        }
        const cap = await captureMapHiRes(view, mf0.wIn, mf0.hIn, useLayout, maxImagePx, tileOpts, onProgress)
        if (cap.warning && warnings.indexOf(cap.warning) < 0) warnings.push(cap.warning)
        if (i > 0) doc.addPage([pageW, pageH].sort((a, b) => a - b) as any, pageW >= pageH ? 'landscape' : 'portrait')
        const pageTitle = (title || useLayout.name || 'Map')
            .replace(/\{page\}/g, String(i + 1))
            .replace(/\{pages\}/g, String(n)) +
            (/\{page\}/.test(title || '') ? '' : '  (' + (i + 1) + ' of ' + n + ')')
        await composePage(pd, useLayout, cap, rowsForPage(i), pageTitle, tileOpts)
        drawSeriesAdjacency(pd, useLayout, t as any, tiles as any, options.legendBox ? [options.legendBox] : undefined)
        drawSeriesKeymap(pd, useLayout, tiles as any, t.page)
        drawSeriesPageNumber(pd, useLayout, i + 1, n, options.legendPanelOuter)
    }
    // index page: the whole series envelope with tile outlines and numbers.
    // It uses the same effective frame (and legend panel, when active) as
    // every other page, so the document composes uniformly end to end.
    onProgress('Creating index page\u2026')
    let xmin = Infinity; let ymin = Infinity; let xmax = -Infinity; let ymax = -Infinity
    for (const t of tiles) { xmin = Math.min(xmin, t.xmin); ymin = Math.min(ymin, t.ymin); xmax = Math.max(xmax, t.xmax); ymax = Math.max(ymax, t.ymax) }
    const padX = (xmax - xmin) * 0.05; const padY = (ymax - ymin) * 0.05
    const mpu = metersPerMapUnit((view as any).scale, (view as any).resolution)
    const idxScale = Math.max(
        ((xmax - xmin + padX * 2) * mpu) / (mf0.wIn * 0.0254),
        ((ymax - ymin + padY * 2) * mpu) / (mf0.hIn * 0.0254))
    const idxHasLegend = (panelPlacement || hasLegendEl) && legendRows.length > 0
    const idxOpts: RenderOptions = {
        ...options,
        includeLegend: idxHasLegend ? options.includeLegend : false,
        scaleMode: 'fixed' as any,
        fixedScale: Math.ceil(idxScale),
        lockedCenter: { x: (xmin + xmax) / 2, y: (ymin + ymax) / 2 } as any
    }
        // the index sits at a zoom level the session has likely never loaded:
        // give tiles a generous settle budget, and if the capture still comes
        // back blank white, wait for the basemap and try once more
        ; (idxOpts as any).maxWaitMs = Math.max(Number((idxOpts as any).maxWaitMs) || 0, 45000)
    let idxCap = await captureMapHiRes(view, mf0.wIn, mf0.hIn, useLayout, maxImagePx, idxOpts, onProgress)
    try {
        if (await captureLooksBlank(idxCap.dataUrl)) {
            onProgress('Waiting for basemap tiles on the index page\u2026')
            await new Promise<void>((r) => setTimeout(r, 5000))
            idxCap = await captureMapHiRes(view, mf0.wIn, mf0.hIn, useLayout, maxImagePx, idxOpts, onProgress)
        }
    } catch (e) { /* retry is best-effort */ }
    doc.addPage([pageW, pageH].sort((a, b) => a - b) as any, pageW >= pageH ? 'landscape' : 'portrait')
    await composePage(pd, useLayout, idxCap, idxHasLegend ? legendRows : [], (title || useLayout.name || 'Map') + '  (Index)', idxOpts)
    drawIndexOverlay(pd, useLayout, idxCap as any, tiles)
    // 'secondPage' placement: dedicated legend pages after the index,
    // exactly like the single-map PDF export
    let legendPageCount = 0
    if (legendSecondPage && legendRows.length) {
        const margin = 0.5
        const legendPages = paginateLegendRows(
            legendRows,
            Math.max(1, useLayout.pageWidthIn - margin * 2) * PT_PER_IN,
            Math.max(1, useLayout.pageHeightIn - margin * 2) * PT_PER_IN,
            legendCfg,
            (t2, f2) => { pd.setFont('normal', f2); return pd.textWidth(t2) }
        )
        for (let pi = 0; pi < legendPages.length; pi++) {
            onProgress('Composing legend page ' + (pi + 1) + ' of ' + legendPages.length + '\u2026')
            doc.addPage([pageW, pageH].sort((a, b) => a - b) as any, pageW >= pageH ? 'landscape' : 'portrait')
            await drawLegendPage(pd, useLayout.pageWidthIn, useLayout.pageHeightIn, legendPages[pi], legendCfg)
        }
        legendPageCount = legendPages.length
    }
    const blob: Blob = doc.output('blob')
    const url = downloadBlob(blob, fileName)
    return {
        url,
        fileName,
        sizeKb: Math.round(blob.size / 1024),
        pages: n + 1 + legendPageCount,
        warning: warnings.length ? warnings.join(' \u00b7 ') : undefined
    }
}

/* ------------------------------------------------------------------ */
/* QR code (byte mode, ECC M, versions 1-10, mask 0) - self-contained  */
/* ------------------------------------------------------------------ */
const QR_V = [
    // [dataCodewords, ecPerBlock, blocks1, size1, blocks2, size2, align...]
    null,
    { data: 16, ec: 10, b: [[1, 16]], align: [] },
    { data: 28, ec: 16, b: [[1, 28]], align: [6, 18] },
    { data: 44, ec: 26, b: [[1, 44]], align: [6, 22] },
    { data: 64, ec: 18, b: [[2, 32]], align: [6, 26] },
    { data: 86, ec: 24, b: [[2, 43]], align: [6, 30] },
    { data: 108, ec: 16, b: [[4, 27]], align: [6, 34] },
    { data: 124, ec: 18, b: [[4, 31]], align: [6, 22, 38] },
    { data: 154, ec: 22, b: [[2, 38], [2, 39]], align: [6, 24, 42] },
    { data: 182, ec: 22, b: [[3, 36], [2, 37]], align: [6, 26, 46] },
    { data: 216, ec: 26, b: [[4, 43], [1, 44]], align: [6, 28, 50] }
] as any[]
const QR_FMT_M0 = [1, 0, 1, 0, 1, 0, 0, 0, 0, 0, 1, 0, 0, 1, 0]
const QR_VERINFO: Record<number, string> = {
    7: '000111110010010100', 8: '001000010110111100', 9: '001001101010011001', 10: '001010010011010011'
}
function qrGf(): { exp: number[], log: number[] } {
    const exp = new Array(512).fill(0); const log = new Array(256).fill(0)
    let x = 1
    for (let i = 0; i < 255; i++) {
        exp[i] = x; log[x] = i
        x <<= 1; if (x & 0x100) x ^= 0x11d
    }
    for (let i = 255; i < 512; i++) exp[i] = exp[i - 255]
    return { exp, log }
}
/** Build QR modules for a UTF-8 string. Returns null if too long. */
export function qrModules(text: string): { size: number, get: (r: number, c: number) => boolean } | null {
    const bytes: number[] = []
    for (const ch of unescape(encodeURIComponent(text))) bytes.push(ch.charCodeAt(0))
    let ver = 0
    for (let v = 1; v <= 10; v++) {
        const cap = QR_V[v].data - (v <= 9 ? 2 : 3)
        if (bytes.length <= cap) { ver = v; break }
    }
    if (!ver) return null
    const V = QR_V[ver]
    // bitstream: mode 0100, count (8 bits v1-9, 16 bits v10), data, terminator, pad
    const bits: number[] = []
    const push = (val: number, n: number): void => { for (let i = n - 1; i >= 0; i--) bits.push((val >> i) & 1) }
    push(4, 4)
    push(bytes.length, ver <= 9 ? 8 : 16)
    for (const b of bytes) push(b, 8)
    const capBits = V.data * 8
    push(0, Math.min(4, capBits - bits.length))
    while (bits.length % 8 !== 0) bits.push(0)
    const pads = [0xec, 0x11]
    let pi = 0
    while (bits.length < capBits) { push(pads[pi % 2], 8); pi++ }
    const cw: number[] = []
    for (let i = 0; i < bits.length; i += 8) {
        let v2 = 0
        for (let j = 0; j < 8; j++) v2 = (v2 << 1) | bits[i + j]
        cw.push(v2)
    }
    // split into blocks, compute EC, interleave
    const gf = qrGf()
    const blocks: number[][] = []
    let off = 0
    for (const [count, size] of V.b) {
        for (let k = 0; k < count; k++) { blocks.push(cw.slice(off, off + size)); off += size }
    }
    const rsFor = (data: number[]): number[] => {
        // polynomial long division over GF(256)
        // generator polynomial, leading coefficient first (gen[0] = 1)
        let gen = [1]
        for (let i = 0; i < V.ec; i++) {
            const next = new Array(gen.length + 1).fill(0)
            for (let j = 0; j < gen.length; j++) {
                next[j] ^= gen[j] // x * gen
                next[j + 1] ^= gen[j] === 0 ? 0 : gf.exp[(gf.log[gen[j]] + i) % 255] // a^i * gen
            }
            gen = next
        }
        const rem = new Array(V.ec).fill(0)
        for (const d of data) {
            const factor = d ^ rem[0]
            rem.shift(); rem.push(0)
            if (factor !== 0) {
                const lf = gf.log[factor]
                for (let j = 0; j < V.ec; j++) {
                    const g = gen[j + 1]
                    if (g !== 0) rem[j] ^= gf.exp[(lf + gf.log[g]) % 255]
                }
            }
        }
        return rem
    }
    const ecs = blocks.map(b => rsFor(b))
    const inter: number[] = []
    const maxLen = Math.max(...blocks.map(b => b.length))
    for (let i = 0; i < maxLen; i++) for (const b of blocks) if (i < b.length) inter.push(b[i])
    for (let i = 0; i < V.ec; i++) for (const e of ecs) inter.push(e[i])
    // module matrix
    const size = ver * 4 + 17
    const m: Array<Array<number>> = Array.from({ length: size }, () => new Array(size).fill(-1))
    const setF = (r: number, c: number, v: number): void => { if (r >= 0 && r < size && c >= 0 && c < size) m[r][c] = v }
    const finder = (r: number, c: number): void => {
        for (let dr = -1; dr <= 7; dr++) for (let dc = -1; dc <= 7; dc++) {
            const rr = r + dr; const cc = c + dc
            if (rr < 0 || rr >= size || cc < 0 || cc >= size) continue
            const on = (dr >= 0 && dr <= 6 && (dc === 0 || dc === 6)) || (dc >= 0 && dc <= 6 && (dr === 0 || dr === 6)) ||
                (dr >= 2 && dr <= 4 && dc >= 2 && dc <= 4)
            m[rr][cc] = on ? 1 : 0
        }
    }
    finder(0, 0); finder(0, size - 7); finder(size - 7, 0)
    for (const ar of V.align) for (const ac of V.align) {
        if (m[ar][ac] !== -1) continue
        for (let dr = -2; dr <= 2; dr++) for (let dc = -2; dc <= 2; dc++) {
            const on = Math.max(Math.abs(dr), Math.abs(dc)) !== 1
            setF(ar + dr, ac + dc, on ? 1 : 0)
        }
    }
    for (let i = 8; i < size - 8; i++) {
        if (m[6][i] === -1) m[6][i] = i % 2 === 0 ? 1 : 0
        if (m[i][6] === -1) m[i][6] = i % 2 === 0 ? 1 : 0
    }
    setF(size - 8, 8, 1) // dark module
    // reserve format areas
    for (let i = 0; i < 9; i++) { if (m[8][i] === -1) m[8][i] = 0; if (m[i][8] === -1) m[i][8] = 0 }
    for (let i = 0; i < 8; i++) { if (m[8][size - 1 - i] === -1) m[8][size - 1 - i] = 0; if (m[size - 1 - i][8] === -1) m[size - 1 - i][8] = 0 }
    if (ver >= 7) {
        const vi = QR_VERINFO[ver]
        let k = 0
        for (let c = 0; c < 6; c++) for (let r = 0; r < 3; r++) {
            const bit = Number(vi[17 - k]); k++
            m[size - 11 + r][c] = bit
            m[c][size - 11 + r] = bit
        }
    }
    // place data (zigzag), mask 0: (r+c)%2===0
    let bi = 0
    const totalBits = inter.length * 8
    const bitAt = (i: number): number => (inter[i >> 3] >> (7 - (i & 7))) & 1
    let col = size - 1
    let up = true
    while (col > 0) {
        if (col === 6) col--
        for (let i = 0; i < size; i++) {
            const r = up ? size - 1 - i : i
            for (const cc of [col, col - 1]) {
                if (m[r][cc] !== -1) continue
                let bit = bi < totalBits ? bitAt(bi) : 0
                bi++
                if ((r + cc) % 2 === 0) bit ^= 1
                m[r][cc] = bit
            }
        }
        up = !up
        col -= 2
    }
    // format bits (ECC M, mask 0) in both locations
    const f = QR_FMT_M0
    for (let i = 0; i < 6; i++) m[8][i] = f[i]
    m[8][7] = f[6]; m[8][8] = f[7]; m[7][8] = f[8]
    for (let i = 9; i < 15; i++) m[14 - i][8] = f[i]
    for (let i = 0; i < 7; i++) m[size - 1 - i][8] = f[i]
    for (let i = 7; i < 15; i++) m[8][size - 15 + i] = f[i]
    return { size, get: (r, c) => m[r][c] === 1 }
}

/** True on devices where WebKit/OS hard-caps canvas + WebGL memory and
 *  kills the tab past it: every iOS browser (Safari, Chrome/CriOS,
 *  Firefox/FxiOS are all WebKit there, iPadOS reports as Mac with touch),
 *  plus anything reporting very low device memory. */
export function memoryConstrainedDevice(): boolean {
    try {
        const nav: any = typeof navigator !== 'undefined' ? navigator : null
        if (!nav) return false
        const ua = String(nav.userAgent || '')
        const iosUa = /iPad|iPhone|iPod/.test(ua)
        const iPadOs = nav.platform === 'MacIntel' && (nav.maxTouchPoints || 0) > 1
        const lowMem = typeof nav.deviceMemory === 'number' && nav.deviceMemory <= 4
        return iosUa || iPadOs || lowMem
    } catch (e) { return false }
}

/** Layer types whose content is SCREEN-ANCHORED symbology (marker sizes,
 *  line widths, text, halos) that must print at paper size, and which the
 *  engine can re-render client-side at a higher pixel ratio. Raster-ish
 *  types are excluded on purpose: they stay on the zoomed base pass,
 *  which is what gives imagery its print sharpness. */
const SYMBOL_LAYER_TYPES = new Set([
    'feature', 'graphics', 'geojson', 'csv', 'wfs', 'ogc-feature', 'stream',
    'map-notes', 'route', 'subtype-group', 'vector-tile', 'map-image', 'knowledge-graph'
])

/** Composite the opaque raster base and the transparent symbol overlay
 *  onto one canvas. White underpaints everything (JPEG has no alpha). */
async function compositeCapture(
    baseUrl: string | null, overlayUrl: string, w: number, h: number, jpeg: boolean
): Promise<string | null> {
    const load = (src: string): Promise<HTMLImageElement | null> => new Promise((resolve) => {
        const img = new Image()
        img.onload = () => resolve(img)
        img.onerror = () => resolve(null)
        img.src = src
    })
    try {
        const [base, over] = await Promise.all([
            baseUrl ? load(baseUrl) : Promise.resolve<HTMLImageElement | null>(null),
            load(overlayUrl)
        ])
        if (!over) return null
        const c = document.createElement('canvas')
        c.width = w; c.height = h
        const ctx = c.getContext('2d')
        if (!ctx) return null
        ctx.fillStyle = '#ffffff'
        ctx.fillRect(0, 0, w, h)
        if (base) ctx.drawImage(base, 0, 0, w, h)
        ctx.drawImage(over, 0, 0, w, h)
        const out = jpeg ? c.toDataURL('image/jpeg', 0.95) : c.toDataURL('image/png')
        c.width = 0; c.height = 0 // release WebKit canvas memory promptly
        return out
    } catch (e) { return null }
}

/** Finest (smallest-denominator) tiled LOD scale the view can actually
 *  serve, across the basemap and any tile / imagery / vector-tile layers.
 *  Returns 0 when nothing tiled is found (all-dynamic map): callers then
 *  keep the unclamped zoom. This is the floor past which zooming the
 *  offscreen capture buys NO real imagery detail (no finer tiles exist)
 *  and, for cached services with a hard finest level, throws the imagery
 *  off-scale - so the raster pass must never render below it. */
function finestTiledScale (view: MapView): number {
    let finest = Infinity
    const consider = (lods: any): void => {
        try {
            const arr: any[] = lods && lods.toArray ? lods.toArray() : (Array.isArray(lods) ? lods : [])
            for (const lod of arr) {
                const s = Number(lod && lod.scale)
                if (isFinite(s) && s > 0) finest = Math.min(finest, s)
            }
        } catch (e) { /* ignore */ }
    }
    try {
        // the view's own effective LODs (basemap/reference) are the truth
        const c: any = (view as any).constraints
        if (c) { consider(c.effectiveLODs); consider(c.lods) }
    } catch (e) { /* ignore */ }
    try {
        const all: any = (view.map as any).allLayers
        const arr: any[] = all && all.toArray ? all.toArray() : []
        for (const l of arr) {
            if (l && l.visible !== false && (l.type === 'tile' || l.type === 'vector-tile' ||
                l.type === 'imagery-tile' || l.type === 'wmts' || l.type === 'base-tile')) {
                const ti: any = l.tileInfo
                if (ti && ti.lods) consider(ti.lods)
            }
        }
    } catch (e) { /* ignore */ }
    return isFinite(finest) ? finest : 0
}

/** Draw a captured image onto a white-filled canvas and re-encode as
 *  JPEG: guarantees no transparent pixel can render black downstream. */
async function flattenToWhiteJpeg(dataUrl: string, w: number, h: number): Promise<string> {
    return await new Promise<string>((resolve, reject) => {
        const img = new Image()
        img.onload = () => {
            try {
                const c = document.createElement('canvas')
                c.width = img.naturalWidth || w
                c.height = img.naturalHeight || h
                const ctx = c.getContext('2d')
                if (!ctx) { resolve(dataUrl); return }
                if (memoryConstrainedDevice() && c.width * c.height > 8388608) {
                    // constrained devices: skip the extra full-size canvas;
                    // the white view background already guards transparency
                    resolve(dataUrl)
                    return
                }
                ctx.fillStyle = '#ffffff'
                ctx.fillRect(0, 0, c.width, c.height)
                ctx.drawImage(img, 0, 0)
                const out = c.toDataURL('image/jpeg', 0.95)
                c.width = 0; c.height = 0 // release WebKit canvas memory promptly
                resolve(out)
            } catch (e) { resolve(dataUrl) }
        }
        img.onerror = () => resolve(dataUrl)
        img.src = dataUrl
    })
}

async function captureMapHiRes(
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
    const dpr = (typeof window !== 'undefined' && (window as any).devicePixelRatio) || 1
    const deviceCap = memoryConstrainedDevice()
        ? Math.max(1024, Math.floor(4096 / Math.max(1, dpr)))
        : Number.POSITIVE_INFINITY
    const capLimit = Math.min(maxImagePx > 0 ? maxImagePx : Math.min(gpuMax, 8192), gpuMax, deviceCap)
    const maxDim = Math.max(capW, capH)
    if (maxDim > capLimit) {
        const s = capLimit / maxDim
        capW = Math.round(capW * s)
        capH = Math.round(capH * s)
        onProgress('Map capture capped at ' + capLimit + ' px (' +
            (capLimit === deviceCap
                ? 'this device\u2019s memory limit'
                : (maxImagePx > 0 && capLimit === maxImagePx ? 'settings limit' : 'graphics card limit')) +
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
        // Georeferenced rasters must be NORTH-UP (world files and the GeoTIFF
        // tiepoint I embed are axis-aligned), so ignore any live-view rotation
        // for those captures - even a fraction of a degree otherwise blocks
        // the embed and, worse, would misalign the pixels against the extent.
        const capRotation = (opts as any).forceNorthUp ? 0 : liveView.rotation
        tmp = new MapView({
            container,
            map: liveView.map,
            spatialReference: outSR,
            center, // Point in the live view's SR; the view projects it on load
            scale: viewScale,
            rotation: capRotation,
            ui: { components: [] } as any,
            constraints: { snapToZoom: false, rotationEnabled: true } as any,
            popupEnabled: false,
            // transparent-to-black guard: cached basemaps with nodata
            // collars (and the view itself where nothing draws) are
            // transparent; JPEG has no alpha, so without an explicit
            // background those pixels encode as BLACK. Inherit the live
            // view's background if set, else white.
            background: (liveView as any).background || ({ color: [255, 255, 255, 1] } as any)
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

        // ---- symbol-true second pass -------------------------------------
        // The zoomed offscreen view keeps the extent and raster/tile detail
        // right, but the engine draws symbology in CSS pixels, so markers,
        // line widths, text and halos would print at 96/dpi of their real
        // size (48% at 200 DPI, 32% at 300). Fix: re-render the symbol-
        // bearing layers with the SAME view resized to natural CSS size at
        // the TRUE printed scale, and let takeScreenshot supersample - its
        // internal resolutionScale re-renders with pixelRatio = scale, which
        // is exactly the parameter that sizes symbols (verified in
        // @arcgis/core 5.x: Stage.takeScreenshot renders the requested
        // layer containers with pixelRatio = resolutionScale, capped at
        // min(4x, ~4096 px); ignoreBackground yields transparency). The
        // transparent overlay then composites over the sharp raster base.
        // Side benefit: scale-dependent visibility and labeling on these
        // layers now evaluate at the true printed scale, like a print
        // service. Trade-off: relative z-order between the raster group and
        // the symbol group is flattened (symbols composite on top), which
        // matches the overwhelmingly common basemap-under-features stack.
        // Best-effort by design: any failure keeps the full capture above.
        let symbolPassApplied = false
        const symbolRatio = effectiveDpi / 96
        // Imagery-scale guard: the initial view is zoomed to viewScale to pull
        // finer basemap tiles, but for a cached aerial whose finest LOD is
        // near the printed scale (e.g. printing 1:141 zooms to ~1:45), that
        // pushes past the service's finest tiles and the imagery comes back
        // off-scale. The raster pass must never render below the finest LOD.
        const finestLod = finestTiledScale(liveView)
        const rasterRenderScale = finestLod > 0 ? Math.max(viewScale, finestLod) : viewScale
        // Only clamp when the DPI zoom actually over-zoomed (symbolRatio > 1);
        // at 96 DPI there is no zoom, so imagery is already to-scale and a
        // clamp pass would risk excluding symbols with no benefit.
        const clampNeeded = symbolRatio > 1.05 && rasterRenderScale > viewScale * 1.02
        // container CSS size (px) that keeps the print extent to-scale while a
        // view renders at renderScale; takeScreenshot then supersamples to
        // capW. At renderScale = viewScale this equals capW (no supersample,
        // the original sharp path); at printedScale it is the natural size.
        const cssFor = (renderScale: number): { w: number, h: number } => ({
            w: Math.max(2, Math.round(frameWIn * printedScale * 96 / renderScale)),
            h: Math.max(2, Math.round(frameHIn * printedScale * 96 / renderScale))
        })
        // snapshot the extent BEFORE any second-pass resize: CSS rounding on
        // the resized container would skew the readback by a sub-pixel
        let extSnapshot: { xmin: number, ymin: number, xmax: number, ymax: number } | null = null
        try {
            const e0: any = (tmp as any).extent
            if (e0 && isFinite(e0.xmin) && e0.xmax > e0.xmin) {
                extSnapshot = { xmin: e0.xmin, ymin: e0.ymin, xmax: e0.xmax, ymax: e0.ymax }
            }
        } catch (e) { /* snapshot best-effort */ }
        const renderAt = async (renderScale: number, shotOpts: any): Promise<any> => {
            const css = cssFor(renderScale)
            if (Math.abs(css.w - capW) > 1 || Math.abs(css.h - capH) > 1 ||
                Math.abs(Number((tmp as any).scale) - renderScale) > renderScale * 0.001) {
                container.style.width = css.w + 'px'
                container.style.height = css.h + 'px'
                await new Promise(r => setTimeout(r, 60))
                ;(tmp as any).scale = renderScale
                await Promise.race([
                    reactiveUtils.whenOnce(() => !!tmp && !tmp.updating),
                    new Promise(resolve => setTimeout(resolve, 20000))
                ])
                await new Promise(r => setTimeout(r, 400))
            }
            return tmp.takeScreenshot({ width: capW, height: capH, ...shotOpts } as any)
        }
        try {
            const bigForDevice = memoryConstrainedDevice() && capW * capH > 8388608
            const leaves: any[] = []
            try {
                const all: any = (tmp.map as any).allLayers
                const arrL: any[] = all && all.toArray ? all.toArray() : []
                for (const l of arrL) { if (l && l.type !== 'group') leaves.push(l) }
            } catch (e) { /* classification best-effort */ }
            const symbolLayers = leaves.filter(l => SYMBOL_LAYER_TYPES.has(String(l.type)))
            const rasterLayers = leaves.filter(l => !SYMBOL_LAYER_TYPES.has(String(l.type)))
            // Run the enhanced capture when symbols need print-size rendering,
            // OR when the imagery would be over-zoomed and must be clamped.
            const needSymbolPass = symbolRatio > 1.05 && symbolLayers.length > 0 && !bigForDevice
            const needClampPass = clampNeeded && !bigForDevice
            if (needSymbolPass || needClampPass) {
                onProgress(needClampPass ? 'Rendering imagery at print scale…' : 'Rendering symbols at print size…')
                // raster/imagery base at the clamped render scale (never below
                // the finest LOD). When no clamp is needed this renders at
                // viewScale into a capW container - the original sharp path.
                const baseShot = rasterLayers.length
                    ? await renderAt(rasterRenderScale, { layers: rasterLayers, format: 'png' })
                    : null
                // symbols at the TRUE printed scale so marker/line/text sizes
                // are correct; transparent so they composite over the base
                let overlayShot: any = null
                if (needSymbolPass) {
                    overlayShot = await renderAt(printedScale, { layers: symbolLayers, ignoreBackground: true, format: 'png' })
                }
                let merged: string | null = null
                if (overlayShot && overlayShot.dataUrl) {
                    merged = await compositeCapture(
                        baseShot && baseShot.dataUrl ? baseShot.dataUrl : null,
                        overlayShot.dataUrl, capW, capH, layout.imageFormat !== 'png')
                } else if (baseShot && baseShot.dataUrl) {
                    // imagery-only clamp (no symbol layers): the corrected base
                    // IS the result; flatten onto white for jpeg
                    merged = await compositeCapture(null, baseShot.dataUrl, capW, capH, layout.imageFormat !== 'png')
                }
                if (merged) {
                    shot = { ...shot, dataUrl: merged }
                    symbolPassApplied = true
                }
            }
        } catch (e) {
            onProgress('Print-scale pass failed; using the standard capture.')
        }

        // second guard for the same transparency issue: if the API ignored
        // the view background, flatten the capture onto white ourselves
        // (the composited capture is already flattened onto white)
        if (layout.imageFormat !== 'png' && !symbolPassApplied) {
            try {
                shot = { ...shot, dataUrl: await flattenToWhiteJpeg(shot.dataUrl, capW, capH) }
            } catch (e) { /* flatten is best-effort; the background guard remains */ }
        }

        const liveWkid = (liveView.spatialReference && (liveView.spatialReference as any).wkid) || 0
        const reprojected = !!(opts.outputWkid && opts.outputWkid > 0 && opts.outputWkid !== liveWkid)
        // Ground extent for grid math: the offscreen view knows its own
        // extent in the CAPTURE spatial reference, so grids stay correct
        // even when an output WKID reprojects the map. Fall back to the
        // live-SR computation only when not reprojected.
        const capWkid = reprojected ? Number(opts.outputWkid) : liveWkid
        let ground: { xmin: number, ymin: number, xmax: number, ymax: number } | undefined
        // prefer the pre-resize snapshot; fall back to the live property
        const tExt: any = extSnapshot || (tmp as any).extent
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
                if ((opts as any).forceNorthUp) return 0 // georeferenced captures are north-up
                const raw = liveView.rotation || 0
                const norm = ((raw % 360) + 360) % 360
                return (norm < 0.05 || norm > 359.95) ? 0 : raw
            })(),
            warning,
            groundExtent: ground,
            projection: (capWkid === 3857 || capWkid === 102100 || capWkid === 102113)
                ? 'webMercator'
                : (capWkid === 4326 ? 'geographic' : 'projected'),
            reprojected,
            wkid: capWkid || undefined,
            center: ground
                ? { x: (ground.xmin + ground.xmax) / 2, y: (ground.ymin + ground.ymax) / 2 }
                : (((tmp as any).center && isFinite((tmp as any).center.x))
                    ? { x: (tmp as any).center.x, y: (tmp as any).center.y }
                    : (reprojected ? undefined : { x: center.x, y: center.y }))
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
export function matchRestSwatches(rows: LegendRow[], services: any[]): number {
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

/** Multi-class repair: when a classed sublayer (unique values, class
 *  breaks) collapsed to a single unlabeled item in the harvested rows but
 *  the service's REST legend knows several classes, replace that lone item
 *  with the full class list: server-rendered swatch plus label for each.
 *  Single-symbol layers are untouched. */
export function expandRestClasses(rows: LegendRow[], services: any[]): number {
    const norm = (x: any): string => String(x || '').trim().toLowerCase()
    const byLayer = new Map<string, Array<{ label: string, data: string, raw: string }>>()
    for (const svc of services || []) {
        for (const lyr of (svc && svc.layers) || []) {
            const items = ((lyr && lyr.legend) || [])
                .filter((it: any) => it && it.imageData)
                .map((it: any) => ({
                    label: norm(it.label),
                    raw: String(it.label || ''),
                    data: 'data:' + (it.contentType || 'image/png') + ';base64,' + it.imageData
                }))
            if (items.length >= 2) byLayer.set(norm(lyr.layerName), items)
        }
    }
    if (!byLayer.size) return 0
    let expanded = 0
    for (let i = 0; i < rows.length; i++) {
        const r = rows[i]
        if (r.kind !== 'layer' && r.kind !== 'heading') continue
        const cls = byLayer.get(norm(r.label))
        if (!cls) continue
        // collect the item rows that belong to this heading (up to the next
        // heading/layer row)
        let j = i + 1
        const items: number[] = []
        while (j < rows.length && rows[j].kind === 'item') { items.push(j); j++ }
        // only repair the collapse signature: fewer rows than classes and
        // none of the class labels present
        const labelsPresent = items.some(k => cls.some(c => c.label && c.label === norm(rows[k].label)))
        if (items.length >= cls.length || labelsPresent) continue
        const indent = (items.length ? (rows[items[0]].indent || 0) : ((r.indent || 0) + 1))
        const fresh: LegendRow[] = cls.map(c => ({
            kind: 'item' as const,
            label: c.raw,
            dataUrl: c.data,
            indent
        }))
        rows.splice(items.length ? items[0] : i + 1, items.length, ...fresh)
        expanded += cls.length
        i += fresh.length
    }
    return expanded
}

/** Extract a swatch data URL from a legend symbol cell (canvas, img, or
 *  inline svg), normalizing anything that is not already a data URL. */
async function swatchFromCell(cell: Element | null): Promise<string | null> {
    if (!cell) return null
    try {
        const canvas = (cell.querySelector('canvas') || deepQuery(cell, 'canvas')) as HTMLCanvasElement | null
        if (canvas) {
            try { return canvas.toDataURL('image/png') } catch (e) { /* tainted */ }
        }
        const img = (cell.querySelector('img') || deepQuery(cell, 'img')) as HTMLImageElement | null
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
export async function harvestLegendDom(root: Element, labelsOnly?: boolean): Promise<LegendRow[]> {
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
/** querySelectorAll that also descends into open shadow roots. Newer
 *  ArcGIS Maps SDK builds (EB 1.21+) render widgets as web components
 *  (e.g. <arcgis-legend>) whose internals live behind shadow DOM, which
 *  plain querySelector cannot see. Bounded traversal, best-effort. */
export function deepQueryAll(root: any, selector: string, cap: number = 400): Element[] {
    const out: Element[] = []
    const stack: any[] = [root]
    const seen = new Set<any>()
    while (stack.length && out.length < cap) {
        const r = stack.pop()
        if (!r || seen.has(r)) continue
        seen.add(r)
        let found: Element[] = []
        try { found = r.querySelectorAll ? Array.from(r.querySelectorAll(selector)) : [] } catch (e) { /* noop */ }
        for (const f of found) { if (out.length < cap) out.push(f) }
        let all: Element[] = []
        try { all = r.querySelectorAll ? Array.from(r.querySelectorAll('*')) : [] } catch (e) { /* noop */ }
        for (const el of all) {
            const sr = (el as any).shadowRoot
            if (sr) stack.push(sr)
        }
    }
    return out
}

export function deepQuery(root: any, selector: string): Element | null {
    return deepQueryAll(root, selector, 1)[0] || null
}

/** Resolve a legend root from a holder: light-DOM .esri-legend first, then
 *  shadow-DOM .esri-legend, then the <arcgis-legend> component itself. */
function legendRootIn(holder: any): Element | null {
    try {
        const light = holder.querySelector && holder.querySelector('.esri-legend')
        if (light) return light
        const deep = deepQuery(holder, '.esri-legend')
        if (deep) return deep
        const comp = (holder.querySelector && holder.querySelector('arcgis-legend')) || deepQuery(holder, 'arcgis-legend')
        if (comp) {
            const inner = (comp as any).shadowRoot ? deepQuery((comp as any).shadowRoot, '.esri-legend') : null
            return inner || comp
        }
    } catch (e) { /* noop */ }
    return null
}

export function findLegendDom(widgetId?: string): Element | null {
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
                        const el = legendRootIn(holder)
                        if (el) {
                            return el
                        }
                    }
                } catch (e2) { /* try next */ }
            }
        }
        return legendRootIn(document)
    } catch (e) { return null }
}

/** Build legend rows from the JSAPI Legend widget's own model
 *  (activeLayerInfos), so the printed legend mirrors exactly what the
 *  Legend widget shows: layer visibility, legendEnabled, scale ranges,
 *  group layers, map-service sublayers, and every renderer type the API
 *  supports. Falls back to a renderer walk when the module is missing. */
/* ------------------------------------------------------------------ */
/* legend: scale-dependent filtering                                    */
/* ------------------------------------------------------------------ */

export interface LayerScaleRange { title: string, minScale: number, maxScale: number }

/** SDK visibility rule: a layer draws at `scale` when minScale is 0 or
 *  scale <= minScale (not zoomed out past it) AND maxScale is 0 or
 *  scale >= maxScale (not zoomed in past it). Pure/exported. */
export function visibleAtScale (r: { minScale: number, maxScale: number }, scale: number): boolean {
    const mn = Number(r.minScale) || 0
    const mx = Number(r.maxScale) || 0
    if (!(scale > 0)) return true
    if (mn > 0 && scale > mn) return false
    if (mx > 0 && scale < mx) return false
    return true
}

/** Collect {title, minScale, maxScale} for every layer and map-service
 *  sublayer in the view. Duplicate titles merge to the most permissive
 *  range so a shared name can never hide a layer that does draw. */
export function collectLayerScaleRanges (view: MapView): LayerScaleRange[] {
    const out = new Map<string, LayerScaleRange>()
    const add = (title: any, minScale: any, maxScale: any): void => {
        const t = String(title || '').trim()
        if (!t) return
        const mn = Number(minScale) || 0
        const mx = Number(maxScale) || 0
        const prev = out.get(t)
        if (!prev) { out.set(t, { title: t, minScale: mn, maxScale: mx }); return }
        // union of ranges: 0 means unbounded on that side
        prev.minScale = (prev.minScale === 0 || mn === 0) ? 0 : Math.max(prev.minScale, mn)
        prev.maxScale = (prev.maxScale === 0 || mx === 0) ? 0 : Math.min(prev.maxScale, mx)
    }
    const walkSub = (node: any): void => {
        if (!node) return
        add(node.title, node.minScale, node.maxScale)
        const subs = node.sublayers
        const arr: any[] = subs ? (subs.toArray ? subs.toArray() : Array.from(subs)) : []
        for (const s of arr) walkSub(s)
    }
    try {
        const all: any = (view.map as any).allLayers
        const layers: any[] = all ? (all.toArray ? all.toArray() : Array.from(all)) : []
        for (const l of layers) {
            add(l.title, l.minScale, l.maxScale)
            if (l.sublayers) {
                const subs: any[] = l.sublayers.toArray ? l.sublayers.toArray() : Array.from(l.sublayers)
                for (const s of subs) walkSub(s)
            }
        }
    } catch (e) { /* best-effort */ }
    return Array.from(out.values())
}

/** Drop legend rows for layers not drawn at the printed scale. A 'layer'
 *  or 'heading' row whose label matches a known layer title outside its
 *  scale range is removed together with its nested rows (items, notes and
 *  deeper-indented layers) up to the next row at the same or shallower
 *  indent. Rows with no matching title are never touched. Pure/exported. */
export function filterLegendRowsByScale (rows: LegendRow[], ranges: LayerScaleRange[], scale: number): LegendRow[] {
    if (!rows.length || !ranges.length || !(scale > 0)) return rows
    const byTitle = new Map<string, LayerScaleRange>()
    for (const r of ranges) byTitle.set(r.title.toLowerCase(), r)
    const out: LegendRow[] = []
    let i = 0
    while (i < rows.length) {
        const row = rows[i]
        const isHead = row.kind === 'layer' || row.kind === 'heading'
        const rng = isHead ? byTitle.get(String(row.label || '').trim().toLowerCase()) : undefined
        if (rng && !visibleAtScale(rng, scale)) {
            const depth = Number(row.indent) || 0
            i++
            while (i < rows.length) {
                const nx = rows[i]
                const nxHead = nx.kind === 'layer' || nx.kind === 'heading'
                if (nxHead && (Number(nx.indent) || 0) <= depth) break
                i++
            }
            continue
        }
        out.push(row)
        i++
    }
    // A group heading left with nothing under it is noise: drop it. Layer
    // rows are kept even when childless (single-symbol layers carry their
    // swatch on the layer row itself).
    const cleaned: LegendRow[] = []
    for (let k = 0; k < out.length; k++) {
        const r = out[k]
        if (r.kind === 'heading') {
            const depth = Number(r.indent) || 0
            const nx = out[k + 1]
            const nxHead = !!nx && (nx.kind === 'layer' || nx.kind === 'heading')
            if (!nx || (nxHead && (Number(nx.indent) || 0) <= depth)) continue
        }
        cleaned.push(r)
    }
    return cleaned
}

/** Printed-scale estimate BEFORE capture (same rule captureMapHiRes uses;
 *  aspect-only fit so frame inches stand in for capture pixels). */
export function estimatePrintedScale (view: MapView, frameWIn: number, frameHIn: number, layout: PrintLayout, opts: RenderOptions): number {
    try {
        const mpu = metersPerMapUnit(view.scale, view.resolution)
        const ext: any = view.extent
        const fit = ext ? extentFitScale(ext.width, ext.height, mpu, frameWIn, frameHIn, frameWIn, frameHIn) : 0
        const mode: PrintScaleMode = opts.scaleMode || (layout.preserve === 'extent' ? 'preserveExtent' : 'current')
        return resolvePrintedScale(mode, view.scale, opts.fixedScale, fit)
    } catch (e) { return view.scale }
}

export async function buildLegendRows(view: MapView, maxItems: number, onProgress: RenderProgress, legendWidgetId?: string): Promise<LegendRow[]> {
    onProgress('Building legend\u2026')
    const coverageOf = (rows: LegendRow[]): number => {
        const items = rows.filter(r => r.kind === 'item')
        if (!items.length) return 0
        return items.filter(r => isEmbeddableSwatch(r.dataUrl)).length / items.length
    }
    const restUpgrade = async (rows: LegendRow[]): Promise<void> => {
        // upgrade map-service swatches to print resolution: the DOM
        // bitmaps are screen-density; the REST legend at high dpi is not
        try {
            const services: any[] = []
            const svcLayers = (view.map.allLayers || ({ toArray: () => [] } as any))
                .filter((l: any) => l.visible !== false && typeof l.url === 'string' &&
                    (l.type === 'map-image' || l.type === 'tile' || l.type === 'feature'))
            const arr: any[] = svcLayers.toArray ? svcLayers.toArray() : svcLayers
            const roots = new Set<string>()
            for (const l of arr) {
                // FeatureServer sublayer URLs end in /<id>; the legend endpoint
                // lives at the service root and covers every sublayer at once
                roots.add(String(l.url).replace(/\/\d+\/?$/, ''))
            }
            await Promise.all(Array.from(roots).map(async (u: string) => {
                try { services.push(await fetchRestLegend(u)) } catch (e) { /* per-service best-effort */ }
            }))
            matchRestSwatches(rows, services)
            expandRestClasses(rows, services)
            // Group-of-unlabeled-sublayers repair (see repairServiceGroupItems):
            // build each map service's group -> ordered leaves table from the
            // layer's own sublayer tree, join swatches from the REST legend.
            try {
                const groups: Array<{ title: string, leaves: Array<{ title: string, legend: Array<{ label: string, data: string }> }> }> = []
                for (const l of arr) {
                    if (!(l.type === 'map-image' || l.type === 'tile')) continue
                    let json: any = null
                    try { json = await fetchRestLegend(String(l.url).replace(/\/\d+\/?$/, '')) } catch (e) { continue }
                    const byId = new Map<number, Array<{ label: string, data: string }>>()
                    for (const le of ((json && json.layers) || [])) {
                        byId.set(Number(le.layerId), ((le.legend || []) as any[])
                            .filter((it: any) => it && it.imageData)
                            .map((it: any) => ({
                                label: String(it.label || ''),
                                data: 'data:' + (it.contentType || 'image/png') + ';base64,' + it.imageData
                            })))
                    }
                    const kidsOf = (node: any): any[] => {
                        const subs = node && node.sublayers
                        if (!subs) return []
                        return subs.toArray ? subs.toArray() : Array.from(subs)
                    }
                    const leavesOf = (node: any): Array<{ id: number, title: string }> => {
                        const kids = kidsOf(node)
                        if (!kids.length) {
                            return (node && typeof node.id === 'number' && isFinite(node.id))
                                ? [{ id: node.id, title: String(node.title || '') }]
                                : []
                        }
                        const out: Array<{ id: number, title: string }> = []
                        for (const k of kids) out.push(...leavesOf(k))
                        // legend (and the Legend widget) list leaves in service
                        // definition order = ascending id
                        return out.sort((a, b) => a.id - b.id)
                    }
                    const addGroup = (title: any, node: any): void => {
                        if (!kidsOf(node).length) return // leaves are not groups
                        const leaves = leavesOf(node)
                        if (!leaves.length) return
                        groups.push({
                            title: String(title || ''),
                            leaves: leaves.map(lf => ({ title: lf.title, legend: byId.get(lf.id) || [] }))
                        })
                    }
                    const walkGroups = (node: any): void => {
                        addGroup(node && node.title, node)
                        for (const k of kidsOf(node)) walkGroups(k)
                    }
                    addGroup(l.title, l) // the whole service can be the heading too
                    for (const s of kidsOf(l)) walkGroups(s)
                }
                if (groups.length) repairServiceGroupItems(rows, groups)
            } catch (e) { /* repair is best-effort */ }
        } catch (e) { /* enrichment is best-effort */ }
    }
    // 1) a live Legend widget's rendered DOM: exactly what the user sees.
    //    Gate on swatch coverage: newer SDK builds can hide symbol canvases
    //    behind shadow DOM, harvesting labels but no bitmaps; mostly-gray
    //    rows must defer to the headless model rather than print placeholders
    let domRows: LegendRow[] | null = null
    let domCov = 0
    try {
        const dom = findLegendDom(legendWidgetId)
        if (dom) {
            const rows = await harvestLegendDom(dom)
            if (rows.length) {
                await restUpgrade(rows)
                domRows = rows
                domCov = coverageOf(rows)
                if (domCov >= 0.5) return rows.slice(0, MAX_LEGEND_ROWS)
            }
        }
    } catch (e) { /* fall through */ }
    // 2) headless Legend model (+ REST swatch repair): must actually carry
    //    swatches to win; a swatchless source never beats the next rung
    let modelRows: LegendRow[] | null = null
    let modelCov = 0
    try {
        const rows = await buildRowsFromLegendModel(view)
        if (rows.length) {
            await restUpgrade(rows)
            modelRows = rows
            modelCov = coverageOf(rows)
            if (modelCov >= 0.5 && modelCov >= domCov) return rows.slice(0, MAX_LEGEND_ROWS)
        }
    } catch (e) { /* fall through to renderer walk */ }
    // 3) renderer walk builds swatches straight from layer renderers
    let walkRows: LegendRow[] = []
    let walkCov = 0
    try {
        walkRows = await buildRowsFromRenderers(view, Math.max(maxItems, 200))
        await restUpgrade(walkRows)
        walkCov = coverageOf(walkRows)
    } catch (e) { /* keep going with whatever we have */ }
    // best coverage wins; labels-only is the true last resort
    const cands: Array<{ rows: LegendRow[], cov: number }> = []
    if (domRows && domRows.length) cands.push({ rows: domRows, cov: domCov })
    if (modelRows && modelRows.length) cands.push({ rows: modelRows, cov: modelCov })
    if (walkRows.length) cands.push({ rows: walkRows, cov: walkCov })
    if (!cands.length) return []
    cands.sort((a, b) => b.cov - a.cov)
    return cands[0].rows.slice(0, MAX_LEGEND_ROWS)
}

/** Map a service /legend?f=json response for one sublayer into rows.
 *  Pure and exported for tests. */
export function mapRestLegendToRows(json: any, sublayerId: number, indent: number): LegendRow[] {
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

/** Only data: IMAGE URLs can be embedded by every export backend. The
 *  image/ check matters: ArcGIS Server returns errors as HTTP-200 JSON,
 *  so a failed swatch fetch can round-trip into a data:application/json
 *  URL that would count as coverage and then print as a gray box. */
export function isEmbeddableSwatch(src: string | null | undefined): boolean {
    return !!src && String(src).startsWith('data:image/')
}

/** Repair harvested rows for a map-service GROUP layer whose leaf
 *  sublayers each carry a single UNLABELED symbol (picture markers on
 *  crime/POI services are the classic case). Such layers harvest as a
 *  heading followed by bare items: no names (the renderer label is
 *  empty), no embeddable swatches. The map's own sublayer tree knows the
 *  names and the service's REST legend knows the swatches; marry them
 *  positionally when the item count matches the group's leaf count.
 *  Pure and exported for tests. */
export function repairServiceGroupItems(
    rows: LegendRow[],
    groups: Array<{ title: string, leaves: Array<{ title: string, legend: Array<{ label: string, data: string }> }> }>
): number {
    const norm = (x: any): string => String(x || '').trim().toLowerCase()
    let repaired = 0
    for (let i = 0; i < rows.length; i++) {
        const r = rows[i]
        if (r.kind !== 'heading' && r.kind !== 'layer') continue
        const g = groups.find(x => x.leaves.length > 0 && norm(x.title) === norm(r.label))
        if (!g) continue
        // the contiguous run of item rows belonging to this heading
        let j = i + 1
        const run: number[] = []
        while (j < rows.length && rows[j].kind === 'item') { run.push(j); j++ }
        if (run.length !== g.leaves.length) continue
        // only repair runs that are actually broken (unlabeled or swatchless);
        // a healthy legend is never rewritten
        const broken = run.every(k => !rows[k].label || !isEmbeddableSwatch(rows[k].dataUrl))
        if (!broken) continue
        for (let k = 0; k < run.length; k++) {
            const item = rows[run[k]]
            const leaf = g.leaves[k]
            if (!item.label && leaf.title) { item.label = leaf.title; repaired++ }
            if (!isEmbeddableSwatch(item.dataUrl) && leaf.legend.length) {
                item.dataUrl = leaf.legend[0].data
                repaired++
            }
        }
    }
    return repaired
}

let _esriRequestP: Promise<any> | null = null
function esriRequestModule(): Promise<any> {
    if (!_esriRequestP) _esriRequestP = loadArcGISJSAPIModules(['esri/request']).then(m => m[0])
    return _esriRequestP
}

const _swatchUrlCache = new Map<string, Promise<string | null>>()

/** Normalize an http(s)/blob swatch URL to a data URL so jsPDF and the
 *  raster/SVG backends can embed it. Goes through esri/request so portal
 *  tokens apply to secured services. Cached per URL: repeated symbols
 *  cost one fetch, not one per legend row. */
async function urlToDataUrl(src: string): Promise<string | null> {
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
                // ArcGIS Server reports failures as HTTP-200 JSON; an error
                // body is not a swatch and must not be embedded as one
                if (blob.type && !String(blob.type).startsWith('image/')) return null
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
async function fetchRestLegend(serviceUrl: string, dpi: number = LEGEND_SWATCH_DPI): Promise<any> {
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
function sublayerRestTarget(ali: any): { url: string, id: number } | null {
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
        // map-service legend infos carry a server-rendered image URL in
        // .src (no client symbol object exists for those)
        if (!dataUrl && info && typeof info.src === 'string' && info.src) {
            dataUrl = await urlToDataUrl(info.src)
        }
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
        // logo breathing room: widget-supplied logos (as opposed to pictures
        // authored in the .pagx, which render at their exact Pro bounds) are
        // often tightly cropped; inset them so the artwork never presses
        // against adjacent borders or the frame line
        let ix = x; let iy = y; let iw = w; let ih = h
        if (!el.dataUrl && defaultLogo) {
            const inset = Math.min(6, Math.max(1.5, Math.min(w, h) * 0.07))
            ix += inset; iy += inset
            iw = Math.max(1, w - inset * 2); ih = Math.max(1, h - inset * 2)
        }
        try {
            await d.image(dataUrl, fmt, ix, iy, iw, ih, 'contain', el.anchorH || 'left', el.anchorV || 'bottom')
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

export function legendPatchPt(size: LegendPatchSize | undefined, fontPt: number): { w: number, h: number } {
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
export function layoutLegend(
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

    const prefCols = cfg.columns && cfg.columns > 0 ? Math.min(8, Math.round(cfg.columns)) : 0
    // Auto column search is width-aware: a wide box (a horizontal bottom
    // legend) should be allowed more columns than the old fixed cap of 4,
    // while a narrow panel still tops out low because wider counts fail the
    // colW >= 50 guard in tryFit. Only ADDS candidates; the fitter still
    // picks the largest clean font, so narrow legends are unaffected.
    const autoMax = Math.max(4, Math.min(8, Math.floor((innerW + gutter) / (110 + gutter))))
    const colsList = prefCols
        ? Array.from({ length: prefCols }, (_, i) => i + 1)
        : Array.from({ length: autoMax }, (_, i) => i + 1)
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

export function approxTextWidthPt(text: string, fontPt: number): number {
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
export function trimPanelBox(
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

export function computeLegendPanel(
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
export function paginateLegendRows(
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
export async function drawLegendPage(d: Drawer, pageWIn: number, pageHIn: number, rows: LegendRow[], cfgIn?: LegendConfig): Promise<void> {
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

async function drawLegendEl(d: Drawer, el: LegendEl, rows: LegendRow[], cfgIn?: LegendConfig, isPanel?: boolean, bottomAnchor?: boolean): Promise<number> {
    const cfg: LegendConfig = { ...LEGEND_DEFAULTS, ...(cfgIn || {}), enabled: true }
    const lx = el.xIn * PT_PER_IN
    let ly = el.yIn * PT_PER_IN
    const lw = el.wIn * PT_PER_IN
    const lh = el.hIn * PT_PER_IN

    const layout = layoutLegend(rows, lw, lh, cfg, (t, f) => { d.setFont('normal', f); return d.textWidth(t) })
    // Panels sit beside the map inside the composition frame: no inner
    // border box, and the background covers the full panel strip.
    const boxH = isPanel ? lh : Math.min(lh, Math.max(layout.usedHeightPt, layout.titleFontPt + 20))
    // Bottom-anchored corner overlay (bottomLeft/bottomRight): the reserved
    // box spans the full configured height, but the drawn legend is only
    // boxH tall and otherwise draws from the top - which floats a short
    // legend up to the middle. Shift the whole thing down by the unused
    // height so it sits flush with the bottom of its reserved box (i.e. the
    // bottom of the map frame). Top positions keep the top origin.
    if (bottomAnchor && !isPanel && lh > boxH) ly += (lh - boxH)

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

export function lonToMercX(lonDeg: number): number { return R_MERC * lonDeg * Math.PI / 180 }
export function mercXToLon(x: number): number { return (x / R_MERC) * 180 / Math.PI }
export function latToMercY(latDeg: number): number { return R_MERC * Math.asinh(Math.tan(latDeg * Math.PI / 180)) }
export function mercYToLat(y: number): number { return Math.atan(Math.sinh(y / R_MERC)) * 180 / Math.PI }

/** Clean 1 / 2 / 2.5 / 5 x 10^k interval targeting ~divisions lines. */
export function niceGridInterval(span: number, divisions = 4): number {
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

export function niceGraticuleInterval(spanDeg: number, divisions = 4): number {
    const raw = spanDeg / Math.max(1, divisions)
    for (const step of DEG_LADDER) {
        if (step <= raw) return step
    }
    return DEG_LADDER[DEG_LADDER.length - 1]
}

/** Degrees -> D°MM'SS" trimming units the interval never needs. */
export function fmtDMS(deg: number, intervalDeg: number): string {
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
export function clipSegToRect(
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
export function buildGraticuleGeometry(
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
export function gridMarkScale(mf: { wIn: number, hIn: number }): number {
    return Math.max(1, Math.min(5, Math.min(mf.wIn, mf.hIn) / 6.5))
}

/** Cartographic geographic label: 108°30'W rather than -108°30'. */
export function fmtGeoLabel(deg: number, intervalDeg: number, axis: 'lon' | 'lat'): string {
    const base = fmtDMS(Math.abs(deg), intervalDeg)
    if (Math.abs(deg) < 1e-12) return base
    return base + (axis === 'lon' ? (deg < 0 ? 'W' : 'E') : (deg < 0 ? 'S' : 'N'))
}

export interface GridLine { x1In: number, y1In: number, x2In: number, y2In: number }
export interface GridLabel { text: string, xIn: number, yIn: number, edge: 'top' | 'bottom' | 'left' | 'right' }
export interface GridGeometry { lines: GridLine[], crosses: GridLine[], ticks: GridLine[], labels: GridLabel[] }

/** Pure geometry builder for graticule / measured grids (rotation 0).
 *  Returns page-inch line work + edge label anchors; the caller styles it. */
export function buildGridGeometry(
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
export function buildReferenceGrid(
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
function drawGrid(d: Drawer, geom: GridGeometry, cfg: GridConfig): void {
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

function boxesIntersect(a: BoxIn, b: BoxIn): boolean {
    const eps = 0.01
    return !(a.xIn + a.wIn <= b.xIn + eps || b.xIn + b.wIn <= a.xIn + eps ||
        a.yIn + a.hIn <= b.yIn + eps || b.yIn + b.hIn <= a.yIn + eps)
}

/** Corner-overlay placement that avoids overlapping other content inside
 *  the map frame (overview inset, authored elements over the frame).
 *  Strategy: keep the configured corner if free; otherwise slide within
 *  the corner column past the obstacles; otherwise try the other corners
 *  (same edge first). Pure and exported for tests. */
export function resolveLegendCorner(
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

export function overviewBoxIn(
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
export function overviewIndicatorIn(
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
async function getProjector(): Promise<{ project: (pt: any, sr: any) => any, Point: any } | null> {
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
    // Coordinate tokens on a projected capture need the SDK projection
    // engine; load it once here (async) so token resolution stays sync.
    let toWgs84: TextTokens['toWgs84']
    const needsProjector = cap.projection === 'projected' && (cap.wkid || 0) > 0 &&
        (layout.elements || []).some(e => (e as LayoutElement).type === 'text' && /\{coord:/.test(String((e as TextEl).text || '')))
    if (needsProjector) {
        try {
            const projector = await getProjector()
            if (projector) {
                const PointCls: any = projector.Point
                const capSR = new SpatialReference({ wkid: cap.wkid })
                const wgs = new SpatialReference({ wkid: 4326 })
                toWgs84 = (x: number, y: number): [number, number] | null => {
                    try {
                        const out: any = projector.project(new PointCls({ x, y, spatialReference: capSR }), wgs)
                        return out && isFinite(out.x) && isFinite(out.y) ? [out.x, out.y] : null
                    } catch (e) { return null }
                }
            }
        } catch (e) { /* coordinate tokens resolve to '' */ }
    }
    const tokens: TextTokens = {
        title, printedScale: cap.printedScale,
        author: opts.author, copyright: opts.copyright, attribution: opts.attribution,
        layoutName: layout.name, mapName: opts.mapName, user: opts.user,
        pageWidthIn: layout.pageWidthIn, pageHeightIn: layout.pageHeightIn,
        rotation: cap.rotation, dpi: cap.effectiveDpi,
        wkid: cap.wkid, srWkt: opts.srWkt, srUnit: opts.srUnit,
        center: cap.center, groundExtent: cap.groundExtent, projection: cap.projection,
        toWgs84,
        pageNumber: opts.pageNumber, pageCount: opts.pageCount, pageName: opts.pageName
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
                    // The .pagx legend element carries the author's column
                    // count and title choice; let them fill in wherever the
                    // settings legend config did not specify, so a horizontal
                    // bottom legend flows into the authored columns and drops
                    // a title the author disabled (both critical in a short
                    // frame). Explicit settings still win when present.
                    const le = el as LegendEl
                    const elCfg: LegendConfig = { ...(layout.legend || ({} as any)) }
                    if (typeof le.columns === 'number' && le.columns > 0 &&
                        !(Number((layout.legend as any)?.columns) > 0)) {
                        (elCfg as any).columns = le.columns
                    }
                    if (typeof le.showTitle === 'boolean' &&
                        (layout.legend as any)?.showTitle === undefined) {
                        (elCfg as any).showTitle = le.showTitle
                    }
                    const miss = await drawLegendEl(d, le, legendRows, elCfg)
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
                // bottomLeft/bottomRight corner overlays anchor to the bottom
                // of their reserved box; top corners keep the top origin.
                // (Adjacent panels - opts.legendBox - fill their strip, so no
                // anchoring is applied there.)
                const bottomAnchor = !opts.legendBox && /^bottom/.test(String(lCfg.position || 'bottomLeft'))
                const miss = await drawLegendEl(d, { type: 'legend', name: 'settingsLegend', xIn: box.xIn, yIn: box.yIn, wIn: box.wIn, hIn: box.hIn, maxItems: 0 } as LegendEl, legendRows, lCfg, !!opts.legendBox, bottomAnchor)
                if (miss > 0) (opts as any)._legendTruncated = Math.max(Number((opts as any)._legendTruncated) || 0, miss)
            }
        } catch (e) { /* legend is best-effort */ }
    }

    // QR code: printed maps become a door back to the live interactive map
    if (!(opts as any).mapOnly && (opts as any).qrUrl) {
        try {
            const q = qrModules(String((opts as any).qrUrl))
            if (q) {
                const mfq = getMapFrame(layout)
                const qrSide = 0.62 * PT_PER_IN
                const mod = qrSide / q.size
                // quiet zone: the spec requires 4 clear modules on every side;
                // anything inside it (borders, captions) breaks scanners
                const qz = Math.max(6, mod * 4)
                const capText = String((opts as any).qrCaption || 'Scan for interactive map')
                d.setFont('normal', 5.5)
                const capW2 = Math.min(d.textWidth(capText), qrSide + qz * 2)
                const boxW2 = Math.max(qrSide, capW2) + qz * 2
                const boxH2 = qz + qrSide + qz + 8
                const bx = (mfq.xIn + mfq.wIn) * PT_PER_IN - boxW2 - 6
                const by = (mfq.yIn + mfq.hIn) * PT_PER_IN - boxH2 - 6
                d.setFill(255, 255, 255)
                d.rect(bx, by, boxW2, boxH2, 'F')
                const qx = bx + (boxW2 - qrSide) / 2
                d.setFill(0, 0, 0)
                for (let r = 0; r < q.size; r++) {
                    for (let c = 0; c < q.size; c++) {
                        if (q.get(r, c)) d.rect(qx + c * mod, by + qz + r * mod, mod + 0.05, mod + 0.05, 'F')
                    }
                }
                d.setTextColor(70, 70, 70)
                d.text(capText, bx + boxW2 / 2, by + qz + qrSide + qz + 4, 'center')
            }
        } catch (e) { /* QR is best-effort */ }
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

/** GeoTIFF tag types are not in UTIF's default table; register them once so
 *  the encoder writes ModelPixelScale/ModelTiepoint (DOUBLE), GeoKeyDirectory
 *  (SHORT) and GeoAsciiParams (ASCII). Idempotent. */
function ensureGeoTiffTagTypes (): void {
    try {
        const tt = (UTIF as any).ttypes
        if (tt && tt[33550] == null) {
            tt[33550] = 12 // ModelPixelScaleTag (DOUBLE)
            tt[33922] = 12 // ModelTiepointTag (DOUBLE)
            tt[34735] = 3  // GeoKeyDirectoryTag (SHORT)
            tt[34736] = 12 // GeoDoubleParamsTag (DOUBLE)
            tt[34737] = 2  // GeoAsciiParamsTag (ASCII)
        }
    } catch (e) { /* geo tags stay absent -> plain TIFF */ }
}

/** GeoTIFF georeferencing metadata (embedded, north-up) for a raster of
 *  W x H covering ground extent, in the CRS identified by EPSG wkid. Returns
 *  a UTIF metadata IFD, or null when the wkid is unusable. Pure/exported. */
export function geoTiffMeta (
    W: number, H: number,
    ext: { xmin: number, ymin: number, xmax: number, ymax: number },
    wkid: number,
    geographicHint?: boolean
): Record<string, any> | null {
    if (!(W > 0) || !(H > 0) || !(ext.xmax > ext.xmin) || !(ext.ymax > ext.ymin) || !(wkid > 0)) return null
    const sx = (ext.xmax - ext.xmin) / W
    const sy = (ext.ymax - ext.ymin) / H
    // Geographic vs projected decides which GeoKey carries the code. Prefer
    // the caller's knowledge (SR.isGeographic / WKT root), then a heuristic:
    // EPSG geographic 2D codes live in 4000-4999 plus a few legacy ones, and
    // a degree-sized extent with tiny pixel sizes is a strong tell.
    const geographic = typeof geographicHint === 'boolean'
        ? geographicHint
        : ((wkid >= 4000 && wkid <= 4999) || wkid === 104199 || wkid === 104200 ||
            (Math.abs(ext.xmin) <= 180 && Math.abs(ext.xmax) <= 180 && Math.abs(ext.ymin) <= 90 && Math.abs(ext.ymax) <= 90 && sx < 0.1))
    // GeoKeyDirectory: header [KeyDirVersion=1, KeyRev=1, MinorRev=0, NumKeys],
    // then 4-short entries {KeyID, TIFFTagLocation=0 (value inline), Count=1, Value}
    const dir = geographic
        ? [1, 1, 0, 3, 1024, 0, 1, 2, 1025, 0, 1, 1, 2048, 0, 1, wkid]   // GTModelType=Geographic, GeographicTypeGeoKey
        : [1, 1, 0, 3, 1024, 0, 1, 1, 1025, 0, 1, 1, 3072, 0, 1, wkid]   // GTModelType=Projected, ProjectedCSTypeGeoKey
    return {
        t33550: [sx, sy, 0],
        t33922: [0, 0, 0, ext.xmin, ext.ymax, 0], // raster (0,0) -> ground top-left
        t34735: dir,
        t34737: ['GeoTIFF (Print Advanced)|']
    }
}

function encodeTiff(canvas: HTMLCanvasElement, geo?: { ext: { xmin: number, ymin: number, xmax: number, ymax: number }, wkid: number, geographic?: boolean } | null): Blob {
    const { data, w, h } = canvasRgba(canvas)
    let meta: Record<string, any> | undefined
    if (geo && geo.wkid > 0) {
        ensureGeoTiffTagTypes()
        meta = geoTiffMeta(w, h, geo.ext, geo.wkid, geo.geographic) || undefined
    }
    const buf: ArrayBuffer = meta
        ? UTIF.encodeImage(data.buffer, w, h, meta)
        : UTIF.encodeImage(data.buffer, w, h)
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
    // Scale-dependent legend: layers that do not draw at the PRINTED scale
    // (which differs from the screen scale in fixed / fit-extent modes) are
    // dropped so the legend never lists a symbol the map does not show.
    // Filtered here with the pre-capture estimate (so panel sizing sees the
    // final row count) and again after capture with the exact scale.
    const scaleFilterOn = options.legendScaleFilter !== false
    const applyScaleFilter = (rows: LegendRow[], scale: number): LegendRow[] => {
        if (!scaleFilterOn || !rows.length || !(scale > 0)) return rows
        try {
            const before = rows.length
            const out = filterLegendRowsByScale(rows, collectLayerScaleRanges(liveView), scale)
            if (out.length < before) onProgress('Legend: hid ' + (before - out.length) + ' row(s) not drawn at 1:' + Math.round(scale).toLocaleString() + '.')
            return out
        } catch (e) { return rows }
    }
    const legendRowsPromise: Promise<LegendRow[]> = hasLegend
        ? buildLegendRows(
            liveView,
            Math.max(1, ((useLayout.elements.find(e => e.type === 'legend') as LegendEl)?.maxItems) || 30),
            onProgress,
            options.legendWidgetId
        ).then(rows => applyScaleFilter(rows, estimatePrintedScale(liveView, mf.wIn, mf.hIn, useLayout, options)))
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

    // A georeferenced map-only raster (world file / GeoTIFF) OR a Google Earth
    // KMZ is captured north-up: the world file, the GeoTIFF tiepoint, and the
    // KMZ corner quad are all axis-aligned, so any (often accidental) view
    // rotation must be ignored for these captures.
    if ((options.georeference || options.googleEarthKmz) && options.mapOnly) {
        options = { ...options, forceNorthUp: true }
    }
    const cap = await captureMapHiRes(liveView, mf.wIn, mf.hIn, useLayout, maxImagePx, options, onProgress)
    if (!panelPlacement) legendRows = await legendRowsPromise
    // exact printed scale is known now: re-apply (idempotent when unchanged)
    if (legendRows.length && Math.abs(cap.printedScale - estimatePrintedScale(liveView, mf.wIn, mf.hIn, useLayout, options)) > 1) {
        legendRows = applyScaleFilter(legendRows, cap.printedScale)
    }

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
                const capSR = new SpatialReference({
                    wkid: (options.outputWkid && options.outputWkid > 0)
                        ? options.outputWkid
                        : ((liveView.spatialReference as any)?.wkid || 4326)
                })
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
        const CANVAS_CAP = memoryConstrainedDevice() ? 4096 : 8000
        if (longEdgePx > CANVAS_CAP) {
            pageDpi = Math.floor(CANVAS_CAP / Math.max(useLayout.pageWidthIn, useLayout.pageHeightIn))
            if (memoryConstrainedDevice()) {
                onProgress('Page raster capped at ' + CANVAS_CAP + ' px for this device\u2019s memory; ' + pageDpi + ' DPI.')
            }
        }
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
            case 'tiff': blob = encodeTiff(drawer.canvas,
                (options.georeference && options.mapOnly && cap.rotation === 0 && cap.groundExtent && (options.georefWkid || 0) > 0)
                    ? { ext: cap.groundExtent, wkid: Number(options.georefWkid), geographic: typeof options.georefGeographic === 'boolean' ? options.georefGeographic : isGeographicWkt(options.georefWkt || options.srWkt) }
                    : null)
                break
            case 'eps': blob = encodeEps(drawer.canvas, pageW, pageH); break
            default: throw new Error('Unsupported format: ' + format)
        }
        // Google Earth (KMZ): package the MAP-ONLY raster with a doc.kml
        // GroundOverlay instead of downloading the bare image. The four map
        // corners are tied to WGS84 lon/lat via gx:LatLonQuad, so the overlay
        // drapes on the globe for ANY source coordinate system. Requires a
        // north-up capture with a known ground extent (forced above).
        if (options.googleEarthKmz && options.mapOnly && cap.rotation === 0 && cap.groundExtent) {
            onProgress('Georeferencing for Google Earth…')
            const liveWkid = Number((liveView.spatialReference as any)?.wkid) || 0
            const capWkid = (options.outputWkid && options.outputWkid > 0) ? Number(options.outputWkid) : liveWkid
            const quad = await extentCornersToWgs84(cap.groundExtent, cap.projection, capWkid)
            if (quad) {
                const imgBytes = new Uint8Array(await blob.arrayBuffer())
                const imgName = 'overlay.' + (format === 'jpg' ? 'jpg' : 'png')
                const kmz = buildKmzBlob(imgBytes, imgName, quad, title)
                const kmzName = outName.replace(/\.[^.]+$/, '') + '.kmz'
                onProgress('Packaging KMZ…')
                lastUrl = downloadBlob(kmz, kmzName); lastSize = kmz.size
                onProgress('Wrote KMZ for Google Earth (' + Math.round(kmz.size / 1024) + ' KB).')
                return {
                    fileName: kmzName,
                    effectiveDpi: Math.round(cap.effectiveDpi),
                    warning: cap.warning || undefined,
                    printedScale: Math.round(cap.printedScale),
                    url: lastUrl || undefined,
                    sizeKb: lastSize ? Math.round(lastSize / 1024) : undefined
                }
            }
            // Corner projection unavailable: fall through to a plain raster
            // download with a note rather than failing the export outright.
            cap.warning = (cap.warning ? cap.warning + ' ' : '') +
                'Could not build the Google Earth KMZ (the coordinate system could not be projected to lat/long); exported the plain image instead.'
            onProgress('KMZ unavailable: exported the plain image.')
        }
        lastUrl = downloadBlob(blob, outName); lastSize = blob.size
        // Georeference a MAP-ONLY raster: the image is the map edge to edge,
        // so the capture's ground extent maps exactly onto the output pixels.
        // Full layouts are skipped (the map is a sub-rectangle of the page)
        // and rotated captures are skipped (world files are north-up only).
        // TIFF carries a TRUE embedded GeoTIFF (handled above, no sidecar);
        // PNG/JPG/GIF get the world file + .prj instead.
        const embeddedGeoTiff = format === 'tiff' && options.georeference && options.mapOnly &&
            cap.rotation === 0 && !!cap.groundExtent && (options.georefWkid || 0) > 0
        if (embeddedGeoTiff) {
            onProgress('Wrote GeoTIFF (coordinate system embedded, EPSG:' + options.georefWkid + ').')
        } else if (options.georeference && options.mapOnly && cap.rotation === 0 &&
            cap.groundExtent && worldFileExt(format)) {
            const wf = emitGeoSidecars(outName, format, drawer.canvas.width, drawer.canvas.height,
                cap.groundExtent, options.georefWkt)
            if (wf) onProgress('Wrote world file ' + wf + (options.georefWkt ? ' + .prj' : '') + '.')
        }
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