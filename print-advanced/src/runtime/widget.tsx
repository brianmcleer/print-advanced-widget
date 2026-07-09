/** @jsx jsx */
/**
 * Print Advanced - client-side print widget (no print service).
 * Layouts are defined in the widget settings; output is rendered in the
 * browser to PDF with vector page furniture and a high-resolution map capture.
 * Author: Brian McLeer, City of Grand Junction
 */
import { React, AllWidgetProps, jsx, css } from 'jimu-core'
import { Button, Select, TextInput, Label, WidgetPlaceholder, Loading, LoadingType, Alert, Tooltip, Switch } from 'jimu-ui'
import { JimuMapView, JimuMapViewComponent } from 'jimu-arcgis'
import { IMConfig, PrintLayout } from '../config'
import { DownOutlined } from 'jimu-icons/outlined/directional/down'
import { RightOutlined } from 'jimu-icons/outlined/directional/right'
import Graphic from 'esri/Graphic'
import * as print from 'esri/rest/print'
import PrintTemplate from 'esri/rest/support/PrintTemplate'
import PrintParameters from 'esri/rest/support/PrintParameters'
import SpatialReference from 'esri/geometry/SpatialReference'
import * as reactiveUtils from 'esri/core/reactiveUtils'
import { metersPerMapUnit, printExtent, extentRings, extentFitScale, resolvePrintedScale } from './lib/scaleMath'
import defaultMessages from './translations/default'
import { renderLayout, OutputFormat, FORMAT_LABELS, RenderOptions, NORTH_ARROW_STYLES, SCALE_BAR_STYLES, SCALE_BAR_UNITS, FONT_FAMILIES } from './lib/pdfRenderer'

const printIcon = require('./assets/icons/icon.svg')

interface State {
  jimuMapView: JimuMapView | null
  selectedLayoutId: string
  title: string
  fileName: string
  format: OutputFormat
  dpi: string
  naStyle: string
  sbStyle: string
  sbUnits: string
  sbUnits2: string
  fontFamily: string
  scaleMode: string
  fixedScale: string
  previewOn: boolean
  locked: boolean
  scaleReadout: number | null
  advOpen: boolean
  busy: boolean
  status: string
  error: string | null
  lastResult: string | null
  author: string
  copyright: string
  includeLegend: boolean
  mapOnly: boolean
  mapOnlyW: string
  mapOnlyH: string
  svcTemplate: string
  svcScalePreserved: boolean
  svcForceAttrs: boolean
  outWkid: string
  results: Array<{ name: string, url: string, meta: string }>
}

export default class Widget extends React.PureComponent<AllWidgetProps<IMConfig>, State> {
  constructor (props: AllWidgetProps<IMConfig>) {
    super(props)
    const layouts = this.getLayouts()
    const first = layouts.length > 0 ? layouts[0] : null
    const cfgAny: any = (props.config as any) || {}
    const d: any = cfgAny.runtimeDefaults || {}
    this.state = {
      jimuMapView: null,
      selectedLayoutId: first ? first.id : '',
      title: cfgAny.defaultTitle ? String(cfgAny.defaultTitle).replace(/\{layout\}/g, first ? first.name : '') : '',
      fileName: '',
      format: 'pdf', // corrected below via initialFormat once methods exist
      dpi: d.dpi || '',
      naStyle: d.northArrowStyle || '',
      sbStyle: d.scaleBarStyle || '',
      sbUnits: d.scaleBarUnits || '',
      sbUnits2: d.scaleBarUnits2 || '',
      fontFamily: '',
      scaleMode: (cfgAny.mapExtent && cfgAny.mapExtent.defaultMode) || 'current',
      fixedScale: (cfgAny.mapExtent && cfgAny.mapExtent.defaultScale) ? String(cfgAny.mapExtent.defaultScale) : '',
      previewOn: !!(cfgAny.mapExtent && cfgAny.mapExtent.previewOnByDefault),
      locked: false,
      scaleReadout: null,
      advOpen: cfgAny.advancedOpenByDefault === true,
      busy: false,
      status: '',
      error: null,
      lastResult: null,
      author: cfgAny.defaultAuthor || ((this.props as any).user && (this.props as any).user.username) || '',
      copyright: cfgAny.defaultCopyright || '',
      includeLegend: true,
      mapOnly: false,
      mapOnlyW: '',
      mapOnlyH: '',
      svcTemplate: '',
      svcScalePreserved: false,
      svcForceAttrs: false,
      outWkid: cfgAny.defaultOutputWkid ? String(cfgAny.defaultOutputWkid) : '',
      results: []
    }
    this.state = { ...this.state, format: this.initialFormat() }
  }

  cfg = (): any => (this.props.config as any) || {}

  /** Stable, instance-unique DOM id for label/control association. */
  uid = (key: string): string => 'pd-' + this.props.id + '-' + key

