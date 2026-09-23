/**
 * True vector output for feature layers (Summit 2, phase 1).
 *
 * The raster capture keeps basemaps, imagery and anything this module cannot
 * reproduce exactly. Operational feature layers that CAN be reproduced are
 * hidden in the offscreen capture view only (layerView.visible, never the
 * shared layer) and drawn here as PDF / SVG paths instead: crisp at any zoom,
 * selectable, and small.
 *
 * A layer is vectorized only when every part of its look is supported:
 *   renderers  simple, unique-value (field based), class-breaks (field based,
 *              no normalization), with no visual variables
 *   symbols    simple-fill (solid, none, and the six hatch styles),
 *              simple-line (all dash styles), simple-marker (circle, square,
 *              diamond, triangle, cross, x)
 *   labels     label classes with a plain field expression ($feature.NAME,
 *              string concatenation, or legacy [NAME]) and a text symbol;
 *              placed like the SDK (point offsets, polygon interior point,
 *              line center-along) with greedy collision removal
 *   no clustering/binning, effects, blend modes or time filtering
 * Rotated maps are drawn through the capture's pixel-to-ground transform.
 * Anything else stays in the raster capture, and the export says why. That is
 * the honest-fallback rule: a print never silently loses or restyles a layer.
 *
 * Pure parts (symbol mapping, renderer resolution, eligibility, dash
 * patterns, drawing against a Drawer) are exported for tests. Author: Brian
 * McLeer, City of Grand Junction.
 */
import type { Drawer } from './drawing'

/** 0-255 channels, alpha 0-1. */
export type RGBA = [number, number, number, number]

export interface VStroke {
    color: RGBA
    widthPt: number
    /** Dash lengths in points, or null for solid. */
    dash: number[] | null
}

export type MarkerStyle = 'circle' | 'square' | 'diamond' | 'triangle' | 'cross' | 'x'

export type HatchStyle = 'horizontal' | 'vertical' | 'forward-diagonal' | 'backward-diagonal' | 'cross' | 'diagonal-cross'

export interface VSymbol {
    kind: 'fill' | 'line' | 'marker'
    fill: RGBA | null
    /** Hatched fill: lines in the fill color over the polygon. */
    hatch?: { style: HatchStyle, color: RGBA }
    stroke: VStroke | null
    marker?: {
        style: MarkerStyle | 'path' | 'picture'
        sizePt: number
        angle: number
        xoffPt: number
        yoffPt: number
        /** Path markers: subpaths in a unit box centred on 0,0 (largest side 1). */
        path?: Array<Array<[number, number]>>
        /** Picture markers: image source and size in points. */
        pic?: { url: string, wPt: number, hPt: number }
    }
}

export interface VGeom {
    kind: 'polygon' | 'polyline' | 'point'
    rings?: number[][][]
    paths?: number[][][]
    x?: number
    y?: number
}

export interface VectorFeature {
    geom: VGeom
    sym: VSymbol
    /** Label text and the index of its label class in the layer's specs. */
    label?: { text: string, spec: number }
}

export interface VectorLayerData {
    id: string
    title: string
    /** Layer opacity (0-1), multiplied into every symbol's alpha. */
    opacity: number
    features: VectorFeature[]
    /** Picture-marker images, source url -> PNG data URL (filled in by the
     *  planner before drawing). */
    images?: Record<string, string>
    /** Label classes in effect at the printed scale (empty = no labels). */
    labels?: LabelSpec[]
}

export interface LabelSpec {
    color: RGBA
    haloColor: RGBA | null
    haloPt: number
    sizePt: number
    weight: 'normal' | 'bold' | 'italic'
    placement: string
    xoffPt: number
    yoffPt: number
}

/* ------------------------------------------------------------------ */
/* colors, dashes, symbols                                              */
/* ------------------------------------------------------------------ */

/** SDK Color (r, g, b, a 0-1) or REST JSON color ([r, g, b, a 0-255]). */
export function colorOf (c: any): RGBA | null {
    if (c === null || c === undefined) return null
    if (Array.isArray(c)) {
        if (c.length < 3) return null
        const a = c.length > 3 ? Number(c[3]) / 255 : 1
        return [Number(c[0]) || 0, Number(c[1]) || 0, Number(c[2]) || 0, Math.max(0, Math.min(1, a))]
    }
    if (typeof c === 'object' && 'r' in c) {
        const a = c.a === undefined || c.a === null ? 1 : Number(c.a)
        return [Number(c.r) || 0, Number(c.g) || 0, Number(c.b) || 0, Math.max(0, Math.min(1, a))]
    }
    return null
}

/** Esri dash patterns, in multiples of the line width (the SDK scales them
 *  the same way). Unknown style: undefined (unsupported). */
const DASH_UNITS: Record<string, number[] | null> = {
    solid: null,
    dash: [4, 3],
    dot: [1, 3],
    'dash-dot': [4, 3, 1, 3],
    'long-dash': [8, 3],
    'long-dash-dot': [8, 3, 1, 3],
    'long-dash-dot-dot': [8, 3, 1, 3, 1, 3],
    'short-dash': [4, 1],
    'short-dash-dot': [4, 1, 1, 1],
    'short-dash-dot-dot': [4, 1, 1, 1, 1, 1],
    'short-dot': [1, 1]
}

/** Dash lengths in points for a line style and width; null = solid;
 *  undefined = style not supported. Pure/exported. */
export function lineDash (style: string | undefined, widthPt: number): number[] | null | undefined {
    // SDK names ('short-dash') and REST names ('esriSLSShortDash') both
    // reduce to the same hyphen-free key
    const key = String(style || 'solid').toLowerCase().replace(/^esrisls/, '').replace(/-/g, '')
    const table: Record<string, number[] | null> = { dashdotdot: [4, 3, 1, 3, 1, 3] }
    for (const k of Object.keys(DASH_UNITS)) table[k.replace(/-/g, '')] = DASH_UNITS[k]
    if (!(key in table)) return undefined
    const u = table[key]
    if (!u) return null
    const w = Math.max(0.5, Number(widthPt) || 1)
    return u.map(v => v * w)
}

function symType (sym: any): string {
    return String((sym && sym.type) || '').toLowerCase()
}

/** Map an SDK (or REST JSON) symbol to a drawable spec, or null when this
 *  symbol cannot be reproduced exactly. Pure/exported. */
