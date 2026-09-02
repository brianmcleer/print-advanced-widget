/**
 * ArcGIS Pro .pagx (CIM) importer for print-advanced.
 *
 * A .pagx is a JSON CIMLayoutDocument. This parser translates the layout into
 * the widget's element model ONCE at import time (in settings). The runtime
 * never touches CIM - it renders the stored element list through the Drawer
 * backends, so PDF/SVG/PNG/etc. all reproduce the Pro layout.
 *
 * Coordinate systems: CIM pages are inches with the ORIGIN AT BOTTOM-LEFT and
 * Y increasing upward. The widget model uses inches from TOP-LEFT. Conversion:
 *   yTop = pageHeight - yCimTop
 *
 * Deliberate translations (each recorded as a warning so nothing is silent):
 *  - North arrows: Pro renders a glyph from the proprietary "ESRI North" font,
 *    which cannot be reproduced client-side. The widget's vector arrow is
 *    fitted to the element's frame instead.
 *  - Scale bar division values: Pro stores the division distance fitted to the
 *    authoring scale (e.g. 30 mi). At other print scales that distance won't
 *    fit, so the widget re-fits a round distance to the bar's frame at export
 *    time, keeping the bar's style, divisions, colors, and units.
 *  - Pictures: .pagx stores a local file path (not the image bytes) unless
 *    explicitly embedded. Attach the image in settings.
 */
import { PrintLayout, LayoutElement, TextEl, RGB, ScaleBarUnits, ScaleBarStyle, newLayoutId } from './config'

export interface PagxParseResult {
  layout: PrintLayout
  warnings: string[]
}

/* ------------------------------------------------------------------ */
/* CIM helpers                                                         */
/* ------------------------------------------------------------------ */

function cimColorToRgb (c: any, fallback: RGB = [0, 0, 0]): RGB {
  if (!c || !Array.isArray(c.values)) return fallback
  const v = c.values
  switch (c.type) {
    case 'CIMRGBColor':
      return [v[0] || 0, v[1] || 0, v[2] || 0]
    case 'CIMCMYKColor': {
      const [C, M, Y, K] = [v[0] / 100, v[1] / 100, v[2] / 100, v[3] / 100]
      return [
        Math.round(255 * (1 - C) * (1 - K)),
        Math.round(255 * (1 - M) * (1 - K)),
        Math.round(255 * (1 - Y) * (1 - K))
      ]
    }
    case 'CIMGrayColor':
      return [v[0] || 0, v[0] || 0, v[0] || 0]
    default:
      return fallback
  }
}

interface BBox { xmin: number, ymin: number, xmax: number, ymax: number }

function bboxOf (shape: any): BBox | null {
  if (!shape) return null
  if (typeof shape.xmin === 'number') {
    return { xmin: shape.xmin, ymin: shape.ymin, xmax: shape.xmax, ymax: shape.ymax }
  }
  const rings = shape.rings || (shape.paths ? shape.paths : null)
  if (rings && rings.length) {
    let xmin = Infinity; let ymin = Infinity; let xmax = -Infinity; let ymax = -Infinity
    for (const ring of rings) {
      for (const pt of ring) {
        xmin = Math.min(xmin, pt[0]); xmax = Math.max(xmax, pt[0])
        ymin = Math.min(ymin, pt[1]); ymax = Math.max(ymax, pt[1])
      }
    }
    return { xmin, ymin, xmax, ymax }
  }
  if (typeof shape.x === 'number' && typeof shape.y === 'number') {
    return { xmin: shape.x, ymin: shape.y, xmax: shape.x, ymax: shape.y }
  }
  return null
}

/** First CIMSolidStroke layer of a line symbol -> color + width(pt). */
function strokeOf (symRef: any): { color: RGB, widthPt: number } | null {
  const layers = symRef?.symbol?.symbolLayers
  if (!Array.isArray(layers)) return null
  for (const l of layers) {
    if (l.type === 'CIMSolidStroke' && l.enable !== false) {
      return { color: cimColorToRgb(l.color), widthPt: typeof l.width === 'number' ? l.width : 1 }
    }
  }
  return null
}