  /** Small inline SVG preview of a north-arrow or scale-bar style (UI only). */
  styleGlyph = (kind: 'na' | 'sb', value: string): React.ReactNode => {
    const c = 'var(--ref-palette-neutral-1100, #333)'
    if (kind === 'na') {
      const N = <text x={30} y={9} textAnchor='middle' fontSize={8} fill={c}>N</text>
      const star = (cx: number, cy: number, outer: number, inner: number, pts: number): string => {
        let s = ''
        for (let k = 0; k < pts * 2; k++) {
          const r = k % 2 ? inner : outer
          const a = -Math.PI / 2 + (k * Math.PI) / pts
          s += (cx + Math.cos(a) * r).toFixed(1) + ',' + (cy + Math.sin(a) * r).toFixed(1) + ' '
        }
        return s.trim()
      }
      let g: React.ReactNode = null
      switch (value) {
        case 'splitArrow':
          g = <React.Fragment>
            <polygon points='30,11 30,29 23,29' fill={c} />
            <polygon points='30,11 30,29 37,29' fill='none' stroke={c} strokeWidth={1} />
          </React.Fragment>; break
        case 'solidTriangle':
          g = <polygon points='30,11 23,29 37,29' fill={c} />; break
        case 'needle':
          g = <React.Fragment>
            <polygon points='30,11 33,21 27,21' fill={c} />
            <polygon points='30,30 33,21 27,21' fill='none' stroke={c} strokeWidth={1} />
          </React.Fragment>; break
        case 'compassStar':
          g = <polygon points={star(30, 21, 12, 4, 4)} fill={c} />; break
        case 'circledArrow':
          g = <React.Fragment>
            <circle cx={30} cy={21} r={10} fill='none' stroke={c} strokeWidth={1} />
            <polygon points='30,14 26,23 34,23' fill={c} />
          </React.Fragment>; break
        case 'outlineArrow':
          g = <polygon points='30,11 23,29 37,29' fill='none' stroke={c} strokeWidth={1} />; break
        case 'simpleArrow':
          g = <React.Fragment>
            <line x1={30} y1={17} x2={30} y2={30} stroke={c} strokeWidth={1.4} />
            <polygon points='30,11 25,19 35,19' fill={c} />
          </React.Fragment>; break
        case 'chevron':
          g = <React.Fragment>
            <line x1={30} y1={12} x2={24} y2={22} stroke={c} strokeWidth={1.6} />
            <line x1={30} y1={12} x2={36} y2={22} stroke={c} strokeWidth={1.6} />
          </React.Fragment>; break
        case 'meridian':
          g = <React.Fragment>
            <line x1={30} y1={16} x2={30} y2={30} stroke={c} strokeWidth={1} />
            <polygon points='30,11 27,17 33,17' fill={c} />
            <circle cx={30} cy={30} r={1.4} fill={c} />
          </React.Fragment>; break
        case 'compassRose':
          g = <polygon points={star(30, 21, 12, 5, 8)} fill={c} />; break
        case 'starburst':
          g = <polygon points={star(30, 21, 13, 3, 8)} fill={c} />; break
        case 'filledCircleArrow':
          g = <React.Fragment>
            <circle cx={30} cy={21} r={10} fill={c} />
            <polygon points='30,14 26,24 34,24' fill='#fff' />
          </React.Fragment>; break
        default: // layout default
          g = <React.Fragment>
            <rect x={20} y={11} width={20} height={20} rx={2} fill='none' stroke={c} strokeWidth={1} strokeDasharray='2 2' />
            <polygon points='30,15 27,22 33,22' fill={c} />
          </React.Fragment>
      }
      return <svg viewBox='0 0 60 34' role='img' aria-hidden='true'>{N}{g}</svg>
    }
    // scale bar
    const base = 22, x0 = 6, x1 = 54, w = x1 - x0, seg = w / 4
    let g: React.ReactNode = null
    switch (value) {
      case 'alternating':
        g = <React.Fragment>
          {[0,1,2,3].map(i => <rect key={i} x={x0 + i*seg} y={14} width={seg} height={8} fill={i % 2 === 0 ? c : 'none'} stroke={c} strokeWidth={1} />)}
        </React.Fragment>; break
      case 'doubleAlternating':
        g = <React.Fragment>
          {[0,1,2,3].map(i => <rect key={'t'+i} x={x0 + i*seg} y={13} width={seg} height={4} fill={i % 2 === 0 ? c : 'none'} stroke={c} strokeWidth={0.8} />)}
          {[0,1,2,3].map(i => <rect key={'b'+i} x={x0 + i*seg} y={17} width={seg} height={4} fill={i % 2 === 1 ? c : 'none'} stroke={c} strokeWidth={0.8} />)}
        </React.Fragment>; break
      case 'hollow':
        g = <React.Fragment>
          <rect x={x0} y={14} width={w} height={8} fill='none' stroke={c} strokeWidth={1} />
          {[1,2,3].map(i => <line key={i} x1={x0 + i*seg} y1={14} x2={x0 + i*seg} y2={22} stroke={c} strokeWidth={1} />)}
        </React.Fragment>; break
      case 'singleDivision':
        g = <React.Fragment>
          <rect x={x0} y={14} width={w} height={8} fill='none' stroke={c} strokeWidth={1} />
          <rect x={x0} y={14} width={w/2} height={8} fill={c} />
        </React.Fragment>; break
      case 'scaleLine':
        g = <React.Fragment>
          <line x1={x0} y1={base} x2={x1} y2={base} stroke={c} strokeWidth={1} />
          {[x0, 30, x1].map((x,i) => <line key={i} x1={x} y1={13} x2={x} y2={base} stroke={c} strokeWidth={1} />)}
        </React.Fragment>; break
      case 'steppedLine':
        g = <React.Fragment>
          <line x1={x0} y1={base} x2={x1} y2={base} stroke={c} strokeWidth={1} />
          <line x1={x0} y1={11} x2={x0} y2={base} stroke={c} strokeWidth={1} />
          <line x1={x0+seg} y1={15} x2={x0+seg} y2={base} stroke={c} strokeWidth={1} />
          <line x1={x0+2*seg} y1={18} x2={x0+2*seg} y2={base} stroke={c} strokeWidth={1} />
          <line x1={x1} y1={15} x2={x1} y2={base} stroke={c} strokeWidth={1} />
        </React.Fragment>; break
      case 'hollowDouble':
        g = <React.Fragment>
          <rect x={x0} y={13} width={w} height={4} fill='none' stroke={c} strokeWidth={0.8} />
          <rect x={x0} y={17} width={w} height={4} fill='none' stroke={c} strokeWidth={0.8} />
          {[1,2,3].map(i => <line key={i} x1={x0+i*seg} y1={13} x2={x0+i*seg} y2={21} stroke={c} strokeWidth={0.8} />)}
        </React.Fragment>; break
      case 'line':
        g = <React.Fragment>
          <line x1={x0} y1={13} x2={x1} y2={13} stroke={c} strokeWidth={1} />
          {[0,1,2,3,4].map(i => <line key={i} x1={x0+i*seg} y1={13} x2={x0+i*seg} y2={20} stroke={c} strokeWidth={1} />)}
        </React.Fragment>; break
      case 'steppedFilled':
        g = <React.Fragment>
          {[0,1,2,3].map(i => { const h = 8 - i*1.6; return <rect key={i} x={x0+i*seg} y={22-h} width={seg} height={h} fill={i % 2 === 0 ? c : 'none'} stroke={c} strokeWidth={0.8} /> })}
        </React.Fragment>; break
      default: // layout default
        g = <React.Fragment>
          <rect x={x0} y={13} width={w} height={9} rx={2} fill='none' stroke={c} strokeWidth={1} strokeDasharray='2 2' />
          <rect x={x0+2} y={15} width={seg-2} height={5} fill={c} />
        </React.Fragment>
    }
    return <svg viewBox='0 0 60 34' role='img' aria-hidden='true'>{g}</svg>
  }

  /** Visual style picker: tiles (SVG preview + label) incl. a Layout default tile. */
  renderStylePicker = (
    kind: 'na' | 'sb',
    styles: Array<{ value: string, label: string }>,
    value: string,
    onSelect: (v: string) => void,
    labelId: string,
    defaultLabel: string
  ): React.ReactElement => {
    const opts = [{ value: '', label: defaultLabel }, ...styles]
    return (
      <div className='pd-swatch-group' role='group' aria-labelledby={labelId}>
        {opts.map(o => (
          <button type='button' key={o.value || 'default'}
            className='pd-swatch'
            aria-pressed={value === o.value}
            aria-label={o.label}
            title={o.label}
            onClick={() => onSelect(o.value)}>
            {this.styleGlyph(kind, o.value)}
            <span className='pd-swatch-lbl'>{o.label}</span>
          </button>
        ))}
      </div>
    )
  }

  private previewGraphic: any = null
  private previewView: any = null
  private previewWatch: any = null
  private lockedCenter: { x: number, y: number } | null = null
  private lockedScale: number | null = null

  mapExtentCfg = (): any => {
    const me: any = this.cfg().mapExtent
    return me && me.asMutable ? me.asMutable({ deep: true }) : (me || {})
  }

  meEnabled = (): boolean => !!this.mapExtentCfg().enabled
  meMapOnly = (): boolean => !!this.cfg().enableMapOnly
  outSREnabled = (): boolean => !!this.cfg().enableOutputSR

  printSource = (): string => (this.cfg().printServiceUrl && this.cfg().printSource === 'service') ? 'service' : 'pagx'
  serviceUrl = (): string => this.cfg().printServiceUrl || ''
  serviceTemplates = (): string[] => {
    const c = this.cfg().serviceTemplates
    const list = Array.isArray(c) ? c : (c && c.asMutable ? c.asMutable() : null)
    return (list && list.length) ? list : [
      'letter-ansi-a-landscape', 'letter-ansi-a-portrait',
      'tabloid-ansi-b-landscape', 'tabloid-ansi-b-portrait',
      'a4-landscape', 'a4-portrait', 'a3-landscape', 'a3-portrait', 'map-only'
    ]
  }

  private hexToRgb = (hex: string, fallback: [number, number, number]): [number, number, number] => {
    const m = /^#?([0-9a-f]{6})$/i.exec((hex || '').trim())
    if (!m) return fallback
    const n = parseInt(m[1], 16)
    return [(n >> 16) & 255, (n >> 8) & 255, n & 255]
  }

  private previewSymbol = (): any => {
    const me = this.mapExtentCfg()
    const line = this.hexToRgb(me.previewOutlineColor, [0, 122, 194])
    const fill = this.hexToRgb(me.previewFillColor, line as any)
    const width = Number(me.previewOutlineWidth) || 2
    return { type: 'simple-fill', color: [fill[0], fill[1], fill[2], 0.08], outline: { color: [line[0], line[1], line[2], 1], width } }
  }

  scaleChoices = (): number[] => {
    const me = this.mapExtentCfg()
    const c = me.scaleChoices
    const list = Array.isArray(c) ? c : (c && c.asMutable ? c.asMutable() : null)
    return (list && list.length) ? list : [1000, 2400, 6000, 12000, 24000, 50000, 100000, 250000]
  }

  availableScaleModes = (): Array<{ value: string, label: string }> => {
    const me = this.mapExtentCfg()
    const m = defaultMessages as any
    const out: Array<{ value: string, label: string }> = []
    if (me.showPreserveScale !== false) out.push({ value: 'current', label: m.modeCurrent })
    if (me.showPreserveExtent) out.push({ value: 'preserveExtent', label: m.modeExtent })
    if (me.showForceScale || me.showScaleSelect) out.push({ value: 'fixed', label: m.modeFixed })
    return out.length ? out : [{ value: 'current', label: m.modeCurrent }]
  }