export function mapSymbol (sym: any): VSymbol | null {
    if (!sym) return null
    const t = symType(sym)
    const line = (ls: any): VStroke | null | undefined => {
        if (!ls) return null
        const st = String(ls.style || 'solid')
        if (/^(none|null|esrislsnull)$/i.test(st)) return null
        const w = Number(ls.width)
        const widthPt = isFinite(w) && w >= 0 ? w : 0.75
        if (widthPt <= 0) return null
        const dash = lineDash(st, widthPt)
        if (dash === undefined) return undefined
        const color = colorOf(ls.color)
        if (!color) return null
        return { color, widthPt, dash }
    }
    if (t === 'simple-fill' || t === 'esrisfs') {
        const style = String(sym.style || 'solid').toLowerCase().replace(/^esrisfs/, '')
        let fill: RGBA | null = null
        let hatch: VSymbol['hatch']
        const hatchKey = style.replace(/-/g, '')
        const HATCH: Record<string, HatchStyle> = {
            horizontal: 'horizontal', vertical: 'vertical', forwarddiagonal: 'forward-diagonal',
            backwarddiagonal: 'backward-diagonal', cross: 'cross', diagonalcross: 'diagonal-cross'
        }
        if (style === 'solid') fill = colorOf(sym.color)
        else if (HATCH[hatchKey]) {
            const hc = colorOf(sym.color)
            if (hc) hatch = { style: HATCH[hatchKey], color: hc }
        } else if (style !== 'none' && style !== 'null') return null
        const stroke = line(sym.outline)
        if (stroke === undefined) return null
        if (!fill && !stroke && !hatch) return { kind: 'fill', fill: null, stroke: null }
        return hatch ? { kind: 'fill', fill, stroke, hatch } : { kind: 'fill', fill, stroke }
    }
    if (t === 'simple-line' || t === 'esrisls') {
        const stroke = line(sym)
        if (stroke === undefined) return null
        return { kind: 'line', fill: null, stroke }
    }
    if (t === 'simple-marker' || t === 'esrisms') {
        const style = String(sym.style || 'circle').toLowerCase().replace(/^esrisms/, '')
        let path: Array<Array<[number, number]>> | undefined
        if (style === 'path') {
            const parsed = parseSvgPath(String(sym.path || ''))
            if (!parsed) return null
            path = normalizeMarkerPath(parsed)
            if (!path) return null
        } else if (['circle', 'square', 'diamond', 'triangle', 'cross', 'x'].indexOf(style) < 0) return null
        const size = Number(sym.size)
        const stroke = line(sym.outline)
        if (stroke === undefined) return null
        return {
            kind: 'marker',
            fill: colorOf(sym.color),
            stroke,
            marker: {
                style: (style === 'path' ? 'path' : style) as any,
                sizePt: isFinite(size) && size > 0 ? size : 12,
                angle: Number(sym.angle) || 0,
                xoffPt: Number(sym.xoffset) || 0,
                yoffPt: Number(sym.yoffset) || 0,
                ...(path ? { path } : {})
            }
        }
    }
    if (t === 'picture-marker' || t === 'esripms') {
        // REST JSON carries the image inline; the SDK object carries a url
        const url = sym.url && String(sym.url).startsWith('data:')
            ? String(sym.url)
            : (sym.imageData ? 'data:' + String(sym.contentType || 'image/png') + ';base64,' + String(sym.imageData) : String(sym.url || ''))
        if (!url) return null
        if (Number(sym.angle) || 0) return null // rotated pictures: stay raster
        const w = Number(sym.width), h = Number(sym.height)
        const wPt = isFinite(w) && w > 0 ? w : 12
        const hPt = isFinite(h) && h > 0 ? h : wPt
        return {
            kind: 'marker',
            fill: null,
            stroke: null,
            marker: {
                style: 'picture',
                sizePt: Math.max(wPt, hPt),
                angle: Number(sym.angle) || 0,
                xoffPt: Number(sym.xoffset) || 0,
                yoffPt: Number(sym.yoffset) || 0,
                pic: { url, wPt, hPt }
            }
        }
    }
    return null
}

/* ---- SVG path markers ---- */

/** Parse an SVG path (M L H V C S Q T Z, absolute and relative) into
 *  polylines, flattening curves into short segments. Arcs (A) and anything
 *  unparseable return null (the layer then stays raster). Pure/exported. */
export function parseSvgPath (d: string): Array<Array<[number, number]>> | null {
    if (!d || !/^[\s,MmLlHhVvCcSsQqTtZz0-9.eE+-]+$/.test(d)) return null
    const toks = d.match(/[MmLlHhVvCcSsQqTtZz]|[-+]?(?:\d+\.?\d*|\.\d+)(?:[eE][-+]?\d+)?/g)
    if (!toks || !/^[Mm]$/.test(toks[0])) return null
    const out: Array<Array<[number, number]>> = []
    let cur: Array<[number, number]> = []
    let x = 0, y = 0, sx = 0, sy = 0
    let cx2 = 0, cy2 = 0, lastCmd = ''
    let i = 0
    let cmd = ''
    const num = (): number => {
        const v = Number(toks[i++])
        if (!isFinite(v)) throw new Error('path')
        return v
    }
    const isNum = (): boolean => i < toks.length && !/^[A-Za-z]$/.test(toks[i])
    const cubic = (x1: number, y1: number, x2: number, y2: number, ex: number, ey: number): void => {
        for (let k = 1; k <= 8; k++) {
            const t = k / 8, u = 1 - t
            cur.push([u * u * u * x + 3 * u * u * t * x1 + 3 * u * t * t * x2 + t * t * t * ex,
                u * u * u * y + 3 * u * u * t * y1 + 3 * u * t * t * y2 + t * t * t * ey])
        }
        cx2 = x2; cy2 = y2; x = ex; y = ey
    }
    const quad = (x1: number, y1: number, ex: number, ey: number): void => {
        for (let k = 1; k <= 8; k++) {
            const t = k / 8, u = 1 - t
            cur.push([u * u * x + 2 * u * t * x1 + t * t * ex, u * u * y + 2 * u * t * y1 + t * t * ey])
        }
        cx2 = x1; cy2 = y1; x = ex; y = ey
    }
    try {
        while (i < toks.length) {
            if (/^[A-Za-z]$/.test(toks[i])) cmd = toks[i++]
            else if (!cmd) return null
            const rel = cmd === cmd.toLowerCase()
            const C = cmd.toUpperCase()
            if (C === 'Z') {
                if (cur.length) { cur.push([sx, sy]); out.push(cur); cur = [] }
                x = sx; y = sy; lastCmd = 'Z'
                continue
            }
            if (!isNum()) return null
            if (C === 'M') {
                if (cur.length > 1) out.push(cur)
                const nx = num() + (rel ? x : 0), ny = num() + (rel ? y : 0)
                x = sx = nx; y = sy = ny
                cur = [[x, y]]
                cmd = rel ? 'l' : 'L' // extra pairs are line-tos
            } else if (C === 'L') {
                x = num() + (rel ? x : 0); y = num() + (rel ? y : 0); cur.push([x, y])
            } else if (C === 'H') {
                x = num() + (rel ? x : 0); cur.push([x, y])
            } else if (C === 'V') {
                y = num() + (rel ? y : 0); cur.push([x, y])
            } else if (C === 'C') {
                const ox = rel ? x : 0, oy = rel ? y : 0
                const a1 = num() + ox, b1 = num() + oy, a2 = num() + ox, b2 = num() + oy, e1 = num() + ox, e2 = num() + oy
                cubic(a1, b1, a2, b2, e1, e2)
            } else if (C === 'S') {
                const ox = rel ? x : 0, oy = rel ? y : 0
                const r1 = /[CS]/.test(lastCmd) ? 2 * x - cx2 : x, r2 = /[CS]/.test(lastCmd) ? 2 * y - cy2 : y
                const a2 = num() + ox, b2 = num() + oy, e1 = num() + ox, e2 = num() + oy
                cubic(r1, r2, a2, b2, e1, e2)
            } else if (C === 'Q') {
                const ox = rel ? x : 0, oy = rel ? y : 0
                const a1 = num() + ox, b1 = num() + oy, e1 = num() + ox, e2 = num() + oy
                quad(a1, b1, e1, e2)
            } else if (C === 'T') {
                const ox = rel ? x : 0, oy = rel ? y : 0
                const r1 = /[QT]/.test(lastCmd) ? 2 * x - cx2 : x, r2 = /[QT]/.test(lastCmd) ? 2 * y - cy2 : y
                const e1 = num() + ox, e2 = num() + oy
                quad(r1, r2, e1, e2)
            } else return null
            lastCmd = C
        }
    } catch (e) { return null }
    if (cur.length > 1) out.push(cur)
    return out.length ? out : null
}

/** Scale a parsed path so its largest side is 1, centred on 0,0 (the SDK
 *  fits a path marker's bounding box to its size). Pure/exported. */