/** First CIMSolidFill color inside a polygon symbol (used for text color). */
function fillOf (sym: any): RGB {
  const layers = sym?.symbolLayers
  if (Array.isArray(layers)) {
    for (const l of layers) {
      if (l.type === 'CIMSolidFill' && l.enable !== false) return cimColorToRgb(l.color)
    }
    for (const l of layers) {
      if (l.color) return cimColorToRgb(l.color)
    }
  }
  return [0, 0, 0]
}

/** Esri linear unit WKID -> widget units. */
function unitsFromWkid (uwkid: number, unitLabel: string): ScaleBarUnits {
  switch (uwkid) {
    case 9001: return 'meters'
    case 9036: return 'kilometers'
    case 9002: case 9003: return 'feet'
    case 9093: case 9035: return 'miles'
  }
  const s = (unitLabel || '').toLowerCase()
  if (s.startsWith('mile')) return 'miles'
  if (s.startsWith('kilo')) return 'kilometers'
  if (s.startsWith('meter') || s.startsWith('metre')) return 'meters'
  return 'feet'
}

function scaleBarStyleFromCim (el: any): ScaleBarStyle {
  const s = String(el.style || '')
  if (el.type === 'CIMScaleLine') return /stepped/i.test(s) ? 'steppedLine' : 'scaleLine'
  if (/doublealternating/i.test(s)) return 'doubleAlternating'
  if (/alternating/i.test(s)) return 'alternating'
  if (/hollow/i.test(s)) return 'hollow'
  if (/single/i.test(s)) return 'singleDivision'
  return 'doubleAlternating'
}

/**
 * CIM element `anchor` drives where text sits in its frame - measured against
 * Pro output, it overrides the text symbol's verticalAlignment (a CenterPoint
 * title with symbol VA=Top renders vertically CENTERED in Pro).
 */
function valignFromAnchor (anchor: string | undefined): 'top' | 'center' | 'bottom' | null {
  if (!anchor) return null
  if (/top/i.test(anchor)) return 'top'
  if (/bottom/i.test(anchor)) return 'bottom'
  return 'center' // CenterPoint, LeftMidPoint, RightMidPoint, ...
}

/* ------------------------------------------------------------------ */
/* dynamic text normalization                                          */
/* ------------------------------------------------------------------ */

/**
 * Convert ArcGIS Pro <dyn .../> tags to widget runtime tokens. The renderer
 * (pdfRenderer.replaceTokens) resolves these at export time.
 *
 *   {title} {author} {copyright} {attribution} {layoutName} {mapName} {user}
 *   {date} {date:<fmt>} {time} {time:<fmt>}      fmt: short | long | .NET pattern
 *   {scale}                                      "24,000" (Pro adds "1:" via preStr)
 *   {scaleRatio:<mapUnits>:<dp>}                 "1 inch equals X <units>" value
 *   {rotation} {mapUnits} {wkid} {dpi}
 *   {sr:name|pcs|gcs|datum|projection|units|authority|wkid|<parameter>}
 *   {coord:<center|center.x|center.y|lowerLeft|...|upperRight>:<dd|dms|ddm|>:<dp>}
 *   {pageNumber} {pageCount} {pageName} {pageIndex}   (map series)
 *   {pageWidth} {pageHeight} {pageUnits}
 *
 * Pro's preStr/postStr/emptyStr: for values that are always present the
 * pre/post text is baked around the token. For values that may be empty
 * (credits, names, user, sr/coord lookups) the wrapper form
 * {name|pre=..|post=..|empty=..} is emitted so pre/post print only when the
 * value exists, exactly like Pro. Unknown tags are stripped (warned).
 */
