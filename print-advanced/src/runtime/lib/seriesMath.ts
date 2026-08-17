/** Map series tile math: pure geometry for grid and corridor series.
 *  No API imports; callers supply ground-unit conversions. All extents are
 *  in map units, page dimensions in inches, scale as 1:n denominator.
 *  Tiles are page-ordered reading order: top row first, left to right. */

export interface SeriesEnvelope { xmin: number, ymin: number, xmax: number, ymax: number }

export interface SeriesTile extends SeriesEnvelope {
    page: number
    row: number
    col: number
    centerX: number
    centerY: number
}

/** Ground size (map units) of one page frame at a scale.
 *  metersPerMapUnit converts: frameIn * scale gives ground inches;
 *  * 0.0254 gives meters; / mpu gives map units. */
export function tileGroundSize (
    frameWIn: number, frameHIn: number, scaleDenom: number, metersPerMapUnit: number
): { w: number, h: number } {
    const w = frameWIn * scaleDenom * 0.0254 / metersPerMapUnit
    const h = frameHIn * scaleDenom * 0.0254 / metersPerMapUnit
    return { w, h }
}

/** Grid series over an envelope at a fixed scale. Overlap is a fraction of
 *  the tile dimension shared between neighbors (0 to 0.5). The tile block
 *  is centered on the envelope; coverage always includes the whole envelope. */
export function gridTiles (
    env: SeriesEnvelope,
    frameWIn: number, frameHIn: number,
    scaleDenom: number, metersPerMapUnit: number,
    overlapFrac: number = 0.1
): SeriesTile[] {
    const t = tileGroundSize(frameWIn, frameHIn, scaleDenom, metersPerMapUnit)
    const ov = Math.max(0, Math.min(0.5, overlapFrac))
    const stepW = t.w * (1 - ov)
    const stepH = t.h * (1 - ov)
    const envW = Math.max(0, env.xmax - env.xmin)
    const envH = Math.max(0, env.ymax - env.ymin)
    const cols = envW <= t.w ? 1 : Math.ceil((envW - t.w) / stepW) + 1
    const rows = envH <= t.h ? 1 : Math.ceil((envH - t.h) / stepH) + 1
    // center the covered block on the envelope
    const coveredW = t.w + (cols - 1) * stepW
    const coveredH = t.h + (rows - 1) * stepH
    const x0 = (env.xmin + env.xmax) / 2 - coveredW / 2
    const yTop = (env.ymin + env.ymax) / 2 + coveredH / 2
    const tiles: SeriesTile[] = []
    let page = 1
    for (let r = 0; r < rows; r++) {
        for (let c = 0; c < cols; c++) {
            const xmin = x0 + c * stepW
            const ymax = yTop - r * stepH
            tiles.push({
                page: page++,
                row: r,
                col: c,
                xmin,
                ymax,
                xmax: xmin + t.w,
                ymin: ymax - t.h,
                centerX: xmin + t.w / 2,
                centerY: ymax - t.h / 2
            })
        }
    }
    return tiles
}

/** Grid series by explicit rows x cols: tile size derives from the envelope
 *  and overlap, then grows on one axis to match the frame aspect so every
 *  page prints at a uniform scale without distortion. */
export function gridTilesByCount (
    env: SeriesEnvelope,
    rows: number, cols: number,
    frameWIn: number, frameHIn: number,
    overlapFrac: number = 0.1
): SeriesTile[] {
    const ov = Math.max(0, Math.min(0.5, overlapFrac))
    rows = Math.max(1, Math.round(rows))
    cols = Math.max(1, Math.round(cols))
    const envW = Math.max(1e-9, env.xmax - env.xmin)
    const envH = Math.max(1e-9, env.ymax - env.ymin)
    // solve tile size so the block spans the envelope exactly
    let tileW = envW / (cols - (cols - 1) * ov)
    let tileH = envH / (rows - (rows - 1) * ov)
    // enforce frame aspect by growing the deficient axis
    const aspect = frameWIn / frameHIn
    if (tileW / tileH < aspect) tileW = tileH * aspect
    else tileH = tileW / aspect
    const stepW = tileW * (1 - ov)
    const stepH = tileH * (1 - ov)
    const coveredW = tileW + (cols - 1) * stepW
    const coveredH = tileH + (rows - 1) * stepH
    const x0 = (env.xmin + env.xmax) / 2 - coveredW / 2
    const yTop = (env.ymin + env.ymax) / 2 + coveredH / 2
    const tiles: SeriesTile[] = []
    let page = 1
    for (let r = 0; r < rows; r++) {
        for (let c = 0; c < cols; c++) {
            const xmin = x0 + c * stepW
            const ymax = yTop - r * stepH
            tiles.push({
                page: page++,
                row: r,
                col: c,
                xmin,
                ymax,
                xmax: xmin + tileW,
                ymin: ymax - tileH,
                centerX: xmin + tileW / 2,
                centerY: ymax - tileH / 2
            })
        }
    }
    return tiles
}