export function normalizeMarkerPath (subs: Array<Array<[number, number]>>): Array<Array<[number, number]>> | null {
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity
    for (const sp of subs) for (const p of sp) { x0 = Math.min(x0, p[0]); y0 = Math.min(y0, p[1]); x1 = Math.max(x1, p[0]); y1 = Math.max(y1, p[1]) }
    const span = Math.max(x1 - x0, y1 - y0)
    if (!(span > 0) || !isFinite(span)) return null
    const cx = (x0 + x1) / 2, cy = (y0 + y1) / 2
    return subs.map(sp => sp.map(p => [(p[0] - cx) / span, (p[1] - cy) / span] as [number, number]))
}

/* ---- label class where clauses (SQL subset, evaluated client-side) ---- */

/** Compile a label class where clause into a predicate over attributes.
 *  Supports comparisons (= <> != < <= > >=), IS [NOT] NULL, [NOT] IN (...),
 *  [NOT] LIKE with % and _, BETWEEN, AND / OR / NOT and parentheses, with
 *  numeric and quoted string literals and case-insensitive field names.
 *  Anything else returns null (the layer stays raster). Pure/exported. */
export function compileWhere (where: string): { test: (attrs: any) => boolean, fields: string[] } | null {
    const src = String(where || '').trim()
    if (!src) return { test: () => true, fields: [] }
    const re = /\s*(?:('(?:[^']|'')*')|(\d+\.\d*|\.\d+|\d+)|(<>|!=|<=|>=|=|<|>|\(|\)|,)|("[^"]+"|\[[^\]]+\]|[A-Za-z_][\w.]*))/y
    const toks: Array<{ t: 'str' | 'num' | 'op' | 'id', v: string }> = []
    let pos = 0
    while (pos < src.length) {
        re.lastIndex = pos
        const m = re.exec(src)
        if (!m) { if (/^\s*$/.test(src.slice(pos))) break; return null }
        pos = re.lastIndex
        if (m[1] !== undefined) toks.push({ t: 'str', v: m[1].slice(1, -1).replace(/''/g, "'") })
        else if (m[2] !== undefined) toks.push({ t: 'num', v: m[2] })
        else if (m[3] !== undefined) toks.push({ t: 'op', v: m[3] })
        else if (m[4] !== undefined) toks.push({ t: 'id', v: m[4].replace(/^["[]|["\]]$/g, '') })
    }
    let k = 0
    const fields: string[] = []
    const peekKw = (w: string): boolean => !!toks[k] && toks[k].t === 'id' && toks[k].v.toUpperCase() === w
    const val = (attrs: any, f: string): any => {
        if (!attrs) return null
        if (f in attrs) return attrs[f]
        const key = Object.keys(attrs).find(x => x.toLowerCase() === f.toLowerCase())
        return key ? attrs[key] : null
    }
    type Ex = (a: any) => any
    const operand = (): Ex => {
        const tk = toks[k++]
        if (!tk) throw new Error('eof')
        if (tk.t === 'str') { const v = tk.v; return () => v }
        if (tk.t === 'num') { const v = Number(tk.v); return () => v }
        if (tk.t === 'op' && tk.v === '-' ) throw new Error('neg')
        if (tk.t === 'id') {
            const up = tk.v.toUpperCase()
            if (up === 'NULL') return () => null
            if (['AND', 'OR', 'NOT', 'IS', 'IN', 'LIKE', 'BETWEEN'].indexOf(up) >= 0) throw new Error('kw')
            if (fields.indexOf(tk.v) < 0) fields.push(tk.v)
            const f = tk.v
            return (a: any) => val(a, f)
        }
        throw new Error('operand')
    }
    const cmp = (x: any, y: any): number | null => {
        if (x === null || x === undefined || y === null || y === undefined) return null
        const nx = Number(x), ny = Number(y)
        if (typeof x === 'number' || typeof y === 'number') {
            if (!isFinite(nx) || !isFinite(ny)) return null
            return nx < ny ? -1 : nx > ny ? 1 : 0
        }
        const sx = String(x), sy = String(y)
        return sx < sy ? -1 : sx > sy ? 1 : 0
    }
    const likeRe = (pat: string): RegExp => new RegExp('^' + pat.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/%/g, '.*').replace(/_/g, '.') + '$', 'i')
    const predicate = (): (a: any) => boolean => {
        if (peekKw('NOT')) { k++; const p = predicate(); return (a: any) => !p(a) }
        if (toks[k] && toks[k].t === 'op' && toks[k].v === '(') {
            k++
            const e = orExpr()
            if (!toks[k] || toks[k].v !== ')') throw new Error(')')
            k++
            return e
        }
        const left = operand()
        if (peekKw('IS')) {
            k++
            const neg = peekKw('NOT'); if (neg) k++
            if (!peekKw('NULL')) throw new Error('null'); k++
            return (a: any) => { const v = left(a); const isNull = v === null || v === undefined; return neg ? !isNull : isNull }
        }
        let neg = false
        if (peekKw('NOT')) { neg = true; k++ }
        if (peekKw('IN')) {
            k++
            if (!toks[k] || toks[k].v !== '(') throw new Error('(')
            k++
            const items: Ex[] = []
            while (toks[k] && toks[k].v !== ')') { items.push(operand()); if (toks[k] && toks[k].v === ',') k++ }
            if (!toks[k]) throw new Error(')'); k++
            return (a: any) => { const v = left(a); const hit = items.some(it => cmp(v, it(a)) === 0); return neg ? !hit : hit }
        }
        if (peekKw('LIKE')) {
            k++
            const pat = toks[k++]
            if (!pat || pat.t !== 'str') throw new Error('like')
            const rx = likeRe(pat.v)
            return (a: any) => { const v = left(a); const hit = v !== null && v !== undefined && rx.test(String(v)); return neg ? !hit : hit }
        }
        if (peekKw('BETWEEN')) {
            k++
            const lo = operand()
            if (!peekKw('AND')) throw new Error('between'); k++
            const hi = operand()
            return (a: any) => { const v = left(a); const c1 = cmp(v, lo(a)), c2 = cmp(v, hi(a)); const hit = c1 !== null && c2 !== null && c1 >= 0 && c2 <= 0; return neg ? !hit : hit }
        }
        if (neg) throw new Error('not')
        const op = toks[k++]
        if (!op || op.t !== 'op' || ['=', '<>', '!=', '<', '<=', '>', '>='].indexOf(op.v) < 0) throw new Error('op')
        const right = operand()
        return (a: any) => {
            const c = cmp(left(a), right(a))
            if (c === null) return false
            switch (op.v) {
                case '=': return c === 0
                case '<>': case '!=': return c !== 0
                case '<': return c < 0
                case '<=': return c <= 0
                case '>': return c > 0
                default: return c >= 0
            }
        }
    }
    const andExpr = (): (a: any) => boolean => {
        let l = predicate()
        while (peekKw('AND')) { k++; const r = predicate(); const ll = l; l = (a: any) => ll(a) && r(a) }
        return l
    }
    const orExpr = (): (a: any) => boolean => {
        let l = andExpr()
        while (peekKw('OR')) { k++; const r = andExpr(); const ll = l; l = (a: any) => ll(a) || r(a) }
        return l
    }
    try {
        const test = orExpr()
        if (k !== toks.length) return null
        return { test, fields }
    } catch (e) { return null }
}

/* ------------------------------------------------------------------ */
/* renderers                                                            */
/* ------------------------------------------------------------------ */

export interface ResolvedRenderer {
    /** Symbol for a feature's attributes; null = the SDK draws nothing. */
    symbolFor: (attrs: any) => VSymbol | null
    /** Attribute fields the renderer reads (for outFields). */
    fields: string[]
}