  private frameOf = (): any => {
    const layout = this.getSelectedLayout()
    if (!layout || !layout.elements) return null
    return layout.elements.find((e: any) => e.type === 'mapFrame') || null
  }

  captureAttribution = (view: any): string => {
    try {
      const out: string[] = []
      const push = (s: any) => { if (s && typeof s === 'string' && out.indexOf(s) < 0) out.push(s) }
      if (view && view.map) {
        if (view.map.allLayers && view.map.allLayers.forEach) view.map.allLayers.forEach((l: any) => push(l.copyright))
        const bm = view.map.basemap
        if (bm && bm.baseLayers && bm.baseLayers.forEach) bm.baseLayers.forEach((l: any) => push(l.copyright))
      }
      return out.join(' | ')
    } catch (e) { return '' }
  }

  /** Compute the current print scale + center the same way the export will. */
  private computeScaleCenter = (view: any, mf: any): { scale: number, center: { x: number, y: number } } => {
    const mpu = metersPerMapUnit(view.scale, view.resolution)
    const ext = view.extent
    const fit = extentFitScale(ext.width, ext.height, mpu, mf.wIn, mf.hIn, mf.wIn * 100, mf.hIn * 100)
    const scale = resolvePrintedScale(this.state.scaleMode as any, view.scale, Number(this.state.fixedScale) || 0, fit)
    return { scale, center: { x: view.center.x, y: view.center.y } }
  }

  updatePreview = (): void => {
    try {
      const jmv = this.state.jimuMapView
      const view: any = jmv && jmv.view
      const mf = this.frameOf()
      if (!view || !mf) return
      let scale: number, center: { x: number, y: number }
      if (this.state.locked && this.lockedScale && this.lockedCenter) {
        scale = this.lockedScale; center = this.lockedCenter
      } else {
        const r = this.computeScaleCenter(view, mf); scale = r.scale; center = r.center
      }
      const mpu = metersPerMapUnit(view.scale, view.resolution)
      const ext = printExtent(center.x, center.y, mpu, mf.wIn, mf.hIn, scale)
      const rings = extentRings(ext, center.x, center.y, view.rotation || 0)
      const geometry: any = { type: 'polygon', rings: [rings], spatialReference: view.spatialReference }
      const symbol: any = this.previewSymbol()
      if (this.previewGraphic && this.previewView && this.previewView !== view) {
        // map view changed since the graphic was added - move it to the new view
        try { this.previewView.graphics.remove(this.previewGraphic) } catch (e) { /* ignore */ }
        this.previewGraphic = null
      }
      if (!this.previewGraphic) {
        this.previewGraphic = new Graphic({ geometry, symbol })
        view.graphics.add(this.previewGraphic)
        this.previewView = view
      } else {
        this.previewGraphic.geometry = geometry
        this.previewGraphic.symbol = symbol
      }
      if (this.state.scaleReadout !== Math.round(scale)) this.setState({ scaleReadout: Math.round(scale) })
    } catch (e) { /* preview is best-effort; never break the widget */ }
  }

  clearPreview = (): void => {
    try {
      const view: any = this.previewView || (this.state.jimuMapView && this.state.jimuMapView.view)
      if (view && this.previewGraphic) view.graphics.remove(this.previewGraphic)
    } catch (e) { /* ignore */ }
    this.previewGraphic = null
    this.previewView = null
  }

  startPreviewWatch = (view: any): void => {
    this.stopPreviewWatch()
    try {
      this.previewWatch = reactiveUtils.watch(
        () => [view.stationary, view.scale, view.center && view.center.x, view.center && view.center.y, view.rotation],
        () => { if (this.state.previewOn && !this.state.locked) this.updatePreview() }
      )
    } catch (e) { /* ignore */ }
  }

  stopPreviewWatch = (): void => {
    try { if (this.previewWatch && this.previewWatch.remove) this.previewWatch.remove() } catch (e) { /* ignore */ }
    this.previewWatch = null
  }

  toggleLock = (): void => {
    const next = !this.state.locked
    if (next) {
      const view: any = this.state.jimuMapView && this.state.jimuMapView.view
      const mf = this.frameOf()
      if (view && mf) {
        const r = this.computeScaleCenter(view, mf)
        this.lockedScale = r.scale; this.lockedCenter = r.center
      }
    } else {
      this.lockedCenter = null; this.lockedScale = null
    }
    this.setState({ locked: next })
  }

  componentDidUpdate (_prevProps: AllWidgetProps<IMConfig>, prevState: State): void {
    const s = this.state
    const view: any = s.jimuMapView && s.jimuMapView.view
    if (s.jimuMapView !== prevState.jimuMapView && view && s.previewOn) {
      this.startPreviewWatch(view); this.updatePreview()
    }
    if (s.previewOn !== prevState.previewOn) {
      if (s.previewOn && view) { this.startPreviewWatch(view); this.updatePreview() }
      else { this.clearPreview(); this.stopPreviewWatch() }
    }
    if (s.previewOn && view && (
      s.scaleMode !== prevState.scaleMode || s.fixedScale !== prevState.fixedScale ||
      s.selectedLayoutId !== prevState.selectedLayoutId || s.locked !== prevState.locked)) {
      this.updatePreview()
    }
  }

  componentWillUnmount (): void {
    this.clearPreview(); this.stopPreviewWatch()
    this.revokeResultUrls(this.state.results)
  }

  /** All custom fonts: legacy single customFont + customFonts array, deduped by name. */
  customFontList = (): Array<{ name: string, url: string, boldUrl?: string }> => {
    const c: any = this.props.config as any
    const map = new Map<string, { name: string, url: string, boldUrl?: string }>()
    const push = (cf: any) => {
      if (cf && typeof cf.url === 'string' && cf.url) {
        map.set(cf.name || 'Custom', { name: cf.name || 'Custom', url: cf.url, boldUrl: cf.boldUrl || undefined })
      }
    }
    if (c) {
      const legacy = c.customFont && c.customFont.asMutable ? c.customFont.asMutable({ deep: true }) : c.customFont
      push(legacy)
      const arr = c.customFonts && c.customFonts.asMutable ? c.customFonts.asMutable({ deep: true }) : c.customFonts
      if (Array.isArray(arr)) arr.forEach(push)
    }
    return Array.from(map.values())
  }

  /** Control visibility: default true unless explicitly false. */
  ctrl = (key: string): boolean => {
    const c = this.cfg().controls
    return !c || c[key] !== false
  }

  defaults = (): any => this.cfg().runtimeDefaults || {}

  enabledFormats = (): string[] | null => {
    const list = this.cfg().enabledFormats
    if (!list || !list.length) return null
    return Array.isArray(list) ? [...list] : (list.asMutable ? list.asMutable() : null)
  }

  formatAllowed = (v: string): boolean => {
    const list = this.enabledFormats()
    return !list || list.indexOf(v) >= 0
  }

  initialFormat = (): OutputFormat => {
    const d = this.defaults().format
    if (d && d !== 'aix' && this.formatAllowed(d)) return d as OutputFormat
    const first = FORMAT_LABELS.find(f => !f.disabled && this.formatAllowed(f.value))
    return (first ? first.value : 'pdf') as OutputFormat
  }

  resolveTitle = (layout: PrintLayout | null): string => {
    const tpl = this.cfg().defaultTitle as string
    if (!tpl) return ''
    return tpl.replace(/\{layout\}/g, layout ? layout.name : '')
  }

  getLayouts = (): PrintLayout[] => {
    // ExB doesn't backfill new config keys on existing instances - guard everything.
    const cfg = this.props.config
    const raw = cfg && (cfg as any).layouts
    if (!raw) return []
    const arr = typeof (raw as any).asMutable === 'function'
      ? (raw as any).asMutable({ deep: true })
      : [...(raw as any)]
    return arr as PrintLayout[]
  }