/** Corridor series: tiles stationed along a polyline at a fixed scale.
 *  Stations are spaced by the tile's SHORT dimension times (1 - overlap),
 *  the worst-case travel direction, so coverage holds on any bearing;
 *  with stations forced at both ends; near-duplicate stations dedupe.
 *  Tiles are axis-aligned (rotation stays with the map view, not the tile). */
export function corridorTiles (
    line: Array<[number, number]>,
    frameWIn: number, frameHIn: number,
    scaleDenom: number, metersPerMapUnit: number,
    overlapFrac: number = 0.15
): SeriesTile[] {
    if (!line || line.length < 2) return []
    const t = tileGroundSize(frameWIn, frameHIn, scaleDenom, metersPerMapUnit)
    const ov = Math.max(0, Math.min(0.5, overlapFrac))
    const step = Math.min(t.w, t.h) * (1 - ov)
    // cumulative lengths
    const seg: number[] = [0]
    let total = 0
    for (let i = 1; i < line.length; i++) {
        const dx = line[i][0] - line[i - 1][0]
        const dy = line[i][1] - line[i - 1][1]
        total += Math.hypot(dx, dy)
        seg.push(total)
    }
    const pointAt = (d: number): [number, number] => {
        if (d <= 0) return line[0]
        if (d >= total) return line[line.length - 1]
        let i = 1
        while (seg[i] < d) i++
        const f = (d - seg[i - 1]) / (seg[i] - seg[i - 1])
        return [
            line[i - 1][0] + (line[i][0] - line[i - 1][0]) * f,
            line[i - 1][1] + (line[i][1] - line[i - 1][1]) * f
        ]
    }
    const stations: Array<[number, number]> = []
    const n = total <= step ? 1 : Math.ceil(total / step)
    for (let i = 0; i <= n; i++) stations.push(pointAt(Math.min(total, i * (total / Math.max(1, n)))))
    // dedupe stations closer than a quarter tile
    const minGap = Math.min(t.w, t.h) * 0.25
    const kept: Array<[number, number]> = []
    for (const p of stations) {
        if (!kept.length || Math.hypot(p[0] - kept[kept.length - 1][0], p[1] - kept[kept.length - 1][1]) > minGap) {
            kept.push(p)
        }
    }
    return kept.map((p, i) => ({
        page: i + 1,
        row: 0,
        col: i,
        xmin: p[0] - t.w / 2,
        xmax: p[0] + t.w / 2,
        ymin: p[1] - t.h / 2,
        ymax: p[1] + t.h / 2,
        centerX: p[0],
        centerY: p[1]
    }))
}

/** Envelope of a whole series, for the index page capture. */
export function seriesEnvelope (tiles: SeriesTile[], padFrac: number = 0.05): SeriesEnvelope | null {
    if (!tiles.length) return null
    let xmin = Infinity; let ymin = Infinity; let xmax = -Infinity; let ymax = -Infinity
    for (const t of tiles) {
        xmin = Math.min(xmin, t.xmin); ymin = Math.min(ymin, t.ymin)
        xmax = Math.max(xmax, t.xmax); ymax = Math.max(ymax, t.ymax)
    }
    const pw = (xmax - xmin) * padFrac
    const ph = (ymax - ymin) * padFrac
    return { xmin: xmin - pw, ymin: ymin - ph, xmax: xmax + pw, ymax: ymax + ph }
}

/** The print-true series envelope: the largest region INSIDE a view extent
 *  whose aspect lets rows x cols frame-aspect tiles cover it EXACTLY, so
 *  the series grid never extends beyond what the user sees, and every
 *  tile is a real printable page. Centered on the view. */
export function envelopeForFrame (
    viewExt: SeriesEnvelope,
    rows: number, cols: number,
    frameWIn: number, frameHIn: number,
    overlapFrac: number = 0.1
): SeriesEnvelope {
    const ov = Math.max(0, Math.min(0.5, overlapFrac))
    rows = Math.max(1, Math.round(rows))
    cols = Math.max(1, Math.round(cols))
    const colsEff = cols - (cols - 1) * ov
    const rowsEff = rows - (rows - 1) * ov
    const target = (frameWIn / frameHIn) * (colsEff / rowsEff)
    const vw = Math.max(1e-9, viewExt.xmax - viewExt.xmin)
    const vh = Math.max(1e-9, viewExt.ymax - viewExt.ymin)
    let w: number; let h: number
    if (vw / vh > target) { h = vh; w = vh * target } else { w = vw; h = vw / target }
    const cx = (viewExt.xmin + viewExt.xmax) / 2
    const cy = (viewExt.ymin + viewExt.ymax) / 2
    return { xmin: cx - w / 2, xmax: cx + w / 2, ymin: cy - h / 2, ymax: cy + h / 2 }
}