/** Resolve a renderer into a per-feature symbol function, or a reason it
 *  cannot be reproduced. Pure/exported. */
export function resolveRenderer (renderer: any): ResolvedRenderer | { reason: string } {
    if (!renderer) return { reason: 'no renderer' }
    const t = String(renderer.type || '').toLowerCase()
    const vv: any[] = renderer.visualVariables || []
    if (vv && vv.length) return { reason: 'visual variables' }
    if (renderer.valueExpression) return { reason: 'Arcade renderer' }
    if (t === 'simple') {
        const s = mapSymbol(renderer.symbol)
        if (!s) return { reason: 'unsupported symbol' }
        return { symbolFor: () => s, fields: [] }
    }
    if (t === 'unique-value' || t === 'uniquevalue') {
        const fields = [renderer.field, renderer.field2, renderer.field3].filter((f: any) => !!f).map(String)
        if (!fields.length) return { reason: 'no renderer field' }
        const delim = String(renderer.fieldDelimiter === undefined || renderer.fieldDelimiter === null ? ',' : renderer.fieldDelimiter)
        const map = new Map<string, VSymbol | null>()
        const infos: any[] = renderer.uniqueValueInfos ? (renderer.uniqueValueInfos.toArray ? renderer.uniqueValueInfos.toArray() : renderer.uniqueValueInfos) : []
        for (const info of infos) {
            if (!info) continue
            const s = info.symbol ? mapSymbol(info.symbol) : null
            if (info.symbol && !s) return { reason: 'unsupported symbol' }
            map.set(String(info.value), s)
        }
        let def: VSymbol | null = null
        if (renderer.defaultSymbol) {
            def = mapSymbol(renderer.defaultSymbol)
            if (!def) return { reason: 'unsupported symbol' }
        }
        const keyOf = (attrs: any): string => fields.map(f => {
            const v = attrs ? attrs[f] : undefined
            return v === null || v === undefined ? '<Null>' : String(v)
        }).join(delim)
        return {
            symbolFor: (attrs: any) => {
                const k = keyOf(attrs)
                if (map.has(k)) return map.get(k) || null
                return def
            },
            fields
        }
    }
    if (t === 'class-breaks' || t === 'classbreaks') {
        if (!renderer.field) return { reason: 'no renderer field' }
        if (renderer.normalizationType && renderer.normalizationType !== 'esriNormalizeByNone') return { reason: 'normalized class breaks' }
        const infos: any[] = renderer.classBreakInfos ? (renderer.classBreakInfos.toArray ? renderer.classBreakInfos.toArray() : renderer.classBreakInfos) : []
        const breaks: Array<{ min: number, max: number, sym: VSymbol | null }> = []
        for (const info of infos) {
            const s = info && info.symbol ? mapSymbol(info.symbol) : null
            if (info && info.symbol && !s) return { reason: 'unsupported symbol' }
            const mn = info && (info.minValue ?? info.classMinValue)
            const mx = info && (info.maxValue ?? info.classMaxValue)
            breaks.push({ min: mn === null || mn === undefined ? -Infinity : Number(mn), max: Number(mx), sym: s })
        }
        let def: VSymbol | null = null
        if (renderer.defaultSymbol) {
            def = mapSymbol(renderer.defaultSymbol)
            if (!def) return { reason: 'unsupported symbol' }
        }
        const field = String(renderer.field)
        return {
            symbolFor: (attrs: any) => {
                const raw = attrs ? attrs[field] : null
                if (raw === null || raw === undefined || raw === '') return def
                const v = Number(raw)
                if (!isFinite(v)) return def
                // SDK rule: min <= v <= max, first matching break wins
                for (const b of breaks) if (v >= b.min && v <= b.max) return b.sym
                return def
            },
            fields: [field]
        }
    }
    return { reason: t ? t + ' renderer' : 'unknown renderer' }
}

/* ------------------------------------------------------------------ */
/* eligibility                                                          */
/* ------------------------------------------------------------------ */

const VECTOR_LAYER_TYPES = new Set(['feature', 'geojson', 'csv', 'wfs', 'ogc-feature'])

/** Scale-range rule (same as the SDK): visible when minScale is 0 or
 *  scale <= minScale, and maxScale is 0 or scale >= maxScale. */
function inScale (l: any, scale: number): boolean {
    const mn = Number(l && l.minScale) || 0
    const mx = Number(l && l.maxScale) || 0
    if (!(scale > 0)) return true
    if (mn > 0 && scale > mn) return false
    if (mx > 0 && scale < mx) return false
    return true
}

/** Visible including every parent group layer. */
function effectivelyVisible (l: any): boolean {
    let cur = l
    let guard = 0
    while (cur && guard++ < 20) {
        if (cur.visible === false) return false
        const p = cur.parent
        cur = p && p.type === 'group' ? p : null
    }
    return true
}

export type Eligibility =
    | { ok: true, resolved: ResolvedRenderer, labels: ResolvedLabels }
    | { ok: false, reason: string, skip?: boolean }

/** Decide whether a layer can be drawn as vectors at a printed scale.
 *  `skip` = the layer would not draw at all (hidden or out of scale), so it
 *  is neither vectorized nor reported. Pure/exported. */
export function vectorEligibility (layer: any, scale: number, viewHasTime: boolean): Eligibility {
    if (!layer) return { ok: false, reason: 'no layer', skip: true }
    if (!VECTOR_LAYER_TYPES.has(String(layer.type))) return { ok: false, reason: 'layer type', skip: true }
    if (!effectivelyVisible(layer) || !inScale(layer, scale)) return { ok: false, reason: 'not drawn', skip: true }
    if (typeof layer.queryFeatures !== 'function') return { ok: false, reason: 'not queryable' }
    const gt = String(layer.geometryType || '')
    if (['point', 'multipoint', 'polyline', 'polygon'].indexOf(gt) < 0) return { ok: false, reason: gt ? gt + ' geometry' : 'geometry type' }
    if (layer.featureReduction) return { ok: false, reason: 'clustering' }
    if (layer.effect || layer.featureEffect) return { ok: false, reason: 'effects' }
    if (layer.blendMode && layer.blendMode !== 'normal') return { ok: false, reason: 'blend mode' }
    if (viewHasTime && layer.timeInfo && layer.useViewTime !== false) return { ok: false, reason: 'time filter' }
    const r = resolveRenderer(layer.renderer)
    if ('reason' in r) return { ok: false, reason: r.reason }
    const lb = resolveLabels(layer, scale)
    if ('reason' in lb) return { ok: false, reason: lb.reason }
    return { ok: true, resolved: r, labels: lb }
}

/* ------------------------------------------------------------------ */
/* labels                                                               */
/* ------------------------------------------------------------------ */

/** A label expression reduced to a function of the attributes. Supports
 *  what map authors overwhelmingly use: $feature.NAME, $feature["NAME"],
 *  string literals and + concatenation (optionally `return ...;`), plus
 *  the legacy "[NAME]" labelExpression form. Anything else (functions,
 *  conditionals, variables) returns null: that layer stays raster.
 *  Pure/exported. */