export function normalizeDynText (raw: string, warnings: string[]): { text: string, isTitle: boolean } {
  let isTitle = false
  // '|', '{', '}' would break the wrapper syntax; percent-encode just those
  const enc = (s: string): string => (s || '').replace(/\|/g, '%7C').replace(/\{/g, '%7B').replace(/\}/g, '%7D')
  const clean = (s: string): string => (s || '').replace(/[{}|]/g, '').trim()
  const text = (raw || '').replace(/<dyn\b([^>]*)\/>/gi, (_m, attrsStr: string) => {
    const attrs: Record<string, string> = {}
    const re = /(\w+)\s*=\s*"([^"]*)"/g
    let a: RegExpExecArray | null
    while ((a = re.exec(attrsStr)) !== null) attrs[a[1]] = a[2]
    const pre = attrs.preStr || ''
    const post = attrs.postStr || ''
    const empty = attrs.emptyStr || ''
    const type = (attrs.type || '').toLowerCase()
    const prop = (attrs.property || '')
    const propL = prop.toLowerCase()
    const attrL = (attrs.attribute || '').toLowerCase()
    const fmt = clean(attrs.format || '')

    /** always-present value: bake pre/post around the token */
    const bake = (token: string): string => pre + '{' + token + '}' + post
    /** maybe-empty value: wrapper form so pre/post vanish with the value */
    const wrap = (token: string): string => {
      if (!pre && !post && !empty) return '{' + token + '}'
      let mods = ''
      if (pre) mods += '|pre=' + enc(pre)
      if (post) mods += '|post=' + enc(post)
      if (empty) mods += '|empty=' + enc(empty)
      return '{' + token + mods + '}'
    }
    /** date/time with an optional Pro format ("short|short" = date + time) */
    const dateTime = (): string => {
      // split on the raw pipe FIRST (clean() strips pipes), then sanitize
      const segs = (attrs.format || '').split('|').map(s => clean(s))
      const dFmt = segs[0] && segs[0].toLowerCase() !== 'short' ? ':' + segs[0] : ''
      if (segs.length > 1) {
        const tFmt = segs[1] && segs[1].toLowerCase() !== 'short' ? ':' + segs[1] : ''
        return pre + '{date' + dFmt + '} {time' + tFmt + '}' + post
      }
      return bake('date' + dFmt)
    }

    // ---- system ----
    if (type === 'date') return dateTime()
    if (type === 'time') return bake('time' + (fmt && fmt.toLowerCase() !== 'short' ? ':' + fmt : ''))
    if (type === 'user') return wrap('user')
    if (type === 'computer') return wrap('computer')

    // ---- layout / project ----
    if (type === 'layout' || type === 'project') {
      if (attrL === 'title') { isTitle = true; return bake('title') }
      if (propL === 'metadata' && attrL === 'credits') return wrap('copyright')
      if (propL === 'servicelayercredits') return wrap('attribution')
      if (type === 'layout' && propL === 'name') return wrap('layoutName')
      if (propL === 'dateexported' || propL === 'dateprinted' || propL === 'datesaved') return dateTime()
      if (propL === 'pagesize') {
        if (attrL === 'width') return bake('pageWidth')
        if (attrL === 'height') return bake('pageHeight')
        if (attrL === 'unit' || attrL === 'units') return bake('pageUnits')
      }
    }

    // ---- map frame ----
    if (type === 'mapframe') {
      if (propL === 'scale' || propL === 'centerscale' || propL === 'camera.scale') {
        if (attrs.mapUnits) {
          const dp = attrs.decimalPlaces || '0'
          return bake('scaleRatio:' + clean(attrs.mapUnits) + ':' + clean(dp))
        }
        return bake('scale')
      }
      if (propL === 'rotation' || propL === 'camera.rotation') return bake('rotation')
      if (propL === 'mapunits') return wrap('mapUnits')
      if (propL === 'name' || propL === 'mapname') return wrap('mapName')
      if (propL === 'credits') return wrap('attribution')
      if (propL === 'metadata') {
        if (attrL === 'title') return wrap('mapName')
        if (attrL === 'credits') return wrap('attribution')
      }
      if (propL === 'sr' || propL === 'spatialreference') {
        const srp = clean(attrs.srProperty || attrs.attribute || 'name').toLowerCase()
        return wrap('sr:' + srp)
      }
      const coordProps = ['center', 'center.x', 'center.y', 'camera.x', 'camera.y',
        'lowerleft', 'lowermid', 'lowerright', 'midleft', 'midright', 'upperleft', 'uppermid', 'upperright']
      if (coordProps.indexOf(propL) >= 0) {
        const units = clean(attrs.units || '').toLowerCase()
        const dp = clean(attrs.decimalPlaces || '')
        // camera.x/y are the center in a 2D map
        const p = propL === 'camera.x' ? 'center.x' : propL === 'camera.y' ? 'center.y' : prop
        return wrap('coord:' + p + ':' + units + ':' + dp)
      }
    }

    // ---- map series pages ----
    if (type === 'page') {
      if (propL === 'number') return bake('pageNumber')
      if (propL === 'count') return bake('pageCount')
      if (propL === 'name') return bake('pageName')
      if (propL === 'index') return bake('pageIndex')
    }

    warnings.push('Dynamic text tag not supported, removed: type="' + (attrs.type || '?') + '"' +
      (attrs.property ? ' property="' + attrs.property + '"' : '') +
      (attrs.attribute ? ' attribute="' + attrs.attribute + '"' : ''))
    return empty || (pre + post)
  })
  return { text, isTitle }
}