  getSelectedLayout = (): PrintLayout | null => {
    const layouts = this.getLayouts()
    return layouts.find(l => l.id === this.state.selectedLayoutId) || layouts[0] || null
  }

  onActiveViewChange = (jmv: JimuMapView): void => {
    this.setState({ jimuMapView: jmv || null })
  }

  onLayoutChange = (e: any): void => {
    const id = e?.target?.value
    const layout = this.getLayouts().find(l => l.id === id)
    const layouts = this.getLayouts()
    const prev = layouts.find(l => l.id === this.state.selectedLayoutId) || null
    const next = layouts.find(l => l.id === id) || null
    const d: any = this.defaults()
    // keep a user-typed title; refresh only if still the previous auto title
    const auto = this.state.title === '' || this.state.title === this.resolveTitle(prev)
    this.setState({
      selectedLayoutId: id,
      title: auto ? this.resolveTitle(next) : this.state.title,
      dpi: d.dpi || '',
      naStyle: d.northArrowStyle || '',
      sbStyle: d.scaleBarStyle || '',
      sbUnits: d.scaleBarUnits || '',
      sbUnits2: d.scaleBarUnits2 || '',
      fontFamily: '',
      locked: false
    })
    this.lockedCenter = null; this.lockedScale = null
  }

  buildFileName = (layout: PrintLayout | null): string => {
    const cfgName = (this.props.config as any)?.defaultFilename as string
    const tpl = this.state.fileName || cfgName || '{title}'
    const d = new Date()
    const iso = d.getFullYear() + '-' +
      String(d.getMonth() + 1).padStart(2, '0') + '-' +
      String(d.getDate()).padStart(2, '0')
    return tpl
      .replace(/\{title\}/g, this.state.title || (layout && layout.name) || 'map')
      .replace(/\{date\}/g, iso)
  }

  /** Revoke session blob: URLs when their list entries go away (remote URLs untouched). */
  private revokeResultUrls = (items: Array<{ url: string }>): void => {
    items.forEach(r => {
      if (r && typeof r.url === 'string' && r.url.indexOf('blob:') === 0) {
        try { URL.revokeObjectURL(r.url) } catch (e) { /* ignore */ }
      }
    })
  }

  clearResults = (): void => {
    this.revokeResultUrls(this.state.results)
    this.setState({ results: [] })
  }

  removeResult = (index: number): void => {
    const gone = this.state.results.filter((_, i) => i === index)
    this.revokeResultUrls(gone)
    this.setState({ results: this.state.results.filter((_, i) => i !== index) })
  }

  /** Prepend a result, evicting (and revoking) anything past the cap. */
  private pushResult = (item: { name: string, url: string, meta: string }): Array<{ name: string, url: string, meta: string }> => {
    const next = [item, ...this.state.results]
    this.revokeResultUrls(next.slice(8))
    return next.slice(0, 8)
  }

  runServicePrint = async (): Promise<void> => {
    const { jimuMapView } = this.state
    if (!jimuMapView || !jimuMapView.view) return
    const url = this.serviceUrl()
    if (!url) { this.setState({ error: (defaultMessages as any).svcNoUrl }); return }
    this.setState({ busy: true, error: null, lastResult: null, status: (defaultMessages as any).svcSubmitting })
    try {
      const fmt = this.state.format === 'aix' ? 'aix' : this.state.format
      const template = new PrintTemplate({
        format: fmt as any,
        exportOptions: { dpi: Number(this.state.dpi) || 96 } as any,
        layout: (this.state.svcTemplate || this.serviceTemplates()[0]) as any,
        scalePreserved: this.state.svcScalePreserved,
        forceFeatureAttributes: this.state.svcForceAttrs,
        layoutOptions: {
          titleText: this.state.title || '',
          authorText: this.state.author || '',
          copyrightText: this.state.copyright || '',
          scalebarUnit: (this.state.sbUnits || 'Miles') as any
        } as any
      } as any)
      const wkid = this.outSREnabled() ? (parseInt(this.state.outWkid, 10) || 0) : 0
      const params = new PrintParameters({
        view: jimuMapView.view as any,
        template,
        ...(wkid > 0 ? { outSpatialReference: new SpatialReference({ wkid }) } : {})
      } as any)
      const result: any = await print.execute(url, params as any)
      const outUrl = result && result.url
      if (!outUrl) throw new Error((defaultMessages as any).svcNoResult)
      const name = (this.buildFileName(this.getSelectedLayout()) || 'map')
      this.setState({
        busy: false, status: '',
        lastResult: name + '  ·  ' + (this.state.svcTemplate || this.serviceTemplates()[0]),
        results: this.pushResult({ name: name + '.' + (this.state.format || 'pdf'), url: outUrl, meta: (defaultMessages as any).svcResultMeta })
      })
      try { window.open(outUrl, '_blank') } catch (e) { /* popup blocked; link is in the list */ }
    } catch (err: any) {
      this.setState({ busy: false, status: '', error: (err && err.message) || (defaultMessages as any).svcFailed })
    }
  }

  onExport = async (): Promise<void> => {
    if (this.printSource() === 'service') { return this.runServicePrint() }
    const { jimuMapView } = this.state
    const layout = this.getSelectedLayout()
    if (!jimuMapView || !jimuMapView.view || !layout) return

    this.setState({ busy: true, error: null, lastResult: null, status: 'Preparing…' })
    try {
      const maxImagePx = Number((this.props.config as any)?.maxImagePx) || 0 // 0 = auto (GPU-detected)
      const effLayout = this.state.dpi
        ? { ...layout, dpi: Number(this.state.dpi) }
        : layout
      const options: RenderOptions = {}
      if (this.state.naStyle) options.northArrowStyle = this.state.naStyle as any
      if (this.state.sbStyle) options.scaleBarStyle = this.state.sbStyle as any
      if (this.state.sbUnits) options.scaleBarUnits = this.state.sbUnits as any
      if (this.state.sbUnits2) options.scaleBarUnits2 = this.state.sbUnits2 as any
      const cfgLogo = (this.props.config as any)?.defaultLogo
      if (cfgLogo) options.defaultLogo = cfgLogo
      if (this.meEnabled()) {
        if (this.state.locked && this.lockedCenter && this.lockedScale) {
          options.scaleMode = 'fixed'
          options.fixedScale = this.lockedScale
          options.lockedCenter = this.lockedCenter
        } else {
          options.scaleMode = this.state.scaleMode as any
          if (this.state.scaleMode === 'fixed') options.fixedScale = Number(this.state.fixedScale) || undefined
        }
      }
      if (this.state.author) options.author = this.state.author
      if (this.state.copyright) options.copyright = this.state.copyright
      if ((this.props.config as any)?.includeAttribution !== false) {
        options.attribution = this.captureAttribution(jimuMapView.view)
      }
      options.includeLegend = this.state.includeLegend
      if (this.outSREnabled() && parseInt(this.state.outWkid, 10) > 0) {
        options.outputWkid = parseInt(this.state.outWkid, 10)
      }
      if (this.meMapOnly() && this.state.mapOnly) {
        options.mapOnly = true
        if (Number(this.state.mapOnlyW) > 0) options.mapOnlyWidth = Number(this.state.mapOnlyW)
        if (Number(this.state.mapOnlyH) > 0) options.mapOnlyHeight = Number(this.state.mapOnlyH)
      }
      const family = this.state.fontFamily || (this.props.config as any)?.defaultFontFamily || ''
      const customs = this.customFontList()
      if (family.indexOf('custom:') === 0) {
        const nm = family.slice('custom:'.length)
        const f = customs.find(x => x.name === nm) || customs[0]
        if (f) options.customFont = f
      } else if (family === 'custom') {
        // legacy default meaning "the custom font"
        if (customs[0]) options.customFont = customs[0]
      } else if (family) {
        options.fontFamily = family as any
      }
      const result = await renderLayout(
        jimuMapView.view as any,
        effLayout,
        this.state.format,
        this.state.title || layout.name || 'Map',
        this.buildFileName(layout),
        maxImagePx,
        options,
        (msg: string) => this.setState({ status: msg })
      )
      this.setState({
        busy: false,
        status: '',
        lastResult: result.fileName + '  ·  ' + result.effectiveDpi + ' DPI  ·  1:' +
          result.printedScale.toString().replace(/\B(?=(\d{3})+(?!\d))/g, ','),
        results: result.url
          ? this.pushResult({ name: result.fileName, url: result.url, meta: result.effectiveDpi + ' DPI · ' + (result.sizeKb || 0) + ' KB' })
          : this.state.results
      })
    } catch (err: any) {
      this.setState({ busy: false, status: '', error: (err && err.message) || 'Export failed.' })
    }
  }