export function parseLabelExpression (info: any): { fn: (attrs: any) => string, fields: string[] } | null {
    if (!info) return null
    const arcade = info.labelExpressionInfo && info.labelExpressionInfo.expression
    const val = (attrs: any, f: string): string => {
        if (!attrs) return ''
        let v = attrs[f]
        if (v === undefined) {
            const k = Object.keys(attrs).find(x => x.toLowerCase() === f.toLowerCase())
            v = k ? attrs[k] : undefined
        }
        return v === null || v === undefined ? '' : String(v)
    }
    if (typeof arcade === 'string' && arcade.trim()) {
        let src = arcade.trim().replace(/;\s*$/, '')
        src = src.replace(/^return\s+/, '')
        // split on + outside quotes
        const parts: string[] = []
        let cur = '', q = ''
        for (const ch of src) {
            if (q) { cur += ch; if (ch === q) q = ''; continue }
            if (ch === '"' || ch === "'") { q = ch; cur += ch; continue }
            if (ch === '+') { parts.push(cur.trim()); cur = ''; continue }
            cur += ch
        }
        if (q) return null
        parts.push(cur.trim())
        const pieces: Array<{ lit?: string, field?: string }> = []
        for (const p of parts) {
            let m: RegExpExecArray | null
            if ((m = /^\$feature\.([A-Za-z_][\w]*)$/.exec(p))) pieces.push({ field: m[1] })
            else if ((m = /^\$feature\[\s*(["'])([^"']+)\1\s*\]$/.exec(p))) pieces.push({ field: m[2] })
            else if ((m = /^(["'])((?:(?!\1).)*)\1$/.exec(p))) pieces.push({ lit: m[2] })
            else if (p === 'TextFormatting.NewLine') pieces.push({ lit: ' ' })
            else return null
        }
        if (!pieces.some(x => x.field)) return null
        const fields = pieces.filter(x => x.field).map(x => String(x.field))
        return { fn: (attrs: any) => pieces.map(x => x.field ? val(attrs, x.field) : x.lit).join('').trim(), fields }
    }
    const legacy = info.labelExpression
    if (typeof legacy === 'string' && /\[[^\]]+\]/.test(legacy)) {
        const fields: string[] = []
        const re = /\[([^\]]+)\]/g
        let m: RegExpExecArray | null
        while ((m = re.exec(legacy)) !== null) fields.push(m[1].trim())
        return { fn: (attrs: any) => legacy.replace(/\[([^\]]+)\]/g, (_x, f: string) => val(attrs, f.trim())).trim(), fields }
    }
    return null
}

export interface ResolvedLabels {
    specs: LabelSpec[]
    exprs: Array<(attrs: any) => string>
    /** Per class: where-clause predicate, or null for every feature. */
    wheres: Array<((attrs: any) => boolean) | null>
    fields: string[]
}

/** Label classes that draw at the printed scale, or a reason the layer's
 *  labels cannot be reproduced (it then stays raster). Pure/exported. */
export function resolveLabels (layer: any, scale: number): ResolvedLabels | { reason: string } {
    const out: ResolvedLabels = { specs: [], exprs: [], wheres: [], fields: [] }
    const li: any[] = (layer && layer.labelingInfo) ? (layer.labelingInfo.toArray ? layer.labelingInfo.toArray() : layer.labelingInfo) : []
    if (!layer || layer.labelsVisible === false || !li || !li.length) return out
    for (const lc of li) {
        if (!lc) continue
        if (!inScale(lc, scale)) continue
        let wtest: ((a: any) => boolean) | null = null
        if (lc.where) {
            const cw = compileWhere(String(lc.where))
            if (!cw) return { reason: 'label filter' }
            wtest = cw.test
            for (const f of cw.fields) if (out.fields.indexOf(f) < 0) out.fields.push(f)
        }
        const ex = parseLabelExpression(lc)
        if (!ex) return { reason: 'Arcade label expression' }
        const sym: any = lc.symbol
        const st = symType(sym)
        if (sym && st !== 'text' && st !== 'esrits') return { reason: 'label symbol' }
        const font: any = (sym && sym.font) || {}
        const w = String(font.weight || '').toLowerCase()
        const it = String(font.style || '').toLowerCase()
        const size = Number(font.size)
        const halo = Number(sym && sym.haloSize)
        out.specs.push({
            color: colorOf(sym && sym.color) || [0, 0, 0, 1],
            haloColor: halo > 0 ? colorOf(sym && sym.haloColor) : null,
            haloPt: halo > 0 ? halo : 0,
            sizePt: isFinite(size) && size > 0 ? size : 9,
            weight: w === 'bold' || w === 'bolder' ? 'bold' : (it === 'italic' ? 'italic' : 'normal'),
            placement: String(lc.labelPlacement || '').toLowerCase(),
            xoffPt: Number(sym && sym.xoffset) || 0,
            yoffPt: Number(sym && sym.yoffset) || 0
        })
        out.exprs.push(ex.fn)
        out.wheres.push(wtest)
        for (const f of ex.fields) if (out.fields.indexOf(f) < 0) out.fields.push(f)
    }
    return out
}

/* ------------------------------------------------------------------ */
/* querying                                                             */
/* ------------------------------------------------------------------ */

/** Flatten an SDK / JSON geometry into drawable parts. */
export function flattenGeometry (g: any): VGeom[] {
    if (!g) return []
    const t = String(g.type || (g.rings ? 'polygon' : g.paths ? 'polyline' : g.points ? 'multipoint' : ('x' in g ? 'point' : '')))
    if (t === 'polygon' && g.rings) return [{ kind: 'polygon', rings: g.rings }]
    if (t === 'polyline' && g.paths) return [{ kind: 'polyline', paths: g.paths }]
    if (t === 'point' && isFinite(g.x) && isFinite(g.y)) return [{ kind: 'point', x: Number(g.x), y: Number(g.y) }]
    if (t === 'multipoint' && g.points) {
        return (g.points as number[][]).filter(p => isFinite(p[0]) && isFinite(p[1])).map(p => ({ kind: 'point', x: p[0], y: p[1] }) as VGeom)
    }
    return []
}

/** Query one layer's features for the print. Returns the drawable features,
 *  or a reason to fall back to raster (too many features, transfer limit,
 *  query failure, timeout). */
export async function queryVectorFeatures (
    layer: any,
    resolved: ResolvedRenderer,
    labels: ResolvedLabels | null,
    extent: any,
    outSpatialReference: any,
    maxAllowableOffset: number,
    limit: number,
    timeoutMs = 20000
): Promise<VectorFeature[] | { reason: string }> {
    let timer: any = null
    try {
        const q: any = typeof layer.createQuery === 'function' ? layer.createQuery() : { where: layer.definitionExpression || '1=1' }
        if (!q.where) q.where = '1=1'
        q.geometry = extent
        q.spatialRelationship = 'intersects'
        q.returnGeometry = true
        q.outSpatialReference = outSpatialReference
        const oid = layer.objectIdField ? [String(layer.objectIdField)] : []
        const want = resolved.fields.slice()
        for (const f of (labels ? labels.fields : [])) if (want.indexOf(f) < 0) want.push(f)
        q.outFields = want.length ? want : (oid.length ? oid : ['*'])
        if (maxAllowableOffset > 0 && String(layer.geometryType) !== 'point' && String(layer.geometryType) !== 'multipoint') {
            q.maxAllowableOffset = maxAllowableOffset
        }
        q.num = limit + 1
        const TIMED_OUT = {}
        const res: any = await Promise.race([
            layer.queryFeatures(q),
            new Promise(resolve => { timer = setTimeout(() => resolve(TIMED_OUT), timeoutMs) })
        ])
        if (res === TIMED_OUT) return { reason: 'query timed out' }
        const feats: any[] = (res && res.features) || []
        if (feats.length > limit) return { reason: 'more than ' + limit + ' features' }
        if (res && res.exceededTransferLimit) return { reason: 'service transfer limit' }
        const out: VectorFeature[] = []
        for (const f of feats) {
            const sym = resolved.symbolFor(f && f.attributes)
            if (!sym) continue
            // first label class with text wins (classes without a where
            // clause all apply; one label per feature keeps prints clean)
            let label: VectorFeature['label']
            if (labels && labels.specs.length) {
                for (let k = 0; k < labels.exprs.length; k++) {
                    const w = labels.wheres && labels.wheres[k]
                    if (w && !w(f && f.attributes)) continue
                    const t = labels.exprs[k](f && f.attributes)
                    if (t) { label = { text: t, spec: k }; break }
                }
            }
            const parts = flattenGeometry(f && f.geometry)
            parts.forEach((geom, gi) => out.push(gi === 0 && label ? { geom, sym, label } : { geom, sym }))
        }
        return out
    } catch (e: any) {
        return { reason: 'query failed' }
    } finally {
        if (timer) clearTimeout(timer)
    }
}

/* ------------------------------------------------------------------ */
/* drawing                                                              */
/* ------------------------------------------------------------------ */

const PT_PER_IN = 72

/** Ground-to-page transform for a capture in a map frame. Uses the
 *  capture's pixel affine (so ROTATED maps work) and falls back to the
 *  north-up extent. Returns null when neither is available. Pure/exported. */
export function pageTransform (
    cap: { groundExtent?: { xmin: number, ymin: number, xmax: number, ymax: number }, affine?: { a: number, b: number, c: number, d: number, e: number, f: number }, widthPx?: number, heightPx?: number },
    mf: { xIn: number, yIn: number, wIn: number, hIn: number }
): ((x: number, y: number) => [number, number]) | null {
    const ox = mf.xIn * PT_PER_IN, oy = mf.yIn * PT_PER_IN
    const fw = mf.wIn * PT_PER_IN, fh = mf.hIn * PT_PER_IN
    const A = cap.affine
    const W = Number(cap.widthPx) || 0, H = Number(cap.heightPx) || 0
    if (A && W > 0 && H > 0) {
        const det = A.a * A.e - A.b * A.d
        if (Math.abs(det) > 1e-300) {
            return (x: number, y: number): [number, number] => {
                const dx = x - A.c, dy = y - A.f
                const col = (A.e * dx - A.b * dy) / det
                const row = (-A.d * dx + A.a * dy) / det
                return [ox + col / W * fw, oy + row / H * fh]
            }
        }
    }
    const ext = cap.groundExtent
    if (ext && ext.xmax > ext.xmin && ext.ymax > ext.ymin) {
        const sx = fw / (ext.xmax - ext.xmin), sy = fh / (ext.ymax - ext.ymin)
        return (x: number, y: number): [number, number] => [ox + (x - ext.xmin) * sx, oy + (ext.ymax - y) * sy]
    }
    return null
}

/** Marker outline in page points around (cx, cy): SDK sizes are points,
 *  angles clockwise, offsets x-right / y-up. Returns closed rings for area
 *  markers and open segments for cross / x. Pure/exported. */
export function markerShape (
    style: MarkerStyle, cx: number, cy: number, sizePt: number, angleDeg: number
): { rings: Array<Array<[number, number]>>, open: boolean } {
    const r = sizePt / 2
    let pts: Array<Array<[number, number]>>
    let open = false
    switch (style) {
        case 'square': pts = [[[-r, -r], [r, -r], [r, r], [-r, r]]]; break
        case 'diamond': pts = [[[0, -r], [r, 0], [0, r], [-r, 0]]]; break
        case 'triangle': pts = [[[0, -r], [r, r * 0.732], [-r, r * 0.732]]]; break
        case 'cross': pts = [[[0, -r], [0, r]], [[-r, 0], [r, 0]]]; open = true; break
        case 'x': {
            const d = r * 0.7071
            pts = [[[-d, -d], [d, d]], [[-d, d], [d, -d]]]; open = true; break
        }
        default: { // circle as a 24-gon (exact enough at print sizes, one path type)
            const ring: Array<[number, number]> = []
            for (let i = 0; i < 24; i++) { const a = i / 24 * Math.PI * 2; ring.push([Math.cos(a) * r, Math.sin(a) * r]) }
            pts = [ring]
        }
    }
    const t = (Number(angleDeg) || 0) * Math.PI / 180
    const cs = Math.cos(t), sn = Math.sin(t)
    // page y grows DOWN, so a clockwise screen rotation is the standard
    // rotation matrix applied in page space
    return {
        rings: pts.map(ring => ring.map(([x, y]) => [cx + x * cs - y * sn, cy + x * sn + y * cs] as [number, number])),
        open
    }
}

/** Hatch line segments (page points) covering a box, screen-aligned like
 *  the SDK draws them. Spacing in points. Pure/exported. */
export function hatchSegments (
    style: HatchStyle, box: { x0: number, y0: number, x1: number, y1: number }, spacing = 6
): Array<[number, number, number, number]> {
    const segs: Array<[number, number, number, number]> = []
    const w = box.x1 - box.x0, h = box.y1 - box.y0
    if (!(w > 0) || !(h > 0) || !(spacing > 0)) return segs
    const horiz = (): void => { for (let y = Math.ceil(box.y0 / spacing) * spacing; y <= box.y1; y += spacing) segs.push([box.x0, y, box.x1, y]) }
    const vert = (): void => { for (let x = Math.ceil(box.x0 / spacing) * spacing; x <= box.x1; x += spacing) segs.push([x, box.y0, x, box.y1]) }
    // diagonals on a page-anchored lattice so neighbours line up
    const step = spacing * Math.SQRT2
    const fwd = (): void => { // "/" : x + y = k
        for (let k = Math.floor((box.x0 + box.y0) / step) * step; k <= box.x1 + box.y1; k += step) segs.push([k - box.y1, box.y1, k - box.y0, box.y0])
    }
    const back = (): void => { // "\" : x - y = k
        for (let k = Math.floor((box.x0 - box.y1) / step) * step; k <= box.x1 - box.y0; k += step) segs.push([k + box.y0, box.y0, k + box.y1, box.y1])
    }
    if (style === 'horizontal') horiz()
    else if (style === 'vertical') vert()
    else if (style === 'forward-diagonal') fwd()
    else if (style === 'backward-diagonal') back()
    else if (style === 'cross') { horiz(); vert() }
    else { fwd(); back() }
    return segs
}

function applyStroke (d: Drawer, s: VStroke): void {
    d.setStroke(s.color[0], s.color[1], s.color[2])
    d.setLineWidth(s.widthPt)
    if (typeof d.setDash === 'function') d.setDash(s.dash)
}

function bboxOf (subs: Array<Array<[number, number]>>): { x0: number, y0: number, x1: number, y1: number } {
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity
    for (const sp of subs) for (const p of sp) {
        if (p[0] < x0) x0 = p[0]; if (p[0] > x1) x1 = p[0]
        if (p[1] < y0) y0 = p[1]; if (p[1] > y1) y1 = p[1]
    }
    return { x0, y0, x1, y1 }
}

function overlaps (a: { x0: number, y0: number, x1: number, y1: number }, b: { x0: number, y0: number, x1: number, y1: number }): boolean {
    return !(a.x1 < b.x0 || a.x0 > b.x1 || a.y1 < b.y0 || a.y0 > b.y1)
}

/** A label candidate in page space: centre, angle (page degrees, y down,
 *  kept upright) and the anchor rule used. */
interface LabelCand { cx: number, cy: number, angle: number }

/** Signed-area centroid of a ring in page space. */
function ringCentroid (r: Array<[number, number]>): { x: number, y: number, area: number } {
    let a = 0, cx = 0, cy = 0
    for (let i = 0, j = r.length - 1; i < r.length; j = i++) {
        const f = r[j][0] * r[i][1] - r[i][0] * r[j][1]
        a += f; cx += (r[j][0] + r[i][0]) * f; cy += (r[j][1] + r[i][1]) * f
    }
    a /= 2
    if (Math.abs(a) < 1e-9) return { x: r[0][0], y: r[0][1], area: 0 }
    return { x: cx / (6 * a), y: cy / (6 * a), area: Math.abs(a) }
}

function pointInRings (x: number, y: number, rings: Array<Array<[number, number]>>): boolean {
    let inside = false
    for (const r of rings) {
        for (let i = 0, j = r.length - 1; i < r.length; j = i++) {
            const xi = r[i][0], yi = r[i][1], xj = r[j][0], yj = r[j][1]
            if (((yi > y) !== (yj > y)) && (x < (xj - xi) * (y - yi) / (yj - yi) + xi)) inside = !inside
        }
    }
    return inside
}

/** Interior label point of a polygon (page space): the centroid of the
 *  largest ring when it falls inside (holes respected), else the middle
 *  of the widest inside span of the horizontal line through the centre.
 *  Pure/exported. */
export function polygonLabelPoint (rings: Array<Array<[number, number]>>): { x: number, y: number } | null {
    if (!rings.length) return null
    let best = rings[0], bestA = -1
    for (const r of rings) { const c = ringCentroid(r); if (c.area > bestA) { bestA = c.area; best = r } }
    const c = ringCentroid(best)
    if (pointInRings(c.x, c.y, rings)) return { x: c.x, y: c.y }
    const bb = bboxOf([best])
    for (const fy of [0.5, 0.35, 0.65, 0.2, 0.8]) {
        const y = bb.y0 + (bb.y1 - bb.y0) * fy
        const xs: number[] = []
        for (const r of rings) for (let i = 0, j = r.length - 1; i < r.length; j = i++) {
            const yi = r[i][1], yj = r[j][1]
            if ((yi > y) !== (yj > y)) xs.push(r[j][0] + (y - yj) * (r[i][0] - r[j][0]) / (yi - yj))
        }
        xs.sort((p, q) => p - q)
        let wBest = 0, mid: number | null = null
        for (let k = 0; k + 1 < xs.length; k += 2) if (xs[k + 1] - xs[k] > wBest) { wBest = xs[k + 1] - xs[k]; mid = (xs[k] + xs[k + 1]) / 2 }
        if (mid !== null) return { x: mid, y }
    }
    return null
}

/** Midpoint (by page length) and upright angle of the longest path.
 *  Pure/exported. */
export function lineLabelPoint (paths: Array<Array<[number, number]>>): LabelCand | null {
    let best: Array<[number, number]> | null = null, bestL = 0
    for (const p of paths) {
        let L = 0
        for (let i = 1; i < p.length; i++) L += Math.hypot(p[i][0] - p[i - 1][0], p[i][1] - p[i - 1][1])
        if (L > bestL) { bestL = L; best = p }
    }
    if (!best || bestL <= 0) return null
    let walk = bestL / 2
    for (let i = 1; i < best.length; i++) {
        const sl = Math.hypot(best[i][0] - best[i - 1][0], best[i][1] - best[i - 1][1])
        if (walk <= sl || i === best.length - 1) {
            const f = sl > 0 ? Math.min(1, walk / sl) : 0
            let ang = Math.atan2(best[i][1] - best[i - 1][1], best[i][0] - best[i - 1][0]) * 180 / Math.PI
            if (ang > 90) ang -= 180
            if (ang <= -90) ang += 180
            return { cx: best[i - 1][0] + (best[i][0] - best[i - 1][0]) * f, cy: best[i - 1][1] + (best[i][1] - best[i - 1][1]) * f, angle: ang }
        }
        walk -= sl
    }
    return null
}

/** Shared placement state for one page: every label placed so far, across
 *  all layers, so labels from different layers never overprint. */
export interface LabelBoard { boxes: Array<{ x0: number, y0: number, x1: number, y1: number }> }

/** Draw one vector layer's geometry over the map frame, clipped to it.
 *  Returns features drawn. Labels are drawn separately (drawVectorLabels)
 *  after every layer's geometry, so they sit on top like the SDK's. */
export function drawVectorLayer (
    d: Drawer,
    cap: Parameters<typeof pageTransform>[0],
    mf: { xIn: number, yIn: number, wIn: number, hIn: number },
    data: VectorLayerData
): number {
    const T = pageTransform(cap, mf)
    if (typeof d.path !== 'function' || !T) return 0
    const ox = mf.xIn * PT_PER_IN
    const oy = mf.yIn * PT_PER_IN
    const op = Math.max(0, Math.min(1, Number(data.opacity) >= 0 ? Number(data.opacity) : 1))
    const box = { x0: ox - 20, y0: oy - 20, x1: ox + mf.wIn * PT_PER_IN + 20, y1: oy + mf.hIn * PT_PER_IN + 20 }
    const hasClip = typeof d.clipRect === 'function' && typeof d.restoreClip === 'function'
    if (hasClip) d.clipRect!(ox, oy, mf.wIn * PT_PER_IN, mf.hIn * PT_PER_IN)
    let drawn = 0
    let lastAlpha = ''
    const alpha = (fa: number, sa: number): void => {
        const key = fa.toFixed(3) + '/' + sa.toFixed(3)
        if (key === lastAlpha || typeof d.setAlpha !== 'function') return
        d.setAlpha(fa, sa); lastAlpha = key
    }
    try {
        for (const f of data.features) {
            const s = f.sym
            const fa = (s.fill ? s.fill[3] : 1) * op
            const sa = (s.stroke ? s.stroke.color[3] : 1) * op
            if (f.geom.kind === 'polygon' && f.geom.rings && s.kind === 'fill') {
                if (!s.fill && !s.stroke && !s.hatch) continue
                const subs = f.geom.rings.map(r => r.map(p => T(p[0], p[1])))
                const bb = bboxOf(subs)
                if (!overlaps(bb, box)) continue
                if (s.fill) {
                    alpha(fa, sa)
                    d.setFill(s.fill[0], s.fill[1], s.fill[2])
                    d.path!(subs, true, 'F', true)
                }
                // hatch: clip to the polygon itself, then rule lines across it
                if (s.hatch && typeof d.clipPath === 'function' && typeof d.restoreClip === 'function') {
                    d.clipPath(subs, true)
                    lastAlpha = ''
                    alpha(1, s.hatch.color[3] * op)
                    applyStroke(d, { color: s.hatch.color, widthPt: 0.75, dash: null })
                    const cut = { x0: Math.max(bb.x0, box.x0), y0: Math.max(bb.y0, box.y0), x1: Math.min(bb.x1, box.x1), y1: Math.min(bb.y1, box.y1) }
                    const segs = hatchSegments(s.hatch.style, cut, 6)
                    if (segs.length) d.path!(segs.map(g => [[g[0], g[1]], [g[2], g[3]]] as Array<[number, number]>), false, 'S', false)
                    d.restoreClip()
                    lastAlpha = ''
                }
                if (s.stroke) {
                    alpha(fa, sa)
                    applyStroke(d, s.stroke)
                    d.path!(subs, true, 'S', false)
                }
                drawn++
            } else if (f.geom.kind === 'polyline' && f.geom.paths && s.stroke) {
                const subs = f.geom.paths.map(pth => pth.map(p => T(p[0], p[1])))
                if (!overlaps(bboxOf(subs), box)) continue
                alpha(1, sa)
                applyStroke(d, s.stroke)
                d.path!(subs, false, 'S', false)
                drawn++
            } else if (f.geom.kind === 'point' && s.marker && typeof f.geom.x === 'number' && typeof f.geom.y === 'number') {
                // markers stay screen-aligned on a rotated map, as in the SDK
                const pp = T(f.geom.x, f.geom.y)
                const cx = pp[0] + s.marker.xoffPt
                const cy = pp[1] - s.marker.yoffPt
                if (cx < box.x0 || cx > box.x1 || cy < box.y0 || cy > box.y1) continue
                if (s.marker.style === 'picture' && s.marker.pic) {
                    const src = data.images && data.images[s.marker.pic.url]
                    if (!src) continue
                    alpha(op, op)
                    const w = s.marker.pic.wPt, h = s.marker.pic.hPt
                    void d.image(src, 'PNG', cx - w / 2, cy - h / 2, w, h)
                    drawn++
                    continue
                }
                if (s.marker.style === 'path' && s.marker.path) {
                    const t2 = (Number(s.marker.angle) || 0) * Math.PI / 180
                    const cs2 = Math.cos(t2), sn2 = Math.sin(t2), k2 = s.marker.sizePt
                    const rings = s.marker.path.map(sp => sp.map(([x, y]) => [cx + (x * cs2 - y * sn2) * k2, cy + (x * sn2 + y * cs2) * k2] as [number, number]))
                    if (!s.fill && !s.stroke) continue
                    alpha(fa, sa)
                    if (s.fill) d.setFill(s.fill[0], s.fill[1], s.fill[2])
                    if (s.stroke) applyStroke(d, { ...s.stroke, dash: null })
                    d.path!(rings, true, s.fill && s.stroke ? 'FD' : (s.fill ? 'F' : 'S'), false)
                    drawn++
                    continue
                }
                const shape = markerShape(s.marker.style as MarkerStyle, cx, cy, s.marker.sizePt, s.marker.angle)
                if (shape.open) {
                    const st: VStroke | null = s.stroke || (s.fill ? { color: s.fill, widthPt: Math.max(1, s.marker.sizePt / 8), dash: null } : null)
                    if (!st) continue
                    alpha(1, st.color[3] * op)
                    applyStroke(d, { ...st, dash: null })
                    d.path!(shape.rings, false, 'S', false)
                } else {
                    if (!s.fill && !s.stroke) continue
                    alpha(fa, sa)
                    if (s.fill) d.setFill(s.fill[0], s.fill[1], s.fill[2])
                    if (s.stroke) applyStroke(d, { ...s.stroke, dash: null })
                    d.path!(shape.rings, true, s.fill && s.stroke ? 'FD' : (s.fill ? 'F' : 'S'), false)
                }
                drawn++
            }
        }
    } finally {
        if (typeof d.setDash === 'function') d.setDash(null)
        if (hasClip) d.restoreClip!()
        else if (typeof d.setAlpha === 'function') d.setAlpha(1, 1)
    }
    return drawn
}

/** Draw one vector layer's labels with greedy collision removal against
 *  every label already on the board (all layers). Labels must fit inside
 *  the map frame. Returns labels placed. */
export function drawVectorLabels (
    d: Drawer,
    cap: Parameters<typeof pageTransform>[0],
    mf: { xIn: number, yIn: number, wIn: number, hIn: number },
    data: VectorLayerData,
    board: LabelBoard
): number {
    const specs = data.labels || []
    const T = pageTransform(cap, mf)
    if (!specs.length || !T) return 0
    const frame = { x0: mf.xIn * PT_PER_IN, y0: mf.yIn * PT_PER_IN, x1: (mf.xIn + mf.wIn) * PT_PER_IN, y1: (mf.yIn + mf.hIn) * PT_PER_IN }
    let placed = 0
    for (const f of data.features) {
        if (!f.label) continue
        const sp = specs[f.label.spec]
        if (!sp) continue
        let cand: LabelCand | null = null
        if (f.geom.kind === 'point' && typeof f.geom.x === 'number' && typeof f.geom.y === 'number') {
            const p = T(f.geom.x, f.geom.y)
            const rad = (f.sym.marker ? f.sym.marker.sizePt / 2 : 3) + 2
            const pl = sp.placement || 'above-center'
            const vert = /^above/.test(pl) ? -1 : (/^below/.test(pl) ? 1 : 0)
            const horz = /left$/.test(pl) ? -1 : (/right$/.test(pl) ? 1 : 0)
            cand = { cx: p[0] + horz * rad, cy: p[1] + vert * (rad + sp.sizePt * 0.5), angle: 0 }
            // left/right: anchor the text's edge at the offset, not its centre
            ;(cand as any).hAlign = horz
        } else if (f.geom.kind === 'polygon' && f.geom.rings) {
            const q = polygonLabelPoint(f.geom.rings.map(r => r.map(p => T(p[0], p[1]))))
            if (q) cand = { cx: q.x, cy: q.y, angle: 0 }
        } else if (f.geom.kind === 'polyline' && f.geom.paths) {
            cand = lineLabelPoint(f.geom.paths.map(pth => pth.map(p => T(p[0], p[1]))))
            if (cand) {
                const pl = sp.placement || 'center-along'
                const off = /^above/.test(pl) ? -1 : (/^below/.test(pl) ? 1 : 0)
                if (off) {
                    const t = cand.angle * Math.PI / 180
                    const k = (sp.sizePt * 0.6 + ((f.sym.stroke && f.sym.stroke.widthPt) || 1) / 2)
                    // text "up" in page space (y down) is (sin t, -cos t)
                    cand.cx += -off * Math.sin(t) * k
                    cand.cy += off * Math.cos(t) * k
                }
            }
        }
        if (!cand) continue
        cand.cx += sp.xoffPt
        cand.cy -= sp.yoffPt
        d.setFont(sp.weight, sp.sizePt)
        const tw = d.textWidth(f.label.text)
        const th = sp.sizePt
        const hAlign = Number((cand as any).hAlign) || 0
        const ccx = cand.cx + hAlign * tw / 2
        const t = cand.angle * Math.PI / 180
        const hw = (Math.abs(tw * Math.cos(t)) + Math.abs(th * Math.sin(t))) / 2 + 1
        const hh = (Math.abs(tw * Math.sin(t)) + Math.abs(th * Math.cos(t))) / 2 + 1
        const bb = { x0: ccx - hw, y0: cand.cy - hh, x1: ccx + hw, y1: cand.cy + hh }
        if (bb.x0 < frame.x0 || bb.y0 < frame.y0 || bb.x1 > frame.x1 || bb.y1 > frame.y1) continue
        if (board.boxes.some(b => overlaps(b, bb))) continue
        board.boxes.push(bb)
        d.setTextColor(sp.color[0], sp.color[1], sp.color[2])
        const halo = sp.haloColor ? [sp.haloColor[0], sp.haloColor[1], sp.haloColor[2]] as [number, number, number] : null
        if (Math.abs(cand.angle) > 0.5 && typeof d.textAngle === 'function') {
            // start of the baseline, so the text is centred on the anchor
            const bx = ccx - Math.cos(t) * tw / 2 - Math.sin(t) * (th * 0.35)
            const by = cand.cy - Math.sin(t) * tw / 2 + Math.cos(t) * (th * 0.35)
            d.textAngle(f.label.text, bx, by, cand.angle, halo, sp.haloPt)
        } else if (halo && typeof d.haloText === 'function') {
            d.haloText(f.label.text, ccx, cand.cy + th * 0.35, 'center', halo, sp.haloPt)
        } else {
            d.text(f.label.text, ccx, cand.cy + th * 0.35, 'center')
        }
        placed++
    }
    return placed
}

/** Every picture-marker image a layer's features use (for prefetching). */
export function pictureUrls (data: VectorLayerData): string[] {
    const set = new Set<string>()
    for (const f of data.features) {
        const pic = f.sym && f.sym.marker && f.sym.marker.pic
        if (pic && pic.url) set.add(pic.url)
    }
    return Array.from(set)
}