/* ------------------------------------------------------------------ */
/* main                                                                */
/* ------------------------------------------------------------------ */

export function parsePagx (doc: any, fileName: string): PagxParseResult {
  const warnings: string[] = []
  if (!doc || doc.type !== 'CIMLayoutDocument' || !doc.layoutDefinition) {
    throw new Error('Not a valid .pagx: expected a CIMLayoutDocument.')
  }
  const def = doc.layoutDefinition
  const page = def.page || {}
  const pageWIn: number = page.width
  const pageHIn: number = page.height
  if (!(pageWIn > 0) || !(pageHIn > 0)) throw new Error('.pagx page has no width/height.')
  const uwkid = page.units && page.units.uwkid
  if (uwkid && uwkid !== 109008) {
    warnings.push('Page units WKID ' + uwkid + ' assumed to be inches; verify page size (' + pageWIn + ' x ' + pageHIn + ').')
  }

  const flip = (b: BBox): { xIn: number, yIn: number, wIn: number, hIn: number } => ({
    xIn: b.xmin,
    yIn: pageHIn - b.ymax,
    wIn: b.xmax - b.xmin,
    hIn: b.ymax - b.ymin
  })

  const elements: LayoutElement[] = []
  const cimEls: any[] = def.elements || []

  for (const el of cimEls) {
    if (el.visible === false) continue
    const name: string = el.name || el.type

    try {
      switch (el.type) {
        case 'CIMMapFrame': {
          const b = bboxOf(el.frame)
          if (!b) { warnings.push('Map frame "' + name + '" has no frame geometry, skipped.'); break }
          const stroke = strokeOf(el.graphicFrame?.borderSymbol)
          elements.push({
            type: 'mapFrame',
            name,
            ...flip(b),
            borderColor: stroke ? stroke.color : null,
            borderWidthPt: stroke ? stroke.widthPt : 0
          })
          break
        }

        case 'CIMGraphicElement': {
          const g = el.graphic || {}
          if (g.type === 'CIMLineGraphic') {
            const stroke = strokeOf(g.symbol) || { color: [0, 0, 0] as RGB, widthPt: 1 }
            const paths = g.line?.paths || []
            for (const path of paths) {
              elements.push({
                type: 'line',
                name,
                points: path.map((p: number[]) => [p[0], pageHIn - p[1]] as [number, number]),
                color: stroke.color,
                widthPt: stroke.widthPt
              })
            }
          } else if (g.type === 'CIMParagraphTextGraphic' || g.type === 'CIMTextGraphic') {
            const b = bboxOf(g.shape)
            if (!b) { warnings.push('Text "' + name + '" has no shape, skipped.'); break }
            const sym = g.symbol?.symbol || {}
            const styleName = String(sym.fontStyleName || '')
            const { text, isTitle } = normalizeDynText(String(g.text || ''), warnings)
            const halign = String(sym.horizontalAlignment || 'Left').toLowerCase()
            const symValign = String(sym.verticalAlignment || 'Top').toLowerCase()
            const anchorValign = valignFromAnchor(el.anchor)
            const textEl: TextEl = {
              type: 'text',
              name,
              ...flip(b),
              text,
              fontSizePt: typeof sym.height === 'number' ? sym.height : 10,
              bold: /bold/i.test(styleName),
              italic: /italic/i.test(styleName),
              align: halign === 'center' ? 'center' : halign === 'right' ? 'right' : 'left',
              valign: anchorValign || (symValign === 'center' ? 'center' : symValign === 'bottom' ? 'bottom' : 'top'),
              color: fillOf(sym.symbol),
              isTitle
            }
            elements.push(textEl)
            if (sym.fontFamilyName && !/^(tahoma|arial|helvetica|verdana|segoe)/i.test(sym.fontFamilyName)) {
              warnings.push('Text "' + name + '" uses font "' + sym.fontFamilyName + '"; rendered as Helvetica.')
            } else if (sym.fontFamilyName && !/^(arial|helvetica)/i.test(sym.fontFamilyName)) {
              warnings.push('Text "' + name + '" font "' + sym.fontFamilyName + '" rendered as Helvetica (metrics close).')
            }
          } else if (g.type === 'CIMPictureGraphic') {
            const b = bboxOf(g.box || g.frame || g.shape)
            if (!b) { warnings.push('Picture "' + name + '" has no box, skipped.'); break }
            const src = String(g.sourceURL || '')
            const base = src.split(/[\\/]/).pop() || 'image'
            let dataUrl: string | undefined
            if (/^data:image\//i.test(src)) dataUrl = src
            else warnings.push('Picture "' + name + '" references a file path (' + base + '); the image is not embedded in the .pagx. Attach it in settings.')
            const anc = String(el.anchor || '')
            elements.push({
              type: 'picture', name, ...flip(b), sourceName: base, dataUrl,
              anchorH: /right/i.test(anc) ? 'right' : /left/i.test(anc) ? 'left' : 'center',
              anchorV: /top/i.test(anc) ? 'top' : /bottom/i.test(anc) ? 'bottom' : 'center'
            })
          } else if (g.type === 'CIMPolygonGraphic') {
            const b = bboxOf(g.polygon)
            const stroke = strokeOf(g.symbol)
            if (b && stroke) {
              // approximate as its bounding rectangle outline
              const f = flip(b)
              elements.push({
                type: 'line',
                name,
                points: [
                  [f.xIn, f.yIn], [f.xIn + f.wIn, f.yIn],
                  [f.xIn + f.wIn, f.yIn + f.hIn], [f.xIn, f.yIn + f.hIn], [f.xIn, f.yIn]
                ],
                color: stroke.color,
                widthPt: stroke.widthPt
              })
              warnings.push('Polygon graphic "' + name + '" approximated by its bounding rectangle outline.')
            } else {
              warnings.push('Polygon graphic "' + name + '" skipped.')
            }
          } else {
            warnings.push('Graphic "' + name + '" (' + (g.type || 'unknown') + ') is not supported, skipped.')
          }
          break
        }

        case 'CIMMarkerNorthArrow': {
          const b = bboxOf(el.frame)
          if (!b) { warnings.push('North arrow has no frame, skipped.'); break }
          elements.push({ type: 'northArrow', name, ...flip(b) })
          warnings.push('North arrow rendered with the widget\'s vector style (the "ESRI North" font glyph cannot be reproduced client-side).')
          break
        }

        case 'CIMDoubleFillScaleBar':
        case 'CIMScaleBar':
        case 'CIMScaleLine': {
          const b = bboxOf(el.frame)
          if (!b) { warnings.push('Scale bar has no frame, skipped.'); break }
          const c1 = fillOf(el.fillSymbol1?.symbol)
          let c2 = fillOf(el.fillSymbol2?.symbol)
          if (c1[0] === c2[0] && c1[1] === c2[1] && c1[2] === c2[2]) {
            c2 = [255, 255, 255]
            warnings.push('Scale bar fill 1 and fill 2 are the same color in the .pagx; fill 2 rendered white for legibility.')
          }
          elements.push({
            type: 'scaleBar',
            name,
            ...flip(b),
            style: scaleBarStyleFromCim(el),
            units: unitsFromWkid(el.units?.uwkid, el.unitLabel),
            divisions: Math.max(1, el.divisions || 2),
            subdivisions: Math.max(1, el.subdivisions || 1),
            barHeightPt: typeof el.barHeight === 'number' ? el.barHeight : 8,
            labelSizePt: typeof el.labelSymbol?.symbol?.height === 'number' ? el.labelSymbol.symbol.height : 8,
            unitLabelSizePt: typeof el.unitLabelSymbol?.symbol?.height === 'number' ? el.unitLabelSymbol.symbol.height : undefined,
            color1: c1,
            color2: c2
          })
          warnings.push('Scale bar division distance is re-fitted to the printed scale at export (Pro stores a distance fitted to the authoring scale).')
          break
        }

        case 'CIMLegend': {
          const b = bboxOf(el.frame)
          if (!b) { warnings.push('Legend has no frame, skipped.'); break }
          // Carry the Pro author's column count and title choice onto the
          // element. A horizontal bottom legend is authored with several
          // ManualColumns and usually showTitle=false; without these the
          // client fitter defaults to <=4 columns and a "Legend" title the
          // author turned off, which wastes a short frame and looks wrong.
          const legEl: any = { type: 'legend', name, ...flip(b), maxItems: 30 }
          const cols = Number((el as any).columns)
          if (isFinite(cols) && cols > 0) legEl.columns = Math.min(8, Math.round(cols))
          if (typeof (el as any).showTitle === 'boolean') legEl.showTitle = (el as any).showTitle
          elements.push(legEl)
          warnings.push('Legend is built client-side from visible feature layers inside the legend frame from the .pagx.')
          break
        }

        default:
          warnings.push('Element "' + name + '" (' + el.type + ') is not supported, skipped.')
      }
    } catch (e: any) {
      warnings.push('Element "' + name + '" failed to import: ' + (e?.message || e))
    }
  }

  if (!elements.some(e => e.type === 'mapFrame')) {
    throw new Error('The .pagx has no map frame element - nothing to print.')
  }

  const baseName = (fileName || 'layout').replace(/\.pagx$/i, '')
  // A .pagx can carry more than one map frame (a Pro-authored inset). The
  // widget renders one live-map frame; keep the main one (WEBMAP_MAP_FRAME by
  // convention, else the largest) and skip the rest so the same capture is
  // not stretched into every frame. Use the Overview inset in settings for
  // an inset map.
  const frames = elements.filter(e => e.type === 'mapFrame') as any[]
  if (frames.length > 1) {
    const main = frames.find(f => f.name === 'WEBMAP_MAP_FRAME') ||
      frames.reduce((a, b) => (a.wIn * a.hIn >= b.wIn * b.hIn ? a : b))
    for (const f of frames) {
      if (f === main) continue
      const idx = elements.indexOf(f)
      if (idx >= 0) elements.splice(idx, 1)
      warnings.push('Map frame "' + f.name + '" skipped (one live map frame is supported). ' +
        'Use the Overview inset in the layout settings for an inset map.')
    }
  }

  const layout: PrintLayout = {
    id: newLayoutId(),
    name: baseName,
    sourceFile: fileName,
    pageWidthIn: pageWIn,
    pageHeightIn: pageHIn,
    dpi: 200,
    imageFormat: 'jpg',
    preserve: 'scale',
    elements
  }
  return { layout, warnings }
}