  describeLayout = (layout: PrintLayout): string => {
    return layout.pageWidthIn + ' × ' + layout.pageHeightIn + ' in · ' + layout.dpi + ' DPI · ' +
      (layout.preserve === 'scale' ? 'keeps map scale' : 'fits current extent')
  }

  getStyle = () => css`
    padding: 12px;
    height: 100%;
    overflow: auto;
    .pd-row { margin-bottom: 10px; }
    .pd-label { font-size: 12px; font-weight: 600; margin-bottom: 3px; display: block; }
    .pd-desc { font-size: 11px; color: var(--ref-palette-neutral-1100, #595959); margin-top: 3px; }
    .pd-status { font-size: 12px; margin-top: 8px; display: flex; align-items: center; gap: 8px; }
    .pd-results { margin-top: 10px; border-top: 1px solid var(--ref-palette-neutral-400, #e0e0e0); padding-top: 6px; }
    .pd-results-head { font-size: 11px; font-weight: 700; margin-bottom: 4px; color: var(--ref-palette-neutral-1100, #333); display: flex; align-items: center; justify-content: space-between; }
    .pd-results-clear { font-size: 11px; font-weight: 400; min-height: auto; padding: 0 4px; }
    .pd-results ul { list-style: none; margin: 0; padding: 0; }
    .pd-results li { display: flex; align-items: center; gap: 6px; font-size: 11px; padding: 2px 0; }
    .pd-results li a { flex: 1 1 auto; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .pd-results-meta { flex: 0 0 auto; color: var(--ref-palette-neutral-1000, #6a6a6a); white-space: nowrap; }
    .pd-results-del { flex: 0 0 auto; border: none; background: transparent; cursor: pointer; font-size: 14px; line-height: 1; padding: 0 2px; color: var(--ref-palette-neutral-1000, #6a6a6a); }
    .pd-results-del:hover { color: var(--ref-palette-neutral-1200, #2b2b2b); }
    .pd-results-del:focus-visible { outline: 2px solid var(--ref-palette-neutral-1100, #4a4a4a); outline-offset: 1px; border-radius: 2px; }
    .pd-result { font-size: 11px; color: var(--sys-color-success-main, #2e7d32); margin-top: 8px; word-break: break-all; }
    .pd-export { width: 100%; margin-top: 4px; }
    .pd-print-area {
      border: 1px solid var(--ref-palette-neutral-500, #d6d6d6);
      border-radius: 4px; padding: 10px 12px; margin: 6px 0 12px 0;
      background: var(--ref-palette-neutral-200, #f7f7f7);
    }
    .pd-pa-head {
      display: flex; justify-content: space-between; align-items: center;
      margin-bottom: 10px;
    }
    .pd-pa-title {
      font-size: 12px; font-weight: 600;
      color: var(--ref-palette-neutral-1200, #2b2b2b);
    }
    .pd-pa-scale {
      font-size: 11px; font-weight: 600; font-variant-numeric: tabular-nums;
      color: var(--ref-palette-neutral-1100, #595959);
      background: var(--ref-palette-neutral-300, #ececec);
      border-radius: 10px; padding: 1px 8px; white-space: nowrap;
    }
    .pd-pa-switch { display: flex; align-items: center; justify-content: space-between; gap: 8px; }
    .pd-pa-switch .pd-label { margin-bottom: 0; }
    .pd-print-area .pd-row { margin-bottom: 10px; }
    .pd-print-area .pd-row:last-of-type { margin-bottom: 0; }
    .pd-print-area .pd-desc { margin-top: 8px; margin-bottom: 0; }
    .pd-swatch-group { display: flex; flex-wrap: wrap; gap: 6px; }
    .pd-swatch {
      display: flex; flex-direction: column; align-items: center; gap: 2px;
      width: 66px; padding: 4px 3px; cursor: pointer;
      background: var(--ref-palette-neutral-100, #fff);
      border: 1px solid var(--ref-palette-neutral-500, #d6d6d6); border-radius: 4px;
    }
    .pd-swatch:hover { border-color: var(--ref-palette-neutral-700, #8a8a8a); }
    .pd-swatch svg { width: 58px; height: 30px; }
    .pd-swatch-lbl { font-size: 10px; line-height: 1.15; text-align: center; color: var(--ref-palette-neutral-1100, #595959); }
    .pd-swatch[aria-pressed='true'] {
      border-color: var(--ref-palette-neutral-1100, #4a4a4a);
      box-shadow: inset 0 0 0 1px var(--ref-palette-neutral-1100, #4a4a4a);
      background: var(--ref-palette-neutral-300, #ececec);
    }
    .pd-swatch[aria-pressed='true'] .pd-swatch-lbl { color: var(--ref-palette-neutral-1200, #2b2b2b); font-weight: 600; }
    .pd-swatch:focus-visible { outline: 2px solid var(--ref-palette-neutral-1100, #4a4a4a); outline-offset: 1px; }
    .pd-adv-toggle {
      display: flex; align-items: center; gap: 6px; cursor: pointer;
      font-size: 12px; font-weight: 600; user-select: none;
      padding: 6px 0; margin: 2px 0 4px 0;
      border-top: 1px solid var(--ref-palette-neutral-400, #e0e0e0);
      color: var(--ref-palette-neutral-1100, #333);
    }
    .pd-adv-toggle:focus-visible { outline: 2px solid var(--sys-color-primary-main, #007ac2); outline-offset: 2px; border-radius: 2px; }
    .pd-sr-only {
      position: absolute; width: 1px; height: 1px; padding: 0; margin: -1px;
      overflow: hidden; clip: rect(0 0 0 0); white-space: nowrap; border: 0;
    }
  `

  render (): React.ReactNode {
    const { useMapWidgetIds } = this.props
    const layouts = this.getLayouts()
    const layout = this.getSelectedLayout()
    const messages = defaultMessages as any

    if (!useMapWidgetIds || useMapWidgetIds.length === 0) {
      return <WidgetPlaceholder icon={printIcon} message={messages.selectMapHint} widgetId={this.props.id} />
    }

    return (
      <div css={this.getStyle()}>
        <JimuMapViewComponent
          useMapWidgetId={useMapWidgetIds[0]}
          onActiveViewChange={this.onActiveViewChange}
        />

        {this.printSource() === 'service' && (
          <React.Fragment>
            <div className='pd-row'>
              <Label className='pd-label' id={this.uid('svctpl') + '-lbl'}>{messages.svcTemplateLabel}</Label>
              <Tooltip title={messages.svcTemplateTip} placement='top'>
                <Select id={this.uid('svctpl')} aria-labelledby={this.uid('svctpl') + '-lbl'} size='sm'
                  value={this.state.svcTemplate || this.serviceTemplates()[0]}
                  onChange={(e: any) => this.setState({ svcTemplate: e.target.value })}>
                  {this.serviceTemplates().map(tpl => (
                    <option key={tpl} value={tpl}>{tpl}</option>
                  ))}
                </Select>
              </Tooltip>
            </div>
            {this.ctrl('title') && (
            <div className='pd-row'>
              <Label className='pd-label' id={this.uid('svctitle') + '-lbl'}>{messages.titleLabel}</Label>
              <Tooltip title={messages.titleTip} placement='top'>
                <TextInput id={this.uid('svctitle')} aria-labelledby={this.uid('svctitle') + '-lbl'} size='sm'
                  value={this.state.title} onChange={(e) => this.setState({ title: e.target.value })} />
              </Tooltip>
            </div>
            )}
            <div className='pd-row'>
              <Label className='pd-label' id={this.uid('svcfmt') + '-lbl'}>{messages.formatLabel}</Label>
              <Tooltip title={messages.formatTip} placement='top'>
                <Select id={this.uid('svcfmt')} aria-labelledby={this.uid('svcfmt') + '-lbl'} size='sm'
                  value={this.state.format} onChange={(e: any) => this.setState({ format: e.target.value })}>
                  {FORMAT_LABELS.map(f => (
                    <option key={f.value} value={f.value}>{f.label}</option>
                  ))}
                </Select>
              </Tooltip>
            </div>
            <div className='pd-row'>
              <Label className='pd-label' id={this.uid('svcdpi') + '-lbl'}>{messages.dpiLabel}</Label>
              <Tooltip title={messages.dpiTip} placement='top'>
                <Select id={this.uid('svcdpi')} aria-labelledby={this.uid('svcdpi') + '-lbl'} size='sm'
                  value={this.state.dpi || '96'} onChange={(e: any) => this.setState({ dpi: e.target.value })}>
                  <option value='96'>96</option>
                  <option value='150'>150</option>
                  <option value='200'>200</option>
                  <option value='300'>300</option>
                  <option value='400'>400</option>
                  <option value='600'>600</option>
                </Select>
              </Tooltip>
            </div>
            {this.ctrl('author') && (
            <div className='pd-row'>
              <Label className='pd-label' id={this.uid('svcauth') + '-lbl'}>{messages.authorLabel}</Label>
              <Tooltip title={messages.authorTip} placement='top'>
                <TextInput id={this.uid('svcauth')} aria-labelledby={this.uid('svcauth') + '-lbl'} size='sm'
                  value={this.state.author} onChange={(e) => this.setState({ author: e.target.value })} />
              </Tooltip>
            </div>
            )}
            {this.ctrl('copyright') && (
            <div className='pd-row'>
              <Label className='pd-label' id={this.uid('svccopy') + '-lbl'}>{messages.copyrightLabel}</Label>
              <Tooltip title={messages.copyrightTip} placement='top'>
                <TextInput id={this.uid('svccopy')} aria-labelledby={this.uid('svccopy') + '-lbl'} size='sm'
                  value={this.state.copyright} onChange={(e) => this.setState({ copyright: e.target.value })} />
              </Tooltip>
            </div>
            )}
            <div className='pd-row pd-pa-switch'>
              <Label className='pd-label' id={this.uid('svcscale') + '-lbl'}>{messages.svcScaleLabel}</Label>
              <Tooltip title={messages.svcScaleTip} placement='top'>
                <Switch aria-labelledby={this.uid('svcscale') + '-lbl'} checked={this.state.svcScalePreserved}
                  onChange={(e) => this.setState({ svcScalePreserved: e.target.checked })} />
              </Tooltip>
            </div>
            <div className='pd-row pd-pa-switch'>
              <Label className='pd-label' id={this.uid('svcattrs') + '-lbl'}>{messages.svcAttrsLabel}</Label>
              <Tooltip title={messages.svcAttrsTip} placement='top'>
                <Switch aria-labelledby={this.uid('svcattrs') + '-lbl'} checked={this.state.svcForceAttrs}
                  onChange={(e) => this.setState({ svcForceAttrs: e.target.checked })} />
              </Tooltip>
            </div>
            {this.outSREnabled() && (
            <div className='pd-row'>
              <Label className='pd-label' id={this.uid('svcwkid') + '-lbl'}>{messages.outSRLabel}</Label>
              <Tooltip title={messages.outSRTip} placement='top'>
                <TextInput size='sm' aria-labelledby={this.uid('svcwkid') + '-lbl'}
                  placeholder={messages.outSRPh} value={this.state.outWkid}
                  onChange={(e: any) => this.setState({ outWkid: (e.target.value || '').replace(/[^0-9]/g, '') })} />
              </Tooltip>
              <div className='pd-desc'>{messages.outSRHint}</div>
            </div>
            )}

            <Tooltip title={messages.exportTip} placement='top'>
              <Button className='pd-export' type='primary'
                aria-busy={this.state.busy}
                disabled={this.state.busy || !this.state.jimuMapView}
                onClick={this.onExport}>
                {this.state.busy ? messages.exporting : messages.exportButton}
              </Button>
            </Tooltip>
            {this.state.busy && (
              <div className='pd-status' role='status' aria-live='polite'>
                <Loading type={LoadingType.Donut} width={16} height={16} />
                <span>{this.state.status}</span>
              </div>
            )}
            <div role='alert' aria-live='assertive'>
              {this.state.error && (
                <div style={{ marginTop: 8 }}>
                  <Alert type='error' text={this.state.error} withIcon style={{ width: '100%' }} />
                </div>
              )}
            </div>
            {this.state.results.length > 0 && (
              <div className='pd-results'>
                <div className='pd-results-head'>
                  <span>{messages.resultsLabel}</span>
                  <Tooltip title={messages.resultsClearTip} placement='top'>
                    <Button size='sm' type='tertiary' className='pd-results-clear'
                      aria-label={messages.resultsClear} onClick={this.clearResults}>{messages.resultsClear}</Button>
                  </Tooltip>
                </div>
                <ul>
                  {this.state.results.map((r, i) => (
                    <li key={r.url + r.name}>
                      <a href={r.url} target='_blank' rel='noopener noreferrer'>{r.name}</a>
                      <span className='pd-results-meta'>{r.meta}</span>
                      <button type='button' className='pd-results-del' title={messages.resultRemove}
                        aria-label={messages.resultRemove + ': ' + r.name}
                        onClick={() => this.removeResult(i)}><span aria-hidden='true'>×</span></button>
                    </li>
                  ))}
                </ul>
              </div>
            )}
          </React.Fragment>
        )}

        {this.printSource() === 'pagx' && layouts.length === 0 && (
          <Alert type='warning' text={messages.noLayoutsHint} withIcon style={{ width: '100%' }} />
        )}

        {this.printSource() === 'pagx' && layouts.length > 0 && (
          <React.Fragment>
            <div className='pd-row'>
              <Label className='pd-label' id={this.uid('layout') + '-lbl'}>{messages.layoutLabel}</Label>
              <Tooltip title={messages.layoutTip} placement='top'>
                <Select id={this.uid('layout')} aria-labelledby={this.uid('layout') + '-lbl'} value={layout ? layout.id : ''}
                  onChange={this.onLayoutChange} size='sm'
                  aria-describedby={layout ? this.uid('layout-desc') : undefined}>
                  {layouts.map(l => (
                    <option key={l.id} value={l.id}>{l.name}</option>
                  ))}
                </Select>
              </Tooltip>
              {layout && <div id={this.uid('layout-desc')} className='pd-desc'>{this.describeLayout(layout)}</div>}
            </div>

            {this.ctrl('title') && (
            <div className='pd-row'>
              <Label className='pd-label' id={this.uid('title') + '-lbl'}>{messages.titleLabel}</Label>
              <Tooltip title={messages.titleTip} placement='top'>
                <TextInput
                  id={this.uid('title')} aria-labelledby={this.uid('title') + '-lbl'}
                  size='sm'
                  value={this.state.title}
                  onChange={(e) => this.setState({ title: e.target.value })}
                  placeholder={layout ? layout.name : ''}
                  aria-label={messages.titleLabel}
                />
              </Tooltip>
            </div>
            )}

            {((this.props.config as any)?.showAdvancedOptions !== false) &&
              (this.meEnabled() || this.ctrl('format') || this.ctrl('dpi') || this.ctrl('font') || this.ctrl('northArrow') || this.ctrl('scaleBar') || this.ctrl('fileName')) && (
              <div className='pd-adv-toggle'
                role='button'
                tabIndex={0}
                aria-expanded={this.state.advOpen}
                aria-controls={this.uid('adv')}
                onClick={() => this.setState({ advOpen: !this.state.advOpen })}
                onKeyDown={(e: React.KeyboardEvent) => {
                  if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); this.setState({ advOpen: !this.state.advOpen }) }
                }}>
                {this.state.advOpen
                  ? <DownOutlined size={12} aria-hidden='true' />
                  : <RightOutlined size={12} aria-hidden='true' />}
                <span>{messages.advancedOptions}</span>
              </div>
            )}

            {((this.props.config as any)?.showAdvancedOptions !== false) && this.state.advOpen && (
            <div id={this.uid('adv')} role='group' aria-label={messages.advancedOptions}>
            {this.meEnabled() && (
            <div className='pd-print-area'>
              <div className='pd-pa-head'>
                <span className='pd-pa-title'>{messages.printAreaLabel}</span>
                {this.state.scaleReadout ? <span className='pd-pa-scale'>1:{this.state.scaleReadout.toLocaleString()}</span> : null}
              </div>
              {this.availableScaleModes().length > 1 && (
                <div className='pd-row'>
                  <Label className='pd-label' id={this.uid('scalemode') + '-lbl'}>{messages.scaleModeLabel}</Label>
                  <Tooltip title={messages.scaleModeTip} placement='top'>
                    <Select size='sm' value={this.state.scaleMode} aria-labelledby={this.uid('scalemode') + '-lbl'}
                      onChange={(e: any) => this.setState({ scaleMode: e.target.value, locked: false })}>
                      {this.availableScaleModes().map(o => (
                        <option key={o.value} value={o.value}>{o.label}</option>
                      ))}
                    </Select>
                  </Tooltip>
                </div>
              )}
              {this.state.scaleMode === 'fixed' && (
                <div className='pd-row'>
                  <Label className='pd-label' id={this.uid('fixedscale') + '-lbl'}>{messages.scaleValueLabel}</Label>
                  <Tooltip title={messages.scaleValueTip} placement='top'>
                    {(this.mapExtentCfg().showScaleSelect && !this.mapExtentCfg().showForceScale)
                      ? <Select size='sm' value={this.state.fixedScale} aria-labelledby={this.uid('fixedscale') + '-lbl'}
                          onChange={(e: any) => this.setState({ fixedScale: e.target.value, locked: false })}>
                          <option value=''>{messages.scalePick}</option>
                          {this.scaleChoices().map(c => (
                            <option key={c} value={String(c)}>1:{c.toLocaleString()}</option>
                          ))}
                        </Select>
                      : <TextInput size='sm' aria-labelledby={this.uid('fixedscale') + '-lbl'}
                          value={this.state.fixedScale}
                          onChange={(e: any) => this.setState({ fixedScale: (e.target.value || '').replace(/[^0-9]/g, ''), locked: false })} />}
                  </Tooltip>
                </div>
              )}
              {this.mapExtentCfg().showPreview !== false && (
                <div className='pd-row pd-pa-switch'>
                  <Label className='pd-label' id={this.uid('preview') + '-lbl'}>{messages.showPreviewLabel}</Label>
                  <Tooltip title={messages.showPreviewTip} placement='top'>
                    <Switch aria-labelledby={this.uid('preview') + '-lbl'}
                      checked={this.state.previewOn}
                      onChange={(e) => this.setState({ previewOn: e.target.checked, locked: e.target.checked ? this.state.locked : false })} />
                  </Tooltip>
                </div>
              )}
              {this.mapExtentCfg().showLock && this.state.previewOn && (
                <div className='pd-row pd-pa-switch'>
                  <Label className='pd-label' id={this.uid('lock') + '-lbl'}>{messages.lockLabel}</Label>
                  <Tooltip title={messages.lockTip} placement='top'>
                    <Switch aria-labelledby={this.uid('lock') + '-lbl'}
                      checked={this.state.locked}
                      onChange={this.toggleLock} />
                  </Tooltip>
                </div>
              )}
              {this.state.locked && <div className='pd-desc'>{messages.lockedNote}</div>}
            </div>
            )}

            {this.ctrl('format') && (
            <div className='pd-row'>
              <Label className='pd-label' id={this.uid('format') + '-lbl'}>{messages.formatLabel}</Label>
              <Tooltip title={messages.formatTip} placement='top'>
                <Select id={this.uid('format')} aria-labelledby={this.uid('format') + '-lbl'} size='sm' value={this.state.format}
                  aria-describedby={(this.state.format === 'svg' || this.state.format === 'svgz' || this.state.format === 'eps') ? this.uid('format-desc') : undefined}
                  onChange={(e: any) => this.setState({ format: e.target.value })}>
                  {FORMAT_LABELS
                    .filter(f => !f.disabled && this.formatAllowed(f.value))
                    .map(f => (
                      <option key={f.value} value={f.value} disabled={!!f.disabled}>{f.label}</option>
                    ))}
                </Select>
              </Tooltip>
              {(this.state.format === 'svg' || this.state.format === 'svgz') &&
                <div id={this.uid('format-desc')} className='pd-desc'>{messages.svgHint}</div>}
              {this.state.format === 'eps' &&
                <div id={this.uid('format-desc')} className='pd-desc'>{messages.epsHint}</div>}
            </div>
            )}

            {this.ctrl('dpi') && (
            <div className='pd-row'>
              <Label className='pd-label' id={this.uid('dpi') + '-lbl'}>{messages.dpiLabel}</Label>
              <Tooltip title={messages.dpiTip} placement='top'>
                <Select id={this.uid('dpi')} aria-labelledby={this.uid('dpi') + '-lbl'} size='sm' value={this.state.dpi}
                  onChange={(e: any) => this.setState({ dpi: e.target.value })}>
                  <option value=''>{messages.dpiDefault}{layout ? ' (' + layout.dpi + ')' : ''}</option>
                  <option value='96'>96 (draft)</option>
                  <option value='150'>150</option>
                  <option value='200'>200</option>
                  <option value='300'>300</option>
                  <option value='400'>400</option>
                  <option value='600'>600</option>
                </Select>
              </Tooltip>
            </div>
            )}

            {this.ctrl('font') && (
            <div className='pd-row'>
              <Label className='pd-label' id={this.uid('font') + '-lbl'}>{messages.fontLabel}</Label>
              <Tooltip title={messages.fontTip} placement='top'>
                <Select id={this.uid('font')} aria-labelledby={this.uid('font') + '-lbl'} size='sm' value={this.state.fontFamily}
                  onChange={(e: any) => this.setState({ fontFamily: e.target.value })}>
                  <option value=''>{messages.fontDefault}</option>
                  {FONT_FAMILIES.map(f => (
                    <option key={f.value} value={f.value}>{f.label}</option>
                  ))}
                  {this.customFontList().map(f => (
                    <option key={f.name} value={'custom:' + f.name}>{f.name}</option>
                  ))}
                </Select>
              </Tooltip>
            </div>
            )}

            {this.ctrl('northArrow') && layout && layout.elements && layout.elements.some(e => e.type === 'northArrow') && (
              <div className='pd-row'>
                <Label className='pd-label' id={this.uid('na') + '-lbl'}>{messages.northArrowLabel}</Label>
                <Tooltip title={messages.northArrowTip} placement='top'>
                  {this.renderStylePicker('na', NORTH_ARROW_STYLES as any, this.state.naStyle,
                    (v) => this.setState({ naStyle: v }), this.uid('na') + '-lbl', messages.layoutDefault)}
                </Tooltip>
              </div>
            )}

            {this.ctrl('scaleBar') && layout && layout.elements && layout.elements.some(e => e.type === 'scaleBar') && (
              <React.Fragment>
                <div className='pd-row'>
                  <Label className='pd-label' id={this.uid('sbstyle') + '-lbl'}>{messages.scaleBarStyleLabel}</Label>
                  <Tooltip title={messages.scaleBarStyleTip} placement='top'>
                    {this.renderStylePicker('sb', SCALE_BAR_STYLES as any, this.state.sbStyle,
                      (v) => this.setState({ sbStyle: v }), this.uid('sbstyle') + '-lbl', messages.layoutDefault)}
                  </Tooltip>
                </div>
                <div className='pd-row'>
                  <Label className='pd-label' id={this.uid('sbunits') + '-lbl'}>{messages.scaleBarUnitsLabel}</Label>
                  <Tooltip title={messages.scaleBarUnitsTip} placement='top'>
                    <Select id={this.uid('sbunits')} aria-labelledby={this.uid('sbunits') + '-lbl'} size='sm' value={this.state.sbUnits}
                      onChange={(e: any) => this.setState({ sbUnits: e.target.value })}>
                      <option value=''>{messages.layoutDefault}</option>
                      {SCALE_BAR_UNITS.map(u => (
                        <option key={u.value} value={u.value}>{u.label}</option>
                      ))}
                    </Select>
                  </Tooltip>
                </div>
                <div className='pd-row'>
                  <Label className='pd-label' id={this.uid('sbunits2') + '-lbl'}>{messages.scaleBarUnits2Label}</Label>
                  <Tooltip title={messages.scaleBarUnits2Tip} placement='top'>
                    <Select id={this.uid('sbunits2')} aria-labelledby={this.uid('sbunits2') + '-lbl'} size='sm' value={this.state.sbUnits2}
                      aria-describedby={this.uid('sbunits2-desc')}
                      onChange={(e: any) => this.setState({ sbUnits2: e.target.value })}>
                      <option value=''>{messages.dualNone}</option>
                      {SCALE_BAR_UNITS.map(u => (
                        <option key={u.value} value={u.value}>{u.label}</option>
                      ))}
                    </Select>
                  </Tooltip>
                  <div id={this.uid('sbunits2-desc')} className='pd-desc'>{messages.dualHint}</div>
                </div>
              </React.Fragment>
            )}

            {this.ctrl('author') && (
            <div className='pd-row'>
              <Label className='pd-label' id={this.uid('author') + '-lbl'}>{messages.authorLabel}</Label>
              <Tooltip title={messages.authorTip} placement='top'>
                <TextInput id={this.uid('author')} size='sm' aria-labelledby={this.uid('author') + '-lbl'}
                  value={this.state.author} onChange={(e) => this.setState({ author: e.target.value })} />
              </Tooltip>
            </div>
            )}

            {this.ctrl('copyright') && (
            <div className='pd-row'>
              <Label className='pd-label' id={this.uid('copyright') + '-lbl'}>{messages.copyrightLabel}</Label>
              <Tooltip title={messages.copyrightTip} placement='top'>
                <TextInput id={this.uid('copyright')} size='sm' aria-labelledby={this.uid('copyright') + '-lbl'}
                  value={this.state.copyright} onChange={(e) => this.setState({ copyright: e.target.value })} />
              </Tooltip>
            </div>
            )}

            {this.ctrl('legend') && layout && layout.elements && layout.elements.some(e => e.type === 'legend') && (
            <div className='pd-row pd-pa-switch'>
              <Label className='pd-label' id={this.uid('leg') + '-lbl'}>{messages.includeLegendLabel}</Label>
              <Tooltip title={messages.includeLegendTip} placement='top'>
                <Switch aria-labelledby={this.uid('leg') + '-lbl'} checked={this.state.includeLegend}
                  onChange={(e) => this.setState({ includeLegend: e.target.checked })} />
              </Tooltip>
            </div>
            )}

            {this.outSREnabled() && (
            <div className='pd-row'>
              <Label className='pd-label' id={this.uid('wkid') + '-lbl'}>{messages.outSRLabel}</Label>
              <Tooltip title={messages.outSRTip} placement='top'>
                <TextInput size='sm' aria-labelledby={this.uid('wkid') + '-lbl'}
                  placeholder={messages.outSRPh} value={this.state.outWkid}
                  onChange={(e: any) => this.setState({ outWkid: (e.target.value || '').replace(/[^0-9]/g, '') })} />
              </Tooltip>
              <div className='pd-desc'>{messages.outSRHint}</div>
            </div>
            )}

            {this.meMapOnly() && (
            <div className='pd-row pd-pa-switch'>
              <Label className='pd-label' id={this.uid('maponly') + '-lbl'}>{messages.mapOnlyLabel}</Label>
              <Tooltip title={messages.mapOnlyTip} placement='top'>
                <Switch aria-labelledby={this.uid('maponly') + '-lbl'} checked={this.state.mapOnly}
                  onChange={(e) => this.setState({ mapOnly: e.target.checked })} />
              </Tooltip>
            </div>
            )}

            {this.meMapOnly() && this.state.mapOnly && (
            <div className='pd-row'>
              <Label className='pd-label' id={this.uid('mow') + '-lbl'}>{messages.mapOnlySizeLabel}</Label>
              <div style={{ display: 'flex', gap: '.375rem', alignItems: 'center' }}>
                <Tooltip title={messages.mapOnlySizeTip} placement='top'>
                  <TextInput size='sm' aria-labelledby={this.uid('mow') + '-lbl'}
                    placeholder={messages.mapOnlyW} value={this.state.mapOnlyW}
                    onChange={(e: any) => this.setState({ mapOnlyW: (e.target.value || '').replace(/[^0-9]/g, '') })} />
                </Tooltip>
                <span aria-hidden='true'>×</span>
                <Tooltip title={messages.mapOnlySizeTip} placement='top'>
                  <TextInput size='sm' aria-label={messages.mapOnlyH}
                    placeholder={messages.mapOnlyH} value={this.state.mapOnlyH}
                    onChange={(e: any) => this.setState({ mapOnlyH: (e.target.value || '').replace(/[^0-9]/g, '') })} />
                </Tooltip>
              </div>
              <div className='pd-desc'>{messages.mapOnlySizeHint}</div>
            </div>
            )}

            {this.ctrl('fileName') && (
            <div className='pd-row'>
              <Label className='pd-label' id={this.uid('fname') + '-lbl'}>{messages.fileNameLabel}</Label>
              <Tooltip title={messages.fileNameTip} placement='top'>
                <TextInput
                  id={this.uid('fname')} aria-labelledby={this.uid('fname') + '-lbl'}
                  size='sm'
                  value={this.state.fileName}
                  onChange={(e) => this.setState({ fileName: e.target.value })}
                  placeholder='{title}'
                  aria-describedby={this.uid('fname-desc')}
                />
              </Tooltip>
              <div id={this.uid('fname-desc')} className='pd-desc'>{messages.fileNameHint}</div>
            </div>
            )}
            </div>
            )}

            <Tooltip title={this.state.jimuMapView ? messages.exportTip : messages.exportNoMap} placement='top'>
              <Button
                className='pd-export'
                type='primary'
                aria-busy={this.state.busy}
                aria-describedby={!this.state.jimuMapView ? this.uid('export-desc') : undefined}
                disabled={this.state.busy || !this.state.jimuMapView}
                onClick={this.onExport}
              >
                {this.state.busy ? messages.exporting : messages.exportButton}
              </Button>
            </Tooltip>
            {!this.state.jimuMapView && (
              <span id={this.uid('export-desc')} className='pd-sr-only'>{messages.exportNoMap}</span>
            )}

            {this.state.busy && (
              <div className='pd-status' role='status' aria-live='polite'>
                <Loading type={LoadingType.Donut} width={16} height={16} />
                <span>{this.state.status}</span>
              </div>
            )}
            <div role='alert' aria-live='assertive'>
              {this.state.error && (
                <div style={{ marginTop: 8 }}>
                  <Alert type='error' text={this.state.error} withIcon style={{ width: '100%' }} />
                </div>
              )}
            </div>
            <div role='status' aria-live='polite'>
              {this.state.lastResult && (
                <div className='pd-result'><span aria-hidden='true'>✓ </span>{messages.exportComplete}: {this.state.lastResult}</div>
              )}
            </div>
            {this.state.results.length > 0 && (
              <div className='pd-results'>
                <div className='pd-results-head'>
                  <span>{messages.resultsLabel}</span>
                  <Tooltip title={messages.resultsClearTip} placement='top'>
                    <Button size='sm' type='tertiary' className='pd-results-clear'
                      aria-label={messages.resultsClear} onClick={this.clearResults}>{messages.resultsClear}</Button>
                  </Tooltip>
                </div>
                <ul>
                  {this.state.results.map((r, i) => (
                    <li key={r.url + r.name}>
                      <a href={r.url} download={r.name}>{r.name}</a>
                      <span className='pd-results-meta'>{r.meta}</span>
                      <button type='button' className='pd-results-del' title={messages.resultRemove}
                        aria-label={messages.resultRemove + ': ' + r.name}
                        onClick={() => this.removeResult(i)}><span aria-hidden='true'>×</span></button>
                    </li>
                  ))}
                </ul>
              </div>
            )}
          </React.Fragment>
        )}
      </div>
    )
  }
}
