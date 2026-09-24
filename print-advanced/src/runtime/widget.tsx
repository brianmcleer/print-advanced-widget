/** @jsx jsx */
/**
 * Print Advanced - client-side print widget (no print service).
 * Layouts are defined in the widget settings; output is rendered in the
 * browser to PDF with vector page furniture and a high-resolution map capture.
 * Author: Brian McLeer, City of Grand Junction
 */
import { React, AllWidgetProps, jsx, css, WidgetState, getAppStore } from 'jimu-core'
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
import Polygon from 'esri/geometry/Polygon'
import * as reactiveUtils from 'esri/core/reactiveUtils'
import { metersPerMapUnit, printExtent, extentRings, extentFitScale, resolvePrintedScale } from './lib/scaleMath'
import defaultMessages from './translations/default'
import { renderLayout, OutputFormat, FORMAT_LABELS, RenderOptions, lookupEsriWkt, renderPagePreview, NORTH_ARROW_STYLES, SCALE_BAR_STYLES, SCALE_BAR_UNITS, FONT_FAMILIES, computeLegendPanel, harvestLegendDom, findLegendDom, LEGEND_DEFAULTS, layoutLegend, resolveLegendCorner, renderSeries, seriesPageTitle, getPointProjector, SelectionGeometry, SeriesStep } from './lib/pdfRenderer'
import { gridTilesByCount, envelopeForFrame, featurePageTiles, FeaturePageInput } from './lib/seriesMath'
import { CalciteIcon } from 'calcite-components'
import HelpPopup from './components/HelpPopup'
import FirstRunHint from './components/FirstRunHint'
import PagePreview from './components/PagePreview'
import { buildHelpSections } from './helpSections'
import { beacon } from '../shared/beacon'
import type { BeaconHandle } from '../shared/beacon'

const printIcon = require('./assets/icons/icon.svg')

/** Stamped on every graphic THIS widget puts on the map (print-extent
 *  preview, map series page outlines and numbers). The selection sweep walks
 *  view.graphics to find what the user has highlighted, and without a marker
 *  it would print the widget's own preview rectangle back onto the page. */
const PD_OWN = { __printAdvancedOwn: 1 }
const isOwnGraphic = (g: any): boolean => {
  try { return !!(g && g.attributes && g.attributes.__printAdvancedOwn) } catch (e) { return false }
}

/** Experience Builder's data source registry, which is how the Select,
 *  Table and Query widgets record what the user has highlighted.
 *
 *  Read lazily off the module rather than imported by name on purpose. The
 *  widget declares four dependencies and nothing else, and a named import
 *  that a given Experience Builder build does not expose fails the whole
 *  bundle. Reading it here means the worst case is that data source
 *  selections are not found, while a clicked feature and app graphics still
 *  print. */
const dataSourceList = (): any[] => {
  try {
    const core: any = require('jimu-core')
    const dsm = core && core.DataSourceManager
    if (!dsm || typeof dsm.getInstance !== 'function') return []
    const all = dsm.getInstance().getDataSources()
    return Array.isArray(all) ? all : Object.keys(all || {}).map(k => all[k])
  } catch (e) { return [] }
}

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
  /** short neutral note under Export (e.g. a cancelled series) */
  note: string
  lastResult: string | null
  author: string
  copyright: string
  includeLegend: boolean
  showOverview: boolean
  showGrid: boolean
  includeSelection: boolean
  legendPositionOv: string
  gridTypeOv: string
  /** per-user grid style over the layout's grid (JSON of Partial<GridConfig>; '' = layout) */
  gridStyleJson: string
  gridStyleOpen: boolean
  /** per-user open/closed state of the Advanced options cards (JSON) */
  cardsOpenJson: string
  legendHint: { level: 'tight' | 'cramped', count: number, missed: number, fontPt: number } | null
  legendHintDismissed: boolean
  legendPosUserSet: boolean
  qrOn: boolean
  seriesOpen: boolean
  seriesRows: string
  seriesSizePct: string
  seriesCols: string
  /** 'grid' = pages cut from the view; 'features' = one page per feature */
  seriesMode: string
  /** live map series progress while a series exports (null otherwise) */
  seriesStep: SeriesStep | null
  seriesLayerId: string
  seriesNameField: string
  /** data-driven page order by the name field: false = A to Z */
  seriesSortDesc: boolean
  /** 'view' = features in the current map view; 'all' = whole layer */
  seriesScope: string
  /** 'fit' = best fit per feature; 'fixed' = one scale for every page */
  seriesScaleMode: string
  seriesMargin: string
  seriesFixedScale: string
  featCount: number | null
  featLoading: boolean
  /** live page preview in the panel */
  pagePreviewOn: boolean
  pagePreviewUrl: string
  pagePreviewBusy: boolean
  pagePreviewNote: string
  legendAutoPaged: boolean
  mapOnly: boolean
  mapOnlyW: string
  mapOnlyH: string
  georeference: boolean
  googleEarthKmz: boolean
  svcTemplate: string
  svcScalePreserved: boolean
  svcForceAttrs: boolean
  outWkid: string
  helpOpen: boolean
  helpHintDismissed: boolean
  results: Array<{ name: string, url: string, meta: string }>
}

/** Browser key for the first-run help hint, so a user is offered the guide
 *  once and never nagged again. Namespaced by widget so two Print Advanced
 *  widgets in one app do not share a dismissal. */
const HELP_HINT_KEY = 'printAdvanced.helpHintDismissed'
const readHelpHint = (widgetId: string): boolean => {
  try { return window.localStorage.getItem(HELP_HINT_KEY + '.' + widgetId) === '1' } catch (e) { return false }
}
const writeHelpHint = (widgetId: string): void => {
  try { window.localStorage.setItem(HELP_HINT_KEY + '.' + widgetId, '1') } catch (e) { /* private browsing */ }
}

export default class Widget extends React.PureComponent<AllWidgetProps<IMConfig>, State> {
  // Editor-only (EB 1.21 + pnpm): some Visual Studio TypeScript hosts fail
  // to resolve the React base-class types for this file, flooding the Error
  // List with "props/state/setState does not exist on type 'Widget'". These
  // `declare` members emit NO JavaScript and change NO behavior; they restate
  // what React.PureComponent already provides so the editor is satisfied.
  // Mirrors the same shim on the settings Setting class.
  // The intersection restates members VS can drop when it resolves
  // AllWidgetProps partially (id, useMapWidgetIds live on an intersected
  // interface). With full types the intersection is a no-op.
  declare readonly props: AllWidgetProps<IMConfig> & { id: string, useMapWidgetIds?: any }
  declare state: State
  declare setState: (partial: any, callback?: () => void) => void
  declare forceUpdate: (callback?: () => void) => void

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
      note: '',
      lastResult: null,
      author: cfgAny.defaultAuthor || ((this.props as any).user && (this.props as any).user.username) || '',
      copyright: cfgAny.defaultCopyright || '',
      // toggles honor admin defaults from runtimeDefaults; on unless set off
      includeLegend: (d as any).includeLegend !== false,
      showOverview: (d as any).showOverview !== false,
      showGrid: (d as any).showGrid !== false,
      includeSelection: (d as any).includeSelection !== false,
      legendPositionOv: '',
      gridTypeOv: '',
      gridStyleJson: '',
      gridStyleOpen: false,
      cardsOpenJson: '',
      legendHint: null,
      legendHintDismissed: false,
      legendPosUserSet: false,
      qrOn: false,
      seriesOpen: false,
      seriesRows: '2',
      seriesSizePct: '100',
      seriesCols: '2',
      seriesMode: 'grid',
      seriesLayerId: '',
      seriesStep: null,
      seriesNameField: '',
      seriesSortDesc: false,
      seriesScope: 'view',
      seriesScaleMode: 'fit',
      seriesMargin: '10',
      seriesFixedScale: '1200',
      featCount: null,
      featLoading: false,
      pagePreviewOn: false,
      pagePreviewUrl: '',
      pagePreviewBusy: false,
      pagePreviewNote: '',
      legendAutoPaged: false,
      mapOnly: false,
      mapOnlyW: '',
      mapOnlyH: '',
      georeference: false,
      googleEarthKmz: false,
      svcTemplate: '',
      svcScalePreserved: false,
      svcForceAttrs: false,
      outWkid: cfgAny.defaultOutputWkid ? String(cfgAny.defaultOutputWkid) : '',
      helpOpen: false,
      // Cast is editor-only, same reason as the `declare readonly props`
      // shim below: the shim covers `this.props`, but this is the raw
      // CONSTRUCTOR parameter, and some Visual Studio TypeScript hosts
      // resolve AllWidgetProps only partially there (reporting it as
      // AllWidgetProps<ImmutableObject<T>> with T unbound), so every
      // property read on it errors. Emits no JavaScript.
      helpHintDismissed: readHelpHint((props as any).id),
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
      case 'alternating2':
        g = <React.Fragment>
          {[0,1,2,3].map(i => <rect key={i} x={x0 + i*seg} y={15} width={seg} height={7} fill={i % 2 === 0 ? c : 'none'} stroke={c} strokeWidth={1} />)}
          {[0,1,2,3,4].map(i => <line key={'t'+i} x1={x0 + i*seg} y1={15} x2={x0 + i*seg} y2={11} stroke={c} strokeWidth={1} />)}
        </React.Fragment>; break
      case 'line2':
        g = <React.Fragment>
          <line x1={x0} y1={13} x2={x1} y2={13} stroke={c} strokeWidth={1} />
          {[0,1,2,3,4].map(i => <line key={i} x1={x0+i*seg} y1={13} x2={x0+i*seg} y2={20} stroke={c} strokeWidth={1} />)}
          <line x1={x0+4} y1={24} x2={x0+10} y2={24} stroke={c} strokeWidth={1.6} />
          <line x1={30} y1={24} x2={36} y2={24} stroke={c} strokeWidth={1.6} />
        </React.Fragment>; break
      case 'scaleLine2':
        g = <React.Fragment>
          <line x1={x0} y1={17} x2={x1} y2={17} stroke={c} strokeWidth={1} />
          {[0,1,2,3,4].map(i => <line key={i} x1={x0+i*seg} y1={13} x2={x0+i*seg} y2={21} stroke={c} strokeWidth={1} />)}
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
      case 'line': // 'line' tile bottom baseline, ticks rise (matches render)
        g = <React.Fragment>
          <line x1={x0} y1={21} x2={x1} y2={21} stroke={c} strokeWidth={1} />
          {[0,1,2,3,4].map(i => <line key={i} x1={x0+i*seg} y1={21} x2={x0+i*seg} y2={14} stroke={c} strokeWidth={1} />)}
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
  private seriesGraphics: any[] = []
  private busyStart = 0
  private busyTimer: any = null

  private beginBusyClock = (): void => {
    this.busyStart = Date.now()
    if (this.busyTimer) clearInterval(this.busyTimer)
    this.busyTimer = setInterval(() => { if (this.state.busy) this.forceUpdate(); else { clearInterval(this.busyTimer); this.busyTimer = null } }, 1000)
  }
  private seriesPreviewView: any = null

  /** Live map series preview: numbered page outlines on the map that
   *  follow panning, zooming, and every rows/columns change, so the
   *  atlas is visible BEFORE it is exported. */
  clearSeriesPreview = (): void => {
    try {
      const v: any = this.seriesPreviewView || (this.state.jimuMapView && this.state.jimuMapView.view)
      if (v) for (const g of this.seriesGraphics) { try { v.graphics.remove(g) } catch (e) { /* noop */ } }
    } catch (e) { /* noop */ }
    this.seriesGraphics = []
    this.seriesPreviewView = null
  }

  private seriesHighlight: any = null

  /** Light up the page currently being captured, so users watch the
   *  export march across the map page by page. */
  /* map series progress: sheet timing for the time-left estimate */
  private seriesSheetStart = 0
  private seriesCancelled = false
  /** the last page query could not sort on the server */
  private featUnsorted = false
  private seriesSheetsDone = 0

  private onSeriesStep = (st: SeriesStep): void => {
    if (st.kind === 'sheet') {
      if (!this.seriesSheetStart) this.seriesSheetStart = Date.now()
      this.seriesSheetsDone = st.done
    }
    this.setState({ seriesStep: st })
  }

  /** Time left, from the average finished sheet (index page counts as one). */
  seriesTimeLeft = (st: SeriesStep): string => {
    if (!this.seriesSheetStart || this.seriesSheetsDone < 1) return ''
    const per = (Date.now() - this.seriesSheetStart) / this.seriesSheetsDone
    const left = Math.max(0, st.pageCount - this.seriesSheetsDone) + (st.kind === 'sheet' ? 1 : 0)
    if (st.kind !== 'sheet' || left <= 0) return ''
    const sec = Math.round((per * left) / 1000)
    if (sec < 60) return String((defaultMessages as any).seriesStepEtaSec || '').replace('{s}', String(Math.max(5, Math.round(sec / 5) * 5)))
    return String((defaultMessages as any).seriesStepEtaMin || '').replace('{m}', String(Math.round(sec / 60)))
  }

  seriesStepHeadline = (st: SeriesStep, messages: any): string => {
    if (st.kind === 'sheet') {
      const base = String(messages.seriesStepPage).replace('{i}', String(st.page)).replace('{n}', String(st.pageCount))
      return st.name ? base + ': ' + st.name : base
    }
    if (st.kind === 'index') return messages.seriesStepIndex
    if (st.kind === 'prep') return messages.seriesStepPrep
    if (st.kind === 'legend') return String(messages.seriesStepLegend).replace('{i}', String(st.page)).replace('{n}', String(st.pageCount))
    return messages.seriesStepSave
  }

  /** The busy row for a map series: page headline, segmented bar (one
   *  segment per printed page; a plain bar past 60 pages), the sub-step,
   *  done count, elapsed time and time left. */
  renderSeriesProgress = (st: SeriesStep, messages: any, elapsed: string): React.ReactNode => {
    const headline = this.seriesStepHeadline(st, messages)
    const pct = st.total > 0 ? Math.round((st.done / st.total) * 100) : 0
    const eta = this.seriesTimeLeft(st)
    const sub = String(this.state.status || '')
    const showSub = sub && !/^Exporting page \d+ of \d+/i.test(sub) && !/^Creating index page/i.test(sub) && !/^Saving PDF/i.test(sub)
    const segs = st.total <= 60
    const count = String(messages.seriesStepCount).replace('{done}', String(st.done)).replace('{total}', String(st.total))
    return (
      <li className='pd-q-row pd-q-active pd-q-busy pd-sp'>
        <div className='pd-q-busyline'>
          <Loading type={LoadingType.Donut} width={14} height={14} />
          <span className='pd-q-name pd-sp-head'>{headline}</span>
          <span className='pd-q-meta' aria-hidden='true'>{elapsed}</span>
        </div>
        <div className='pd-sp-track' role='progressbar' aria-label={messages.seriesStepProgress}
          aria-valuemin={0} aria-valuemax={st.total} aria-valuenow={st.done} aria-valuetext={headline + ', ' + count}>
          {segs
            ? Array.from({ length: st.total }).map((_, k) => (
              <span key={k} className={'pd-sp-seg' + (k < st.done ? ' is-done' : k === st.done ? ' is-active' : '')} />
            ))
            : <span className='pd-sp-fill' style={{ width: pct + '%' }} />}
        </div>
        <div className='pd-sp-foot'>
          <span aria-hidden='true'>{count} ({pct}%)</span>
          {eta && <span aria-hidden='true'>{eta}</span>}
        </div>
        {showSub && <div className='pd-sp-sub' aria-hidden='true'>{sub}</div>}
        <div className='pd-sp-actions'>
          <Button size='sm' type='tertiary' disabled={this.seriesCancelled}
            onClick={() => { this.seriesCancelled = true; this.setState({ status: messages.seriesCancelling }) }}>
            {this.seriesCancelled ? messages.seriesCancelling : messages.seriesCancel}
          </Button>
        </div>
        <div className='pd-sr-only' aria-live='polite'>{headline}</div>
      </li>
    )
  }

  highlightSeriesTile = (tiles: any[], idx: number): void => {
    try {
      const view: any = this.state.jimuMapView && this.state.jimuMapView.view
      if (!view) return
      if (this.seriesHighlight) { try { view.graphics.remove(this.seriesHighlight) } catch (e) { /* noop */ } this.seriesHighlight = null }
      const t = tiles[idx - 1]
      if (!t) return
      const rings = [[t.xmin, t.ymin], [t.xmax, t.ymin], [t.xmax, t.ymax], [t.xmin, t.ymax], [t.xmin, t.ymin]]
      this.seriesHighlight = new Graphic({
        geometry: { type: 'polygon', rings: [rings], spatialReference: view.spatialReference } as any,
        symbol: { type: 'simple-fill', color: [235, 110, 20, 0.3], outline: { color: [225, 75, 10, 1], width: 3, style: 'solid' } } as any,
        attributes: { ...PD_OWN }
      })
      view.graphics.add(this.seriesHighlight)
      this.seriesGraphics.push(this.seriesHighlight)
    } catch (e) { /* highlight is best-effort */ }
  }

  updateSeriesPreview = (): void => {
    if (!this.uiVisible) return
    try {
      const view: any = this.state.jimuMapView && this.state.jimuMapView.view
      const layout = this.getSelectedLayout()
      // data-driven pages: keep the feature count current whatever its size,
      // so the panel, the limit notes and Export never go stale
      if (view && layout && this.seriesActive() && this.seriesFeatures()) {
        const fl = this.featLayer()
        if (fl && (!this.featCache || this.featCache.key !== this.featKey(view, fl))) { this.clearSeriesPreview(); this.refreshFeaturePages(); return }
      }
      const active = !!view && !!layout && this.seriesActive() && !this.seriesBlocked()
      this.clearSeriesPreview()
      if (!active) return
      const mfEl: any = (layout.elements || []).find((e: any) => e.type === 'mapFrame')
      if (!mfEl) return
      // the grid must mirror the EXPORT frame: shrunk when an adjacent
      // legend panel is active, exactly like the single-map print-extent
      // preview, so the series grid adjusts dynamically with the legend
      const mf: any = this.effFrameOf() || mfEl
      const ext = view.extent
      const rows = Math.max(1, Math.min(8, parseInt(this.state.seriesRows, 10) || 1))
      const cols = Math.max(1, Math.min(8, parseInt(this.state.seriesCols, 10) || 1))
      let tiles: any[]
      let fontPx: number
      if (this.seriesFeatures()) {
        // data-driven pages: fetched asynchronously; a stale or missing
        // cache starts a fetch that redraws this preview when it lands
        const layer = this.featLayer()
        if (!layer) return
        const key = this.featKey(view, layer)
        if (!this.featCache || this.featCache.key !== key) { this.refreshFeaturePages(); return }
        tiles = this.featTilesFor(view, mf.wIn, mf.hIn, this.featCache.feats)
        fontPx = 16
      } else {
        const env = this.seriesScaleEnv(envelopeForFrame(
          { xmin: ext.xmin, ymin: ext.ymin, xmax: ext.xmax, ymax: ext.ymax },
          rows, cols, mf.wIn, mf.hIn, 0.1))
        tiles = gridTilesByCount(env, rows, cols, mf.wIn, mf.hIn, 0.1)
        fontPx = Math.max(12, Math.min(28, 220 / Math.max(rows, cols)))
      }
      const sr = view.spatialReference
      for (const t of tiles) {
        const rings = [[t.xmin, t.ymin], [t.xmax, t.ymin], [t.xmax, t.ymax], [t.xmin, t.ymax], [t.xmin, t.ymin]]
        const geometry: any = { type: 'polygon', rings: [rings], spatialReference: sr }
        // white casing UNDER the dashed stroke: readable on aerial imagery
        const casing = new Graphic({
          geometry,
          symbol: {
            type: 'simple-fill',
            color: [0, 0, 0, 0],
            outline: { color: [255, 255, 255, 0.95], width: 4.5, style: 'solid' }
          } as any,
          attributes: { ...PD_OWN }
        })
        const outline = new Graphic({
          geometry,
          symbol: {
            type: 'simple-fill',
            color: [235, 110, 20, 0.08],
            outline: { color: [225, 75, 10, 1], width: 2.4, style: 'dash' }
          } as any,
          attributes: { ...PD_OWN }
        })
        const num = new Graphic({
          geometry: { type: 'point', x: t.centerX, y: t.centerY, spatialReference: sr } as any,
          symbol: {
            type: 'text',
            text: String(t.page),
            color: [200, 50, 10, 1],
            haloColor: [255, 255, 255, 1],
            haloSize: 3,
            font: { size: Math.round(fontPx * 1.15), weight: 'bold' }
          } as any,
          attributes: { ...PD_OWN }
        })
        view.graphics.add(casing)
        view.graphics.add(outline)
        view.graphics.add(num)
        this.seriesGraphics.push(casing, outline, num)
      }
      this.seriesPreviewView = view
    } catch (e) { /* preview is best-effort */ }
  }
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
  /** Formats that carry a world file (so georeferencing is offered). */
  rasterFormat = (f: string): boolean => f === 'png32' || f === 'png8' || f === 'jpg' || f === 'tiff' || f === 'gif'

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

  /** Last legend panel actually computed during an export, so the live
   *  print-extent preview matches the shrunken frame exactly next time. */
  private lastPanel: { position: string, wIn: number, hIn: number } | null = null

  /** Live panel sizing: measure the Legend widget's DOM (labels only, no
   *  swatch extraction) and run the export's own panel math, so the print
   *  extent preview is exact BEFORE the first export. */
  private estimateSeq = 0
  private estimatePanel = async (): Promise<void> => {
    try {
      const seq = ++this.estimateSeq
      const layout: any = this.getSelectedLayout()
      const lc = layout && layout.legend
      let pos = this.state.legendPositionOv || String((lc && lc.position) || '')
      // auto-default to additional pages: while the auto flag holds, keep
      // evaluating the underlying placement so we can revert when it fits
      const autoHolding = this.state.legendAutoPaged && !this.state.legendPosUserSet &&
          this.state.legendPositionOv === 'secondPage'
      if (autoHolding) pos = String((lc && lc.position) || '')
      const isPanel = pos.endsWith('Panel')
      const isOverlay = pos === 'topLeft' || pos === 'topRight' || pos === 'bottomLeft' || pos === 'bottomRight'
      if (!lc || !lc.enabled || !this.state.includeLegend || (!isPanel && !isOverlay) ||
          (this.meMapOnly() && this.state.mapOnly)) {
        this.lastPanel = null
        if (this.state.legendHint) this.setState({ legendHint: null })
        // estimator preview guards: never draw the graphic while preview is off
        if (this.state.previewOn) this.updatePreview()
        return
      }
      const dom = findLegendDom(String((this.cfg() as any).legendWidgetId || '') || undefined)
      if (!dom) { if (this.state.previewOn) this.updatePreview(); return }
      const rows = await harvestLegendDom(dom, true)
      if (seq !== this.estimateSeq) return
      if (!rows.length) { if (this.state.previewOn) this.updatePreview(); return }
      const mf = this.frameOf()
      if (!mf) return
      const others = ((layout.elements || []) as any[])
        .filter((e: any) => e.type !== 'mapFrame' && e.type !== 'line' && typeof e.xIn === 'number' && e.wIn > 0 && e.hIn > 0)
        .map((e: any) => ({ xIn: e.xIn, yIn: e.yIn, wIn: e.wIn, hIn: e.hIn }))
      const cfg: any = { ...LEGEND_DEFAULTS, ...(JSON.parse(JSON.stringify(lc))), position: pos }
      const approx = (txt: string, f: number): number => (txt || '').length * f * 0.52
      const itemCount = rows.filter(r => r.kind === 'item').length
      const evalHint = (wIn: number, hIn: number): void => {
        try {
          const fit = layoutLegend(rows, wIn * 72, hIn * 72, cfg, approx)
          let hint: State['legendHint'] = null
          if (fit.truncated > 0 || fit.fontPt <= 6) {
            hint = { level: 'cramped', count: itemCount, missed: fit.truncated, fontPt: fit.fontPt }
          } else if (fit.fontPt < 8 || itemCount >= 40) {
            hint = { level: 'tight', count: itemCount, missed: 0, fontPt: fit.fontPt }
          }
          const prev = this.state.legendHint
          const same = (!hint && !prev) || (hint && prev && hint.level === prev.level && hint.count === prev.count && hint.missed === prev.missed)
          if (!same) this.setState({ legendHint: hint })
          // default to additional pages when items would actually drop
          // (PDF only; explicit user placements are always respected)
          const wouldDrop = !!hint && hint.level === 'cramped' && hint.missed > 0
          if (!this.state.legendPosUserSet && this.state.format === 'pdf') {
            if (wouldDrop && this.state.legendPositionOv !== 'secondPage') {
              this.setState({ legendPositionOv: 'secondPage', legendAutoPaged: true })
            } else if (this.state.legendAutoPaged && !wouldDrop && this.state.legendPositionOv === 'secondPage') {
              this.setState({ legendPositionOv: '', legendAutoPaged: false })
            }
          }
        } catch (e) { /* hint is best-effort */ }
      }
      if (isOverlay) {
        // overlay boxes are small and fixed; evaluate the configured box
        this.lastPanel = null
        const wIn = Number(cfg.widthIn) > 0 ? Number(cfg.widthIn) : 2.5
        const hIn = Number(cfg.heightIn) > 0 ? Number(cfg.heightIn) : 2
        evalHint(wIn, hIn)
        if (this.state.previewOn) this.updatePreview()
        return
      }
      const panel = computeLegendPanel(rows, mf, cfg, others)
      if (panel && panel.box.wIn > 0.9 && panel.box.hIn > 0.9) {
        this.lastPanel = { position: pos, wIn: panel.box.wIn, hIn: panel.box.hIn }
        // smart indicator: if fitting the panel means heavy shrink or
        // truncation, suggest the additional-pages placement
        evalHint(panel.box.wIn, panel.box.hIn)
      }
      if (this.state.previewOn) this.updatePreview()
    } catch (e) { /* preview sizing is best-effort */ }
  }

  /** The frame the export will really use: shrunk when an adjacent legend
   *  panel is active. Fixed panels are exact; auto panels use the last
   *  export's computed size, falling back to a sensible estimate. */
  private effFrameOf = (): any => {
    const mf = this.frameOf()
    if (!mf) return null
    // map-only: layout furniture is skipped, so the legend panel never
    // shrinks the frame; explicit pixel output changes the aspect (96 dpi)
    if (this.meMapOnly() && this.state.mapOnly) {
      const w = Number(this.state.mapOnlyW)
      const h = Number(this.state.mapOnlyH)
      if (w > 0 && h > 0) return { ...mf, wIn: w / 96, hIn: h / 96 }
      return mf
    }
    const layout: any = this.getSelectedLayout()
    const lc = layout && layout.legend
    if (!lc || !lc.enabled || !this.state.includeLegend) return mf
    const pos = this.state.legendPositionOv || String(lc.position || '')
    if (!pos.endsWith('Panel')) return mf
    const gap = 0.08
    if (pos === 'bottomPanel') {
      let h = lc.panelSizeMode === 'fixed' && Number(lc.heightIn) > 0 ? Number(lc.heightIn)
        : (this.lastPanel && this.lastPanel.position === pos ? this.lastPanel.hIn : 1.5)
      h = Math.min(mf.hIn * 0.45, Math.max(0.8, h))
      return { ...mf, hIn: mf.hIn - h - gap }
    }
    let w = lc.panelSizeMode === 'fixed' && Number(lc.widthIn) > 0 ? Number(lc.widthIn)
      : (this.lastPanel && this.lastPanel.position === pos ? this.lastPanel.wIn : 2.5)
    w = Math.min(mf.wIn * 0.45, Math.max(1.4, w))
    return pos === 'leftPanel'
      ? { ...mf, xIn: mf.xIn + w + gap, wIn: mf.wIn - w - gap }
      : { ...mf, wIn: mf.wIn - w - gap }
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

  /** The current single-page print area as a polygon in the view's
   *  coordinate system (rotation included), or null. */
  printAreaPolygon = (view: any): any => {
    try {
      const mf = this.effFrameOf()
      if (!view || !mf) return null
      let scale: number, center: { x: number, y: number }
      if (this.state.locked && this.lockedScale && this.lockedCenter) {
        scale = this.lockedScale; center = this.lockedCenter
      } else {
        const r = this.computeScaleCenter(view, mf); scale = r.scale; center = r.center
      }
      const mpu = metersPerMapUnit(view.scale, view.resolution)
      const ext = printExtent(center.x, center.y, mpu, mf.wIn, mf.hIn, scale)
      const rings = extentRings(ext, center.x, center.y, view.rotation || 0)
      return { type: 'polygon', rings: [rings], spatialReference: view.spatialReference }
    } catch (e) { return null }
  }

  updatePreview = (): void => {
    if (!this.uiVisible) return
    // while the map series panel is open, the series grid IS the print
    // area; the single-page rectangle contradicts it, so it yields
    // (except data-driven pages limited to the print area: that rectangle
    // is then the filter, so it stays on the map)
    const ddpFrame = this.ddpFrameActive()
    if (!this.state.previewOn && !ddpFrame) { this.clearPreview(); return }
    if (this.state.seriesOpen && this.ctrl('series') && this.state.format === 'pdf' && !ddpFrame) {
      this.clearPreview()
      return
    }
    try {
      const jmv = this.state.jimuMapView
      const view: any = jmv && jmv.view
      const mf = this.effFrameOf()
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
        this.previewGraphic = new Graphic({ geometry, symbol, attributes: { ...PD_OWN } })
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
        () => {
          if ((this.state.previewOn || this.ddpFrameActive()) && !this.state.locked) this.updatePreview()
          // Inside the print area: moving the map moves the filter
          if (this.ddpFrameActive()) this.queueEstimate()
        }
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
    // panel closes: the print-extent graphic must leave the map with it;
    // reopening restores it if the preview toggle is still on
    const wState: any = (this.props as any).state
    const prevWState: any = (_prevProps as any).state
    if (wState !== prevWState) {
      if (wState === WidgetState.Closed) {
        this.clearPreview()
        this.clearSeriesPreview()
        this.stopPreviewWatch()
      } else if (prevWState === WidgetState.Closed && view) {
        if (s.previewOn) { this.startPreviewWatch(view); this.updatePreview() }
        this.updateSeriesPreview()
      }
    }
    if (s.jimuMapView !== prevState.jimuMapView && view) {
      this.startLegendWatch(view)
      void this.estimatePanel()
    }
    // live page preview: redraw whenever anything that shows on the page changes
    if (s.pagePreviewOn && this.pagePreviewSig() !== this.lastPreviewSig) this.queuePagePreview()
    if (s.pagePreviewOn !== prevState.pagePreviewOn && !s.pagePreviewOn) this.setState({ pagePreviewUrl: '', pagePreviewNote: '' })
    if (s.jimuMapView !== prevState.jimuMapView && view && s.previewOn) {
      this.startPreviewWatch(view); this.updatePreview()
    }
    if (s.previewOn !== prevState.previewOn) {
      if (s.previewOn && view) { this.startPreviewWatch(view); this.updatePreview() }
      else { this.clearPreview(); this.stopPreviewWatch() }
    }
    if (s.previewOn && view && (
      s.scaleMode !== prevState.scaleMode || s.fixedScale !== prevState.fixedScale ||
      s.selectedLayoutId !== prevState.selectedLayoutId || s.locked !== prevState.locked ||
      s.includeLegend !== prevState.includeLegend ||
      s.legendPositionOv !== prevState.legendPositionOv ||
      s.mapOnly !== prevState.mapOnly ||
      s.mapOnlyW !== prevState.mapOnlyW ||
      s.mapOnlyH !== prevState.mapOnlyH)) {
      this.updatePreview()
    }
    // legend-affecting changes re-measure from the live Legend widget:
    // estimator runs regardless of preview so the fit hint always works,
    // and preview accuracy comes along whenever preview is on
    if (view && (
      s.includeLegend !== prevState.includeLegend ||
      s.legendPositionOv !== prevState.legendPositionOv ||
      s.selectedLayoutId !== prevState.selectedLayoutId ||
      s.mapOnly !== prevState.mapOnly ||
      s.jimuMapView !== prevState.jimuMapView ||
      s.format !== prevState.format ||
      (s.previewOn && !prevState.previewOn))) {
      void this.estimatePanel()
    }
    if (s.selectedLayoutId !== prevState.selectedLayoutId &&
        (s.legendPosUserSet || s.legendAutoPaged)) {
      this.setState({ legendPosUserSet: false, legendAutoPaged: false, legendPositionOv: '' })
    }
    if ((Widget as any).PREF_KEYS.some((k: string) => (s as any)[k] !== (prevState as any)[k])) {
      this.savePrefsSoon()
    }
    if (s.seriesOpen !== prevState.seriesOpen) {
      this.updatePreview()
    }
    if (s.seriesOpen !== prevState.seriesOpen ||
        s.seriesSizePct !== prevState.seriesSizePct ||
        s.seriesRows !== prevState.seriesRows || s.seriesCols !== prevState.seriesCols ||
        s.seriesMode !== prevState.seriesMode || s.seriesLayerId !== prevState.seriesLayerId ||
        s.seriesNameField !== prevState.seriesNameField || s.seriesScope !== prevState.seriesScope || s.seriesSortDesc !== prevState.seriesSortDesc ||
        s.seriesScaleMode !== prevState.seriesScaleMode || s.seriesMargin !== prevState.seriesMargin ||
        s.seriesFixedScale !== prevState.seriesFixedScale ||
        s.scaleMode !== prevState.scaleMode || s.fixedScale !== prevState.fixedScale || s.locked !== prevState.locked ||
        s.format !== prevState.format || s.selectedLayoutId !== prevState.selectedLayoutId) {
      this.updateSeriesPreview()
    }
    // Inside the print area: the rectangle is the filter, so it is drawn and
    // follows the map even when Show print area is off
    const ddpNow = this.ddpFrameActive()
    const ddpWas = !!prevState.seriesOpen && this.ctrl('series') && prevState.format === 'pdf' && prevState.seriesMode === 'features' && prevState.seriesScope === 'frame'
    if (ddpNow !== ddpWas && view) {
      if (ddpNow) { this.startPreviewWatch(view); this.updatePreview() }
      else if (!s.previewOn) { this.clearPreview(); this.stopPreviewWatch() }
      else this.updatePreview()
    }
    // a new context deserves a fresh suggestion
    if (s.legendHintDismissed && (
      s.selectedLayoutId !== prevState.selectedLayoutId ||
      s.legendPositionOv !== prevState.legendPositionOv ||
      s.includeLegend !== prevState.includeLegend)) {
      this.setState({ legendHintDismissed: false })
    }
  }

  /** The widget's rendered visibility. Sidebar collapse and some panel
   *  containers hide the widget's DOM WITHOUT setting WidgetState.Closed,
   *  so the print-extent preview must track real on-screen visibility:
   *  hidden -> graphic leaves the map; visible again -> restored if the
   *  preview toggle is still on. */
  private uiVisible = true
  private rootRef: any = React.createRef()
  private visObserver: any = null
  private beacon: BeaconHandle | null = null

  componentDidMount (): void {
    this.beacon = beacon.init(this.props)
    try {
      if (typeof (window as any).IntersectionObserver === 'function' && this.rootRef.current) {
        this.visObserver = new (window as any).IntersectionObserver((entries: any[]) => {
          const vis = !!(entries && entries.length && entries[entries.length - 1].isIntersecting)
          if (vis === this.uiVisible) return
          this.uiVisible = vis
          const view: any = this.state.jimuMapView && this.state.jimuMapView.view
          if (!vis) {
            this.clearPreview()
            this.clearSeriesPreview()
            this.stopPreviewWatch()
          } else if (this.state.previewOn && view) {
            this.startPreviewWatch(view)
            this.updatePreview()
          }
        })
        this.visObserver.observe(this.rootRef.current)
      }
    } catch (e) { /* observer is best-effort; Closed-state handling remains */ }
    // restore this person's saved choices over the seeded defaults
    const saved = this.loadPrefs()
    const patch: any = {}
    for (const k of (Widget as any).PREF_KEYS) {
      if ((typeof saved[k] === 'string' || typeof saved[k] === 'boolean') && saved[k] !== (this.state as any)[k]) patch[k] = saved[k]
    }
    if (Object.keys(patch).length) this.setState(patch)
  }

  componentWillUnmount (): void {
    if (this.visObserver) { try { this.visObserver.disconnect() } catch (e) { /* noop */ } this.visObserver = null }
    this.clearPreview(); this.clearSeriesPreview(); this.stopPreviewWatch()
    this.stopLegendWatch()
    this.revokeResultUrls(this.state.results)
  }

  /** Legend responds to what is on the map: watch layer visibility so the
   *  fit estimate (and the auto additional-pages hold) never goes stale. */
  private legendWatchHandles: any[] = []
  private legendLayerHandles: any[] = []
  private legendWatchTimer: any = null

  private queueEstimate = (): void => {
    if (this.legendWatchTimer) clearTimeout(this.legendWatchTimer)
    this.legendWatchTimer = setTimeout(() => {
      void this.estimatePanel()
      // the data-driven page layer list follows what is turned on
      if (this.state.seriesOpen && this.seriesFeatures()) this.forceUpdate()
      this.updateSeriesPreview(); this.queuePagePreview()
    }, 400)
  }

  private stopLegendWatch = (): void => {
    if (this.legendWatchTimer) { clearTimeout(this.legendWatchTimer); this.legendWatchTimer = null }
    for (const h of this.legendLayerHandles) { try { h.remove() } catch (e) { /* noop */ } }
    for (const h of this.legendWatchHandles) { try { h.remove() } catch (e) { /* noop */ } }
    this.legendLayerHandles = []
    this.legendWatchHandles = []
  }

  private startLegendWatch = (view: any): void => {
    this.stopLegendWatch()
    try {
      const bindLayers = (): void => {
        for (const h of this.legendLayerHandles) { try { h.remove() } catch (e) { /* noop */ } }
        this.legendLayerHandles = []
        try {
          const w = (fn: () => any): void => {
            try { this.legendLayerHandles.push(reactiveUtils.watch(fn, this.queueEstimate)) } catch (e) { /* not watchable */ }
          }
          view.map.allLayers.forEach((l: any) => {
            if (!l) return
            // visibility, and a filter set from Map Layers (or any widget),
            // re-count the data-driven pages
            w(() => l.visible)
            w(() => l.definitionExpression)
            // map image sublayers turn on and off on their own
            if (l.type === 'map-image' && l.allSublayers && typeof l.allSublayers.forEach === 'function') {
              l.allSublayers.forEach((sub: any) => {
                if (!sub) return
                w(() => sub.visible)
                w(() => sub.definitionExpression)
              })
            }
          })
          // layer view filters (display-only filters some widgets set)
          w(() => {
            const lvs: any = view.allLayerViews
            const arr: any[] = lvs && lvs.toArray ? lvs.toArray() : []
            return arr.map((lv: any) => (lv && lv.filter && lv.filter.where) || '').join('|') + '#' + (lvs ? lvs.length : 0)
          })
        } catch (e) { /* noop */ }
      }
      if (view && view.map && view.map.allLayers && typeof view.map.allLayers.on === 'function') {
        this.legendWatchHandles.push(view.map.allLayers.on('change', () => { bindLayers(); this.queueEstimate() }))
      }
      if (view) {
        // series preview follows pan and zoom through the same debounce
        try { this.legendWatchHandles.push(reactiveUtils.watch(() => view.extent, this.queueEstimate)) } catch (e) { /* noop */ }
      }
      bindLayers()
    } catch (e) { /* watcher is best-effort */ }
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

  /** Personal preference memory: city staff and residents should never
   *  have to re-pick the same format, DPI, or styles on every visit.
   *  Stored per browser + widget instance; admin runtime defaults still
   *  seed first-time users, and saved picks win afterward. */
  private static readonly PREF_KEYS = ['format', 'dpi', 'naStyle', 'sbStyle', 'sbUnits', 'sbUnits2', 'fontFamily', 'author', 'fileName', 'gridStyleJson', 'cardsOpenJson'] as const
  private prefSaveTimer: any = null

  prefStorageKey = (): string => 'print-advanced-prefs-' + String((this.props as any).id || 'w')

  loadPrefs = (): any => {
    try {
      const raw = window.localStorage.getItem(this.prefStorageKey())
      if (!raw) return {}
      const v = JSON.parse(raw)
      return (v && typeof v === 'object') ? v : {}
    } catch (e) { return {} }
  }

  savePrefsSoon = (): void => {
    if (this.prefSaveTimer) clearTimeout(this.prefSaveTimer)
    this.prefSaveTimer = setTimeout(() => {
      try {
        const out: any = {}
        for (const k of (Widget as any).PREF_KEYS) out[k] = (this.state as any)[k]
        window.localStorage.setItem(this.prefStorageKey(), JSON.stringify(out))
      } catch (e) { /* private mode etc.: preference memory is best-effort */ }
    }, 400)
  }

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
    const saved: any = this.loadPrefs()
    const pick = (k: string, dflt: string): string =>
      (typeof saved[k] === 'string' && saved[k] !== '') ? saved[k] : dflt
    // keep a user-typed title; refresh only if still the previous auto title
    const auto = this.state.title === '' || this.state.title === this.resolveTitle(prev)
    this.setState({
      selectedLayoutId: id,
      title: auto ? this.resolveTitle(next) : this.state.title,
      dpi: pick('dpi', d.dpi || ''),
      naStyle: pick('naStyle', d.northArrowStyle || ''),
      sbStyle: pick('sbStyle', d.scaleBarStyle || ''),
      sbUnits: pick('sbUnits', d.scaleBarUnits || ''),
      sbUnits2: pick('sbUnits2', d.scaleBarUnits2 || ''),
      fontFamily: pick('fontFamily', ''),
      // Re-evaluate the feature toggles for the NEW layout. These were set
      // once at mount and never refreshed, so after "Apply to all layouts"
      // enabled a legend on this layout, switching to it kept the previous
      // layout's stale toggle state (the reported "settings on, runtime
      // off"). Reset to the admin default (on unless runtimeDefaults says
      // off) for each feature; the row still only renders when the layout
      // actually offers that feature.
      includeLegend: (d as any).includeLegend !== false,
      showOverview: (d as any).showOverview !== false,
      showGrid: (d as any).showGrid !== false,
      includeSelection: (d as any).includeSelection !== false,
      // a fresh layout has not had its legend position hand-set yet
      legendPositionOv: '',
      legendPosUserSet: false,
      legendAutoPaged: false,
      legendHint: null,
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
    this.beacon?.action('print-service')
    this.beginBusyClock(); this.setState({ busy: true, error: null, note: '', lastResult: null, status: (defaultMessages as any).svcSubmitting })
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
      this.beacon?.error(err, 'print-service')
      this.setState({ busy: false, status: '', error: (err && err.message) || (defaultMessages as any).svcFailed })
    }
  }

  /** Dynamic text context (Pro <dyn> tags) for ANY map and ANY coordinate
   *  system: the CAPTURE CRS's ESRI WKT + unit, the web map title, and the
   *  signed-in user. WKT resolves universally (SR's own wkt -> offline seed
   *  table -> EPSG registry), so {sr:name}/{sr:datum}/{mapUnits} work for a
   *  user on any WKID, not just the ones shipped in the table. Best-effort:
   *  anything unresolved leaves the token empty (Pro emptyStr semantics). */
  applyTextContext = async (view: any, options: RenderOptions): Promise<void> => {
    this.applyConfigFlags(options)
    try {
      const sr: any = view.spatialReference
      const outWkid = options.outputWkid || 0
      const capWkid = outWkid || (sr && (sr.wkid || sr.latestWkid)) || 0
      const wkt = await lookupEsriWkt(capWkid || (sr && sr.isWebMercator ? 3857 : 0), outWkid ? undefined : sr)
      if (wkt) options.srWkt = wkt
      if (!outWkid && sr && sr.unit) options.srUnit = String(sr.unit)
      const item: any = (view.map as any)?.portalItem
      const mapTitle = (item && item.title) || (view.map as any)?.title
      if (mapTitle) options.mapName = String(mapTitle)
      const u: any = (getAppStore().getState() as any)?.user
      const userName = u && (u.fullName || u.username)
      if (userName) options.user = String(userName)
    } catch (e) { /* tokens fall back to '' */ }
  }

  /** Builder switches that shape every export, single map and series alike.
   *  Called from applyTextContext, which both export paths already run, so
   *  a new switch can never reach one path and miss the other. Sparse
   *  storage: legend scale filter and GeoPDF are on unless explicitly false;
   *  the extent filter and keep-rotation are off unless explicitly true. */
  applyConfigFlags = (options: RenderOptions): void => {
    const c: any = this.cfg() || {}
    options.legendScaleFilter = c.legendScaleFilter !== false
    options.legendExtentFilter = c.legendExtentFilter === true
    options.geoPdf = c.geoPdf !== false
    options.pdfLayers = c.pdfLayers !== false
    options.vectorLayers = c.vectorLayers === true
    options.georefKeepRotation = c.georefKeepRotation === true
  }

  /* ---------------------------------------------------------------- */
  /* the selection highlight: it lives on the VIEW, not the MAP        */
  /* ---------------------------------------------------------------- */

  /* The offscreen capture view shares the live view's MAP, so every map
   * layer prints. It does NOT share the live VIEW, and a selection
   * highlight is view-scoped, which is why a selected parcel never showed
   * up on the print. So the selected geometry is collected here and handed
   * to the renderer as a page-space vector overlay. The live map is never
   * touched, and the outline prints crisp rather than rasterized.
   * Everything below is best-effort: any source that cannot be read is
   * skipped, and the page still prints. */

  /** Reduce an SDK geometry to the flat shape the renderer draws. Handles
   *  polygon, polyline, point, multipoint and extent, in whatever CRS the
   *  geometry carries; the caller projects. */
  private overlayGeoms = (geometry: any): Array<{ g: SelectionGeometry, wkid: number }> => {
    const out: Array<{ g: SelectionGeometry, wkid: number }> = []
    try {
      if (!geometry) return out
      const sr: any = geometry.spatialReference || {}
      const wkid = Number(sr.wkid || sr.latestWkid || 0)
      const t = String(geometry.type || '')
      if (t === 'polygon' && geometry.rings) {
        out.push({ g: { kind: 'polygon', rings: geometry.rings as number[][][] }, wkid })
      } else if (t === 'polyline' && geometry.paths) {
        out.push({ g: { kind: 'polyline', paths: geometry.paths as number[][][] }, wkid })
      } else if (t === 'point' && isFinite(geometry.x) && isFinite(geometry.y)) {
        out.push({ g: { kind: 'point', x: Number(geometry.x), y: Number(geometry.y) }, wkid })
      } else if (t === 'multipoint' && geometry.points) {
        for (const p of geometry.points) {
          if (isFinite(p[0]) && isFinite(p[1])) out.push({ g: { kind: 'point', x: Number(p[0]), y: Number(p[1]) }, wkid })
        }
      } else if (t === 'extent' && isFinite(geometry.xmin)) {
        const e = geometry
        out.push({
          g: {
            kind: 'polygon',
            rings: [[[e.xmin, e.ymin], [e.xmax, e.ymin], [e.xmax, e.ymax], [e.xmin, e.ymax], [e.xmin, e.ymin]]]
          },
          wkid
        })
      }
    } catch (e) { /* unreadable geometry is skipped */ }
    return out
  }

  /** Every selected geometry on screen, from both places a selection lives
   *  in an Experience Builder app:
   *    1. records selected through a data source, which is how the Select,
   *       Table and Query widgets highlight features, and how a clicked
   *       feature is recorded
   *    2. graphics the app has drawn on the view, minus this widget's own
   *  The same feature often appears in both, so duplicates are dropped. */
  private collectSelection = (view: any): Array<{ g: SelectionGeometry, wkid: number }> => {
    const acc: Array<{ g: SelectionGeometry, wkid: number }> = []
    const seen: Record<string, boolean> = {}
    const add = (geometry: any): void => {
      for (const item of this.overlayGeoms(geometry)) {
        let key = ''
        try {
          const g: any = item.g
          key = item.wkid + '|' + g.kind + '|' + JSON.stringify(g.rings || g.paths || [g.x, g.y]).slice(0, 400)
        } catch (e) { key = String(acc.length) }
        if (seen[key]) continue
        seen[key] = true
        acc.push(item)
      }
    }
    try {
      for (const ds of dataSourceList()) {
        try {
          if (!ds || typeof ds.getSelectedRecords !== 'function') continue
          for (const rec of (ds.getSelectedRecords() || [])) {
            const f = rec && typeof rec.getFeature === 'function' ? rec.getFeature() : null
            if (f) add(f.geometry)
          }
        } catch (e) { /* one unreadable data source does not stop the rest */ }
      }
    } catch (e) { /* no data sources in this app */ }
    try {
      const gl: any = view && view.graphics
      const arr: any[] = gl ? (gl.toArray ? gl.toArray() : gl.items || []) : []
      // each graphic behind its own guard: one unreadable geometry must not
      // cost the user every selection that follows it in the list
      for (const g of arr) {
        try { if (!isOwnGraphic(g)) add(g.geometry) } catch (e) { /* skip this graphic */ }
      }
    } catch (e) { /* no view graphics */ }
    return acc
  }

  /** Collect the selected features and load them onto the render options,
   *  projecting into the CAPTURE coordinate system. When an output CRS is
   *  set and the projection engine will not load, the highlight is dropped
   *  rather than drawn in the wrong place. */
  collectViewDecorations = async (view: any, options: RenderOptions): Promise<void> => {
    try {
      if (!view) return
      if (!this.state.includeSelection) return
      // the capture CRS: the output WKID when one is set, else the live map
      const sr: any = view.spatialReference || {}
      const liveWkid = Number(sr.wkid || sr.latestWkid || 0)
      const capWkid = Number(options.outputWkid || 0) || liveWkid
      if (!capWkid) return

      const geoms = this.collectSelection(view)
      if (!geoms.length) return

      // one projector per source CRS; identity when it matches the capture
      const projectors: Record<number, ((x: number, y: number) => [number, number] | null) | null> = {}
      const projectorFor = async (from: number): Promise<((x: number, y: number) => [number, number] | null) | null> => {
        const key = from || liveWkid
        if (projectors[key] === undefined) projectors[key] = await getPointProjector(key, capWkid)
        return projectors[key]
      }

      const ready: SelectionGeometry[] = []
      for (const item of geoms) {
        const pj = await projectorFor(item.wkid)
        if (!pj) continue // no projection engine: skip rather than misplace
        const g = item.g
        const mapPts = (list: number[][][] | undefined): number[][][] | undefined => {
          if (!list) return undefined
          const outer: number[][][] = []
          for (const part of list) {
            const pts: number[][] = []
            for (const p of part) {
              const q = pj(Number(p[0]), Number(p[1]))
              if (q) pts.push(q)
            }
            if (pts.length > 1) outer.push(pts)
          }
          return outer.length ? outer : undefined
        }
        if (g.kind === 'polygon') {
          const rings = mapPts(g.rings)
          if (rings) ready.push({ kind: 'polygon', rings })
        } else if (g.kind === 'polyline') {
          const paths = mapPts(g.paths)
          if (paths) ready.push({ kind: 'polyline', paths })
        } else {
          const q = pj(Number(g.x), Number(g.y))
          if (q) ready.push({ kind: 'point', x: q[0], y: q[1] })
        }
      }
      if (ready.length) {
        options.selectionGeometries = ready
        const c = this.selectionColorCfg()
        if (c) options.selectionColor = c
        const w = Number((this.cfg() as any).selectionWidthPt)
        if (w > 0) options.selectionWidthPt = w
      }

      this.diag('selection', { collected: geoms.length, projected: ready.length, capWkid })
    } catch (e) { /* overlays are best-effort; never lose the export */ }
  }

  /** Print-overlay diagnostics, off unless the builder switches them on.
   *  The selection lives outside this widget, so when a highlight does not
   *  print the only way to tell WHY is to report what was found. */
  private diag = (what: string, detail: any): void => {
    try {
      if (!(this.cfg() as any).diagnostics) return
      // eslint-disable-next-line no-console
      console.info('[print-advanced] ' + what, detail)
    } catch (e) { /* never let logging break an export */ }
  }

  /* ---------------------------------------------------------------- */
  /* help guide                                                        */
  /* ---------------------------------------------------------------- */

  /** Translate one help string and fill any {token} placeholders. */
  private helpT = (id: string, values?: Record<string, string>): string => {
    let s = String((defaultMessages as any)[id] || '')
    if (values) {
      for (const k of Object.keys(values)) s = s.split('{' + k + '}').join(values[k])
    }
    return s
  }

  /** What this app actually offers right now. The guide is built from these,
   *  so a reader never finds instructions for a button that is not there.
   *  Read off the same config and layout checks the UI itself uses, which is
   *  what keeps the two from drifting apart. */
  private helpFeatures = (): any => {
    const layout: any = this.getSelectedLayout()
    const hasLegendEl = !!(layout && layout.elements && layout.elements.some((e: any) => e.type === 'legend'))
    const service = this.printSource() === 'service'
    return {
      service,
      // the pagx path owns the print-area, map-only and page-furniture
      // controls; a service print has none of them
      printArea: !service && this.meEnabled(),
      mapOnly: !service && this.meMapOnly(),
      georeference: !service && this.meMapOnly(),
      kmz: !service && this.meMapOnly(),
      legend: !service && this.ctrl('legend') && !!layout && (hasLegendEl || !!(layout.legend && layout.legend.enabled)),
      overview: !service && !!layout && !!(layout.overview && layout.overview.enabled),
      grid: !service && this.ctrl('grid') && !!layout && !!(layout.grid && layout.grid.enabled),
      gridStyle: !service && this.ctrl('grid') && this.ctrl('gridStyle') !== false && !!layout && !!(layout.grid && layout.grid.enabled),
      series: !service && this.ctrl('series'),
      outSR: this.outSREnabled(),
      qr: !service, // the QR row is always shown on the pagx path

      selection: !service,
      fonts: !service && this.ctrl('font'),
      geoPdf: !service && (this.cfg() as any).geoPdf !== false,
      pdfLayers: !service && (this.cfg() as any).pdfLayers !== false,
      vector: !service && (this.cfg() as any).vectorLayers === true,
      pagePreview: !service && this.ctrl('pagePreview'),
      keepRotation: (this.cfg() as any).georefKeepRotation === true
    }
  }

  private openHelp = (): void => {
    // opening the guide answers the first-run hint, so it never comes back
    if (!this.state.helpHintDismissed) writeHelpHint(this.props.id)
    this.setState({ helpOpen: true, helpHintDismissed: true })
  }

  private dismissHelpHint = (): void => {
    writeHelpHint(this.props.id)
    this.setState({ helpHintDismissed: true })
  }

  /** Highlight color from settings, as 0-255 RGB. Defaults to the SDK's cyan
   *  so the print matches what the user saw on screen. */
  private selectionColorCfg = (): [number, number, number] | null => {
    try {
      const raw = String((this.cfg() as any).selectionColor || '').trim()
      const m = /^#?([0-9a-f]{6})$/i.exec(raw)
      if (!m) return null
      const n = parseInt(m[1], 16)
      return [(n >> 16) & 255, (n >> 8) & 255, n & 255]
    } catch (e) { return null }
  }

  onExport = async (): Promise<void> => {
    if (this.printSource() === 'service') { return this.runServicePrint() }
    if (this.state.seriesOpen && this.ctrl('series') && this.state.format === 'pdf') {
      return this.onExportSeries()
    }
    const { jimuMapView } = this.state
    const layout = this.getSelectedLayout()
    if (!jimuMapView || !jimuMapView.view || !layout) return

    this.beacon?.action('export', this.state.format)
    this.beginBusyClock(); this.setState({ busy: true, error: null, note: '', lastResult: null, status: 'Preparing…' })
    try {
      const maxImagePx = Number((this.props.config as any)?.maxImagePx) || 0 // 0 = auto (GPU-detected)
      const effLayout = this.state.dpi
        ? { ...layout, dpi: Number(this.state.dpi) }
        : layout
      const options: RenderOptions = {}
      if (this.state.naStyle) options.northArrowStyle = this.state.naStyle as any
      if (this.state.sbStyle) options.scaleBarStyle = this.state.sbStyle as any
      if (this.state.sbUnits) options.scaleBarUnits = this.state.sbUnits as any
      if (this.state.sbUnits2 && (this.state.sbStyle === 'doubleAlternating' || this.state.sbStyle === 'hollowDouble')) options.scaleBarUnits2 = this.state.sbUnits2 as any
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
      if (this.state.qrOn) {
        try {
          const qu = this.qrSafeUrl()
          if (qu) {
            (options as any).qrUrl = qu;
            (options as any).qrCaption = (defaultMessages as any).qrCaption || 'Scan for interactive map'
          }
        } catch (e) { /* QR is best-effort */ }
      }
      if (this.state.author) options.author = this.state.author
      if (this.state.copyright) options.copyright = this.state.copyright
      if ((this.props.config as any)?.includeAttribution !== false) {
        options.attribution = this.captureAttribution(jimuMapView.view)
      }
      options.includeLegend = this.state.includeLegend
      options.showOverview = this.state.showOverview
      options.showGrid = this.state.showGrid
      if (this.state.legendPositionOv) options.legendPositionOverride = this.state.legendPositionOv
      if (this.state.gridTypeOv) options.gridTypeOverride = this.state.gridTypeOv
      this.applyGridStyle(options)
      if ((this.cfg() as any).legendWidgetId) options.legendWidgetId = String((this.cfg() as any).legendWidgetId)
      options.onPanelComputed = (panel) => {
        this.lastPanel = panel
        if (this.state.previewOn) this.updatePreview()
      }
      if (this.outSREnabled() && parseInt(this.state.outWkid, 10) > 0) {
        options.outputWkid = parseInt(this.state.outWkid, 10)
      }
      await this.applyTextContext(jimuMapView.view, options)
      // selection highlight: view-scoped, so the shared-map capture never
      // contains it. Must run AFTER outputWkid is set, since the geometry
      // is projected into the capture coordinate system.
      await this.collectViewDecorations(jimuMapView.view, options)
      if (this.meMapOnly() && this.state.mapOnly) {
        options.mapOnly = true
        if (Number(this.state.mapOnlyW) > 0) options.mapOnlyWidth = Number(this.state.mapOnlyW)
        if (Number(this.state.mapOnlyH) > 0) options.mapOnlyHeight = Number(this.state.mapOnlyH)
        // Georeference: only meaningful for a map-only RASTER (the image is
        // the map edge to edge). Passes the output CRS WKT for a .prj when
        // the SR carries one (custom SRs do; a bare WKID may not).
        if (this.state.georeference && this.rasterFormat(this.state.format)) {
          options.georeference = true
          try {
            const sr: any = jimuMapView.view.spatialReference
            const outWkid = this.outSREnabled() ? (parseInt(this.state.outWkid, 10) || 0) : 0
            // the CRS the exported pixels are actually in: the output WKID
            // when one is set, otherwise the live map's SR
            const effWkid = outWkid || (sr && (sr.wkid || sr.latestWkid)) || 0
            // prefer the SR object's own WKT (custom SRs carry it), then the
            // WKID table; without either, Pro still needs SOMETHING, so a bare
            // WebMercator map resolves via the table below
            const wkt = await lookupEsriWkt(effWkid || (sr && sr.isWebMercator ? 3857 : 0), outWkid ? undefined : sr)
            if (wkt) options.georefWkt = wkt
            // geographic vs projected decides the GeoTIFF key; ask the SDK
            // (works for any WKID it knows), else the renderer infers from WKT
            try {
              const geoSR: any = outWkid ? new SpatialReference({ wkid: outWkid }) : sr
              if (geoSR && typeof geoSR.isGeographic === 'boolean') options.georefGeographic = geoSR.isGeographic
              else if (geoSR && geoSR.unit) options.georefGeographic = String(geoSR.unit) === 'degrees'
            } catch (e) { /* renderer infers */ }
            // EPSG code for a true embedded GeoTIFF (TIFF format): Pro reads
            // the CRS from inside the file, no sidecar. Web Mercator's several
            // WKIDs all normalize to 3857.
            let gw = effWkid
            if (gw === 102100 || gw === 102113) gw = 3857
            if (gw > 0) options.georefWkid = gw
          } catch (e) { /* .prj is optional; world file still georeferences */ }
        }
        // Google Earth (KMZ): wrap the map-only raster with a GroundOverlay.
        // Works with ANY map coordinate system - the four map corners are
        // projected to WGS84 lon/lat inside the renderer.
        if (this.state.googleEarthKmz) {
          options.googleEarthKmz = true
        }
      }
      // Google Earth reads PNG/JPG overlays; coerce any other raster (or a
      // vector/PDF selection) to PNG32 when packaging a KMZ so the image the
      // overlay references is a format the globe can draw.
      let effFormat = this.state.format
      if (options.googleEarthKmz && !(effFormat === 'png32' || effFormat === 'png8' || effFormat === 'jpg')) {
        effFormat = 'png32'
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
        effFormat,
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
          ? this.pushResult({ name: result.fileName, url: result.url, meta: result.effectiveDpi + ' DPI · ' + (result.sizeKb || 0) + ' KB' + (result.warning ? ' · ' + result.warning : '') })
          : this.state.results
      })
    } catch (err: any) {
      this.beacon?.error(err, 'export')
      this.setState({ busy: false, status: '', error: (err && err.message) || 'Export failed.' })
    }
  }

  /** Center-preserving envelope scale: uniform, so the frame-enforced
   *  aspect survives any grid size the user picks. */
  seriesScaleEnv = (env: { xmin: number, ymin: number, xmax: number, ymax: number }): { xmin: number, ymin: number, xmax: number, ymax: number } => {
    const f = Math.max(25, Math.min(100, parseInt(this.state.seriesSizePct, 10) || 100)) / 100
    if (f >= 0.999) return env
    const cx = (env.xmin + env.xmax) / 2; const cy = (env.ymin + env.ymax) / 2
    const hw = (env.xmax - env.xmin) / 2 * f; const hh = (env.ymax - env.ymin) / 2 * f
    return { xmin: cx - hw, xmax: cx + hw, ymin: cy - hh, ymax: cy + hh }
  }

  /** The URL a printed QR should carry: the durable app link, never the
   *  session hash (viewpoint, draft state), which balloons past the QR
   *  encoder's 213-byte capacity and is meaningless to a later scanner. */
  private qrSafeUrl = (): string => {
    try {
      const L = window.location
      let u = L.origin + L.pathname + (L.search || '')
      if (u.length > 200) u = L.origin + L.pathname
      return u.length <= 213 ? u : ''
    } catch (e) { return '' }
  }

  /* ---------------------------------------------------------------- */
  /* data-driven pages: one page per feature                          */
  /* ---------------------------------------------------------------- */

  /** Most feature pages one export makes (plus the index page), the same
   *  31-page ceiling the grid series has, for memory and time. */
  /** Map series guardrails from Settings: warn above `warn` map pages,
   *  never more than `max` (index and legend pages not counted). */
  seriesLimits = (): { warn: number, max: number, mode: 'block' | 'first' } => {
    const c: any = this.cfg()
    const max = Math.max(1, Math.min(200, Math.round(Number(c.seriesMaxPages) || 50)))
    const warn = Math.max(1, Math.min(max, Math.round(Number(c.seriesWarnPages) || 20)))
    return { warn, max, mode: c.seriesLimitMode === 'first' ? 'first' : 'block' }
  }

  /** Map pages the series would make before any limit (0 while unknown). */
  seriesSheetCount = (): number => {
    if (this.seriesFeatures()) return this.featCache ? this.featCache.total : 0
    const r = Math.max(1, Math.min(8, parseInt(this.state.seriesRows, 10) || 1))
    const c = Math.max(1, Math.min(8, parseInt(this.state.seriesCols, 10) || 1))
    return r * c
  }

  /** Over the limit and the export must not run. */
  seriesBlocked = (): boolean => {
    const L = this.seriesLimits()
    const n = this.seriesSheetCount()
    if (n <= L.max) return false
    return !(this.seriesFeatures() && L.mode === 'first')
  }

  /** Rough time and file size for a series, for the large-job warning. */
  seriesCost = (sheets: number): { time: string, mb: number } => {
    const dpi = Number(this.state.dpi) || Number((this.getSelectedLayout() as any)?.dpi) || 200
    const k = Math.max(0.3, (dpi / 200) * (dpi / 200))
    const ov = this.seriesFeatures() && this.state.showOverview && !!(this.getSelectedLayout() as any)?.overview?.enabled
    const sec = sheets * (6 * Math.max(0.6, dpi / 200)) * (ov ? 1.8 : 1) + 10
    const mb = Math.max(1, Math.round(sheets * 1.2 * k * (ov ? 1.25 : 1)))
    const time = sec < 90 ? Math.round(sec / 10) * 10 + ' s' : Math.round(sec / 60) + ' min'
    return { time, mb }
  }

  /** The guardrail line under the series settings: nothing, a large-job
   *  warning, a first-N notice, or the over-limit stop. */
  renderSeriesLimit = (messages: any): React.ReactNode => {
    const L = this.seriesLimits()
    const n = this.seriesSheetCount()
    if (!n) return null
    const feats = this.seriesFeatures()
    if (n > L.max) {
      if (feats && L.mode === 'first') {
        return <Alert type='warning' withIcon style={{ width: '100%' }} text={String(messages.seriesOverFirst).replace('{n}', String(n)).replace(/\{max\}/g, String(L.max)) + (this.featUnsorted ? ' ' + messages.seriesUnsorted : '')} />
      }
      return <Alert type='error' withIcon style={{ width: '100%' }} text={String(feats ? messages.seriesOverFeat : messages.seriesOverGrid).replace('{n}', String(n)).replace(/\{max\}/g, String(L.max))} />
    }
    if (n > L.warn) {
      const c = this.seriesCost(n)
      return <Alert type='warning' withIcon style={{ width: '100%' }} text={String(messages.seriesWarnLarge).replace('{n}', String(n)).replace('{t}', c.time).replace('{mb}', String(c.mb))} />
    }
    return null
  }

  private featCache: { key: string, feats: FeaturePageInput[], total: number } | null = null
  private featSeq = 0

  seriesFeatures = (): boolean => this.state.seriesMode === 'features'

  /* ---------------------------------------------------------------- */
  /* Advanced options cards: open or closed, remembered per user      */
  /* ---------------------------------------------------------------- */

  /** Out of the box: the cards people touch on most prints start open. */
  private static readonly CARD_DEFAULT_OPEN: Record<string, boolean> = {
    area: true, series: false, onmap: true, text: false, style: false, output: false, svcout: true
  }

  cardsOpen = (): Record<string, boolean> => {
    try { const v = this.state.cardsOpenJson ? JSON.parse(this.state.cardsOpenJson) : {}; return v && typeof v === 'object' ? v : {} } catch (e) { return {} }
  }

  /** The user's choice, else the admin default, else the built-in one. A
   *  card with something switched on inside it (a running map series, a
   *  data-driven pages setup) stays open so the setup is never hidden. */
  cardOpen = (key: string): boolean => {
    if (key === 'series' && this.seriesActive()) return true
    const user = this.cardsOpen()
    if (typeof user[key] === 'boolean') return user[key]
    const admin: any = (this.cfg() as any).cardsOpen
    if (admin && typeof admin[key] === 'boolean') return admin[key]
    return (Widget as any).CARD_DEFAULT_OPEN[key] !== false
  }

  toggleCard = (key: string): void => {
    const next = { ...this.cardsOpen(), [key]: !this.cardOpen(key) }
    this.setState({ cardsOpenJson: JSON.stringify(next) })
  }

  /** One-line summary shown in a card header, so a closed card still tells
   *  you what is set inside it. */
  cardSummary = (key: string, messages: any, layout: any): string => {
    const s: any = this.state
    try {
      if (key === 'area') return s.scaleReadout ? '1:' + Number(s.scaleReadout).toLocaleString() : ''
      if (key === 'series') return this.seriesActive() ? String(messages.seriesPagesBadge).replace('{n}', String(this.seriesPageCount())) : messages.cardOff
      if (key === 'onmap') {
        const on: string[] = []
        if (this.ctrl('legend') && layout && ((layout.elements && layout.elements.some((e: any) => e.type === 'legend')) || (layout.legend && layout.legend.enabled)) && s.includeLegend && !s.mapOnly) on.push(messages.cardLegend)
        if (this.ctrl('overview') && layout && layout.overview && layout.overview.enabled && s.showOverview && !s.mapOnly) on.push(messages.cardOverview)
        if (this.ctrl('grid') && layout && layout.grid && layout.grid.enabled && s.showGrid && !s.mapOnly) on.push(messages.cardGrid)
        if (s.includeSelection) on.push(messages.cardSelection)
        return on.length ? on.join(', ') : messages.cardNone
      }
      if (key === 'text') {
        const parts: string[] = []
        if (s.author) parts.push(s.author)
        if (s.qrOn) parts.push(messages.cardQr)
        return parts.join(', ')
      }
      if (key === 'style') {
        const fam = s.fontFamily || (this.cfg() as any).defaultFontFamily || ''
        if (!fam) return messages.layoutDefault
        if (fam.indexOf('custom:') === 0) return fam.slice(7)
        const f = FONT_FAMILIES.find((x: any) => x.value === fam)
        return f ? f.label : fam
      }
      if (key === 'output' || key === 'svcout') {
        const f = FORMAT_LABELS.find((x: any) => x.value === s.format)
        // short form: the part in parentheses (PDF), else the whole label
        const m = f ? /\(([^)]+)\)\s*$/.exec(f.label) : null
        const parts: string[] = [m ? m[1] : (f ? f.label : String(s.format || '').toUpperCase())]
        if (s.dpi) parts.push(s.dpi + ' DPI')
        if (s.mapOnly) parts.push(messages.cardMapOnly)
        return parts.join(' · ')
      }
    } catch (e) { /* summary is decoration */ }
    return ''
  }

  /** Card header: a real button that opens and closes the card. */
  cardHead = (key: string, title: string, messages: any, layout: any): React.ReactNode => {
    const open = this.cardOpen(key)
    const sum = this.cardSummary(key, messages, layout)
    return (
      <button type='button' className={'pd-card-btn' + (open ? '' : ' is-closed')}
        aria-expanded={open} aria-controls={this.uid('cb-' + key)} id={this.uid('gh-' + key)}
        onClick={() => this.toggleCard(key)}>
        <span className='pd-card-left'>
          {open ? <DownOutlined size={12} aria-hidden='true' /> : <RightOutlined size={12} aria-hidden='true' />}
          <span className='pd-pa-title'>{title}</span>
        </span>
        {sum ? <span className='pd-pa-scale'>{sum}</span> : null}
      </button>
    )
  }

  /* ---------------------------------------------------------------- */
  /* grid style (per user, over the layout's grid settings)            */
  /* ---------------------------------------------------------------- */

  gridOv = (): Record<string, any> => {
    try { const v = this.state.gridStyleJson ? JSON.parse(this.state.gridStyleJson) : {}; return v && typeof v === 'object' ? v : {} } catch (e) { return {} }
  }

  setGridOv = (patch: Record<string, any>): void => {
    const next: Record<string, any> = { ...this.gridOv(), ...patch }
    for (const k of Object.keys(next)) if (next[k] === undefined || next[k] === null || next[k] === '') delete next[k]
    this.setState({ gridStyleJson: Object.keys(next).length ? JSON.stringify(next) : '' })
  }

  applyGridStyle = (options: RenderOptions): void => {
    if (this.ctrl('gridStyle') === false) return
    const ov = this.gridOv()
    if (Object.keys(ov).length) options.gridStyleOverride = ov as any
  }

  /** Effective grid value: the user's choice, else the layout's, else d. */
  gridVal = (layout: any, key: string, d: any): any => {
    const ov = this.gridOv()
    if (ov[key] !== undefined) return ov[key]
    const g = layout && layout.grid
    return g && g[key] !== undefined ? g[key] : d
  }

  private static rgbHex = (c: any, d: string): string => {
    if (!Array.isArray(c) || c.length < 3) return d
    return '#' + c.slice(0, 3).map((v: number) => Math.max(0, Math.min(255, Math.round(Number(v) || 0))).toString(16).padStart(2, '0')).join('')
  }

  private static hexRgb = (h: string): number[] | null => {
    const m = /^#?([0-9a-f]{6})$/i.exec(String(h || '').trim())
    if (!m) return null
    const n = parseInt(m[1], 16)
    return [(n >> 16) & 255, (n >> 8) & 255, n & 255]
  }

  /** Grid style panel: every look of the grid, per user, over the layout. */
  renderGridStyle = (messages: any, layout: any): React.ReactNode => {
    if (this.ctrl('gridStyle') === false) return null
    const W: any = Widget
    const type = this.state.gridTypeOv || this.gridVal(layout, 'type', 'measured')
    const labels = this.gridVal(layout, 'labels', true) !== false
    const lineHex = W.rgbHex(this.gridVal(layout, 'lineColor', [90, 90, 90]), '#5a5a5a')
    const labelHex = W.rgbHex(this.gridVal(layout, 'labelColor', this.gridVal(layout, 'lineColor', [90, 90, 90])), lineHex)
    const haloHex = W.rgbHex(this.gridVal(layout, 'haloColor', [255, 255, 255]), '#ffffff')
    const style = this.gridVal(layout, 'lineStyle', 'solid')
    const fixed = this.gridVal(layout, 'intervalMode', 'auto') === 'fixed'
    const changed = !!this.state.gridStyleJson
    const row = (id: string, label: string, control: React.ReactNode, inline = true): React.ReactNode => (
      <div className={'pd-row' + (inline ? ' pd-inline' : '')}>
        <Label className='pd-label' id={this.uid(id) + '-lbl'}>{label}</Label>
        {control}
      </div>
    )
    const sel = (id: string, key: string, value: any, opts: Array<[string, string]>, width = 150, conv?: (v: string) => any): React.ReactNode => (
      <Select size='sm' style={{ width }} aria-labelledby={this.uid(id) + '-lbl'} value={String(value)}
        onChange={(e: any) => this.setGridOv({ [key]: conv ? conv(e.target.value) : e.target.value })}>
        {opts.map(o => <option key={o[0]} value={o[0]}>{o[1]}</option>)}
      </Select>
    )
    const sw = (id: string, key: string, on: boolean): React.ReactNode => (
      <Switch aria-labelledby={this.uid(id) + '-lbl'} checked={on} onChange={(e: any) => this.setGridOv({ [key]: !!(e.target && e.target.checked) })} />
    )
    const color = (id: string, key: string, hex: string): React.ReactNode => (
      <input type='color' className='pd-color' aria-labelledby={this.uid(id) + '-lbl'} value={hex}
        onChange={(e: any) => { const c = W.hexRgb(e.target.value); if (c) this.setGridOv({ [key]: c }) }} />
    )
    return (
      <React.Fragment>
        <div className='pd-row'>
          <Button size='sm' type='tertiary' aria-expanded={this.state.gridStyleOpen} aria-controls={this.uid('gstyle')}
            onClick={() => this.setState({ gridStyleOpen: !this.state.gridStyleOpen })}>
            {this.state.gridStyleOpen ? <DownOutlined size={12} aria-hidden='true' /> : <RightOutlined size={12} aria-hidden='true' />}
            <span style={{ marginLeft: 4 }}>{messages.gridStyleToggle}</span>
          </Button>
          {changed && <span className='pd-desc'>{messages.gridStyleChanged}</span>}
        </div>
        {this.state.gridStyleOpen && (
        <div id={this.uid('gstyle')} role='group' aria-label={messages.gridStyleToggle} className='pd-gstyle'>
          <div className='pd-gs-head' role='heading' aria-level={4}>{messages.gridLinesHead}</div>
          {row('gs-style', messages.gridLineStyle, sel('gs-style', 'lineStyle', style, [['solid', messages.gridStyleLines], ['ticks', messages.gridStyleTicks], ['crosses', messages.gridStyleCrosses]]))}
          {row('gs-lc', messages.gridLineColor, color('gs-lc', 'lineColor', lineHex))}
          {row('gs-lw', messages.gridLineWidth, sel('gs-lw', 'lineWidthPt', this.gridVal(layout, 'lineWidthPt', 0.5),
            [['0.25', '0.25 pt'], ['0.5', '0.5 pt'], ['0.75', '0.75 pt'], ['1', '1 pt'], ['1.5', '1.5 pt'], ['2', '2 pt'], ['3', '3 pt']], 110, Number))}
          {row('gs-op', messages.gridLineOpacity, sel('gs-op', 'lineOpacity', this.gridVal(layout, 'lineOpacity', 1),
            [['1', '100%'], ['0.75', '75%'], ['0.5', '50%'], ['0.25', '25%']], 110, Number))}
          {row('gs-dash', messages.gridLineDash, sel('gs-dash', 'lineDash', this.gridVal(layout, 'lineDash', 'solid'),
            [['solid', messages.gridDashSolid], ['dash', messages.gridDashDash], ['dot', messages.gridDashDot]], 110))}
          {style !== 'solid' && row('gs-mk', messages.gridMarkSize, sel('gs-mk', 'markScalePct', this.gridVal(layout, 'markScalePct', 100),
            [['50', '50%'], ['75', '75%'], ['100', '100%'], ['150', '150%'], ['200', '200%'], ['300', '300%']], 110, Number))}
          {type !== 'reference' && (
            <React.Fragment>
              {row('gs-int', messages.gridIntervalLabel, sel('gs-int', 'intervalMode', fixed ? 'fixed' : 'auto', [['auto', messages.gridIntervalAuto], ['fixed', messages.gridIntervalFixed]], 110))}
              {fixed && row('gs-intv', type === 'graticule' ? messages.gridIntervalDeg : messages.gridIntervalUnits, (
                <TextInput size='sm' style={{ width: 110 }} aria-labelledby={this.uid('gs-intv') + '-lbl'}
                  value={String(this.gridVal(layout, 'fixedInterval', ''))}
                  onChange={(e: any) => { const v = parseFloat(String(e.target.value).replace(/[^0-9.]/g, '')); this.setGridOv({ fixedInterval: v > 0 ? v : undefined }) }} />
              ))}
            </React.Fragment>
          )}
          {type === 'reference' && (
            <React.Fragment>
              {row('gs-rc', messages.gridRefCols, (
                <TextInput size='sm' style={{ width: 64 }} aria-labelledby={this.uid('gs-rc') + '-lbl'} value={String(this.gridVal(layout, 'refCols', 4))}
                  onChange={(e: any) => { const v = parseInt(e.target.value, 10); this.setGridOv({ refCols: v > 0 ? Math.min(99, v) : undefined }) }} />
              ))}
              {row('gs-rr', messages.gridRefRows, (
                <TextInput size='sm' style={{ width: 64 }} aria-labelledby={this.uid('gs-rr') + '-lbl'} value={String(this.gridVal(layout, 'refRows', 4))}
                  onChange={(e: any) => { const v = parseInt(e.target.value, 10); this.setGridOv({ refRows: v > 0 ? Math.min(99, v) : undefined }) }} />
              ))}
              {row('gs-rl', messages.gridRefLetters, sel('gs-rl', 'refLetters', this.gridVal(layout, 'refLetters', 'cols'), [['cols', messages.gridRefLettersCols], ['rows', messages.gridRefLettersRows]], 130))}
              {row('gs-cell', messages.gridRefCells, sw('gs-cell', 'refCellLabels', this.gridVal(layout, 'refCellLabels', false) === true))}
            </React.Fragment>
          )}
          <div className='pd-gs-head' role='heading' aria-level={4}>{messages.gridLabelsHead}</div>
          {row('gs-lbl', messages.gridShowLabels, sw('gs-lbl', 'labels', labels))}
          {labels && (
            <React.Fragment>
              {row('gs-tc', messages.gridLabelColor, color('gs-tc', 'labelColor', labelHex))}
              {row('gs-ts', messages.gridLabelSizeRt, sel('gs-ts', 'labelSizePt', this.gridVal(layout, 'labelSizePt', 7),
                [['6', '6 pt'], ['7', '7 pt'], ['8', '8 pt'], ['9', '9 pt'], ['10', '10 pt'], ['12', '12 pt'], ['14', '14 pt'], ['18', '18 pt'], ['24', '24 pt']], 110, Number))}
              {row('gs-bold', messages.gridLabelBold, sw('gs-bold', 'labelBold', this.gridVal(layout, 'labelBold', false) === true))}
              {row('gs-halo', messages.gridLabelHalo, sw('gs-halo', 'labelHalo', this.gridVal(layout, 'labelHalo', true) !== false))}
              {this.gridVal(layout, 'labelHalo', true) !== false && row('gs-hc', messages.gridHaloColor, color('gs-hc', 'haloColor', haloHex))}
              {row('gs-pos', messages.gridLabelPosRt, sel('gs-pos', 'labelsInside', this.gridVal(layout, 'labelsInside', true) !== false ? 'inside' : 'outside',
                [['inside', messages.gridPosInside], ['outside', messages.gridPosOutside]], 130, (v: string) => v === 'inside'))}
              {row('gs-edges', messages.gridLabelEdges, sel('gs-edges', 'labelEdges', this.gridVal(layout, 'labelEdges', 'all'),
                [['all', messages.gridEdgesAll], ['topLeft', messages.gridEdgesTopLeft], ['bottomRight', messages.gridEdgesBottomRight],
                  ['topBottom', messages.gridEdgesTopBottom], ['leftRight', messages.gridEdgesLeftRight]], 150))}
              {row('gs-vert', messages.gridLabelVertical, sw('gs-vert', 'labelsVertical', this.gridVal(layout, 'labelsVertical', false) === true))}
              {type === 'graticule' && row('gs-gf', messages.gridGeoFormat, sel('gs-gf', 'geoFormat', this.gridVal(layout, 'geoFormat', 'dms'),
                [['dms', messages.gridFmtDms], ['dm', messages.gridFmtDm], ['dd', messages.gridFmtDd]], 150))}
              {type === 'measured' && row('gs-mf', messages.gridMeasuredFormat, sel('gs-mf', 'measuredFormat', this.gridVal(layout, 'measuredFormat', 'comma'),
                [['comma', '4,327,000'], ['plain', '4327000'], ['unit', messages.gridFmtUnit]], 150))}
              {type !== 'reference' && row('gs-corner', messages.gridCornerRt, sw('gs-corner', 'cornerLabels', this.gridVal(layout, 'cornerLabels', false) === true))}
            </React.Fragment>
          )}
          <div className='pd-row'>
            <Button size='sm' type='tertiary' disabled={!changed} onClick={() => this.setState({ gridStyleJson: '' })}>{messages.gridStyleReset}</Button>
          </div>
          <div className='pd-desc'>{messages.gridStyleHint}</div>
        </div>
        )}
      </React.Fragment>
    )
  }

  /** A map series (either kind) is set up for the next PDF export. */
  seriesActive = (): boolean => !!this.state.seriesOpen && this.ctrl('series') && this.state.format === 'pdf'

  /** Data-driven pages limited to the print area rectangle. */
  ddpFrameActive = (): boolean => this.seriesActive() && this.seriesFeatures() && this.state.seriesScope === 'frame'

  /** Add a page token to the map title (with a space when needed). */
  insertTitleToken = (tok: string): void => {
    const cur = String(this.state.title || '')
    const next = cur ? (/\s$/.test(cur) ? cur + tok : cur + ' ' + tok) : tok
    this.setState({ title: next })
  }

  /** Title helpers shown under Map title while a series is set up: page
   *  tokens to insert and how page 1's title will read. */
  renderSeriesTitleHelp = (messages: any, layout: any): React.ReactNode => {
    if (!this.seriesActive()) return null
    const feats = this.seriesFeatures()
    const layer = feats ? this.featLayer() : null
    const fields = feats ? this.featFieldList(layer) : []
    const first: any = feats && this.featCache && this.featCache.feats.length ? this.featCache.feats[0] : null
    const n = feats ? (this.featCache ? Math.min(this.featCache.total, this.seriesLimits().max) : 0) : this.seriesSheetCount()
    let sample = ''
    try {
      sample = seriesPageTitle(this.state.title || (layout && layout.name) || 'Map', 0, Math.max(1, n || 1),
        { name: first ? first.name : (feats ? '' : undefined), fields: first ? first.fields : undefined }, feats)
    } catch (e) { sample = '' }
    return (
      <div className='pd-row' role='group' aria-label={messages.seriesTitleTokens}>
        <div className='pd-inline' style={{ flexWrap: 'wrap', gap: 4 }}>
          <span className='pd-desc'>{messages.seriesTitleTokens}</span>
          {feats && (
            <Button size='sm' type='tertiary' onClick={() => this.insertTitleToken('{pageName}')}>{messages.seriesTokName}</Button>
          )}
          <Button size='sm' type='tertiary' onClick={() => this.insertTitleToken('{page} of {pages}')}>{messages.seriesTokNumber}</Button>
          {feats && fields.length > 0 && (
            <Select size='sm' style={{ width: 130 }} aria-label={messages.seriesTokField} value=''
              onChange={(e: any) => { if (e.target.value) this.insertTitleToken('{field:' + e.target.value + '}') }}>
              <option value=''>{messages.seriesTokField}</option>
              {fields.map(f => <option key={f.name} value={f.name}>{f.alias}</option>)}
            </Select>
          )}
        </div>
        {sample && <div className='pd-desc' aria-live='polite'>{String(messages.seriesTitleSample).replace('{t}', sample)}</div>}
        <div className='pd-desc'>{feats ? messages.seriesTitleHintFeat : messages.seriesTitleHintGrid}</div>
      </div>
    )
  }

  /** Feature layers from the map's own layer list that are turned on (the
   *  layer and every group above it) and can be queried for pages, at any depth:
   *  layers inside group layers (nested groups included) and the leaf
   *  sublayers of map image services (their group sublayers are walked, not
   *  listed). Titles carry the group path, e.g. "Utilities / Water / Mains".
   *  Ids are unique per entry: a map image sublayer is "<service id>::<sublayer id>". */
  featureLayerList = (): Array<{ id: string, title: string, layer: any }> => {
    const out: Array<{ id: string, title: string, layer: any }> = []
    try {
      const view: any = this.state.jimuMapView && this.state.jimuMapView.view
      const map: any = view && view.map
      const toArr = (c: any): any[] => (c ? (c.toArray ? c.toArray() : Array.from(c)) : [])
      const FEATURE = ['feature', 'geojson', 'csv', 'ogc-feature', 'wfs', 'subtype-group']
      const titleOf = (n: any): string => (n && n.title !== undefined && n.title !== null && String(n.title)) || ''
      // Walk the map's operational layers the way the layer list shows them
      // (top first). Basemap layers are never reached, listMode 'hide' drops
      // a layer and everything in it, 'hide-children' drops what is in it,
      // and anything turned off (or under a group that is off) is skipped.
      const walkSubs = (svc: any, subs: any[], path: string[]): void => {
        for (const sub of subs) {
          if (!sub || sub.visible === false || sub.listMode === 'hide') continue
          const kids = toArr(sub.sublayers)
          const here = path.concat(titleOf(sub) || String(sub.id))
          if (kids.length) {
            if (sub.listMode !== 'hide-children') walkSubs(svc, kids, here)
            continue
          }
          if (typeof sub.queryFeatures !== 'function') continue
          const sj: any = sub.sourceJSON
          if (sj && sj.type && String(sj.type) !== 'Feature Layer') continue
          if (sub.capabilities && sub.capabilities.operations && sub.capabilities.operations.supportsQuery === false) continue
          out.push({ id: String(svc.id) + '::' + String(sub.id), title: here.join(' / '), layer: sub })
        }
      }
      const walk = (layers: any[], path: string[]): void => {
        for (const l of layers.slice().reverse()) {
          if (!l || l.visible === false || l.listMode === 'hide') continue
          const type = String(l.type)
          const here = path.concat(titleOf(l) || String(l.id))
          if (type === 'group') {
            if (l.listMode !== 'hide-children') walk(toArr(l.layers), here)
            continue
          }
          if (type === 'map-image') {
            if (l.listMode !== 'hide-children') walkSubs(l, toArr(l.sublayers), here)
            continue
          }
          if (FEATURE.indexOf(type) < 0 || typeof l.queryFeatures !== 'function') continue
          out.push({ id: String(l.id), title: here.join(' / '), layer: l })
        }
      }
      if (map) walk(toArr(map.layers), [])
    } catch (e) { /* none */ }
    return out
  }

  /** The chosen page layer's list entry (first one when none is chosen). */
  featEntry = (): { id: string, title: string, layer: any } | null => {
    const list = this.featureLayerList()
    return list.find(x => x.id === this.state.seriesLayerId) || list[0] || null
  }

  featLayer = (): any => {
    const hit = this.featEntry()
    return hit ? hit.layer : null
  }

  /** Layers in unopened groups (and map image sublayers) are not loaded
   *  until something asks, so their fields are empty: load the chosen one
   *  once, then redraw the panel with its fields. */
  private featLoadAsked = new Set<any>()
  private ensureFeatLoaded = (layer: any): void => {
    if (!layer || layer.loaded || typeof layer.load !== 'function' || this.featLoadAsked.has(layer)) return
    this.featLoadAsked.add(layer)
    Promise.resolve(layer.load()).then(() => { this.featCache = null; this.forceUpdate(); this.updateSeriesPreview() }).catch(() => { /* not loadable */ })
  }

  /** Fields that make sensible page names (and sort keys). */
  /** Fields offered as the page name: only the ones published as visible.
   *  When the layer carries field settings (the web map's popup field list,
   *  which is where the map service or Map Viewer field visibility lives),
   *  only fields marked visible are offered, in that order and with those
   *  labels. Layers with no field settings offer every attribute field.
   *  Shape and geometry-size fields are never offered. */
  featFieldList = (layer: any): Array<{ name: string, alias: string }> => {
    const ok = ['string', 'integer', 'small-integer', 'big-integer', 'long', 'double', 'single', 'oid', 'date', 'date-only', 'guid', 'global-id']
    try {
      const fields: any[] = ((layer && layer.fields) || []).filter((f: any) => f && ok.indexOf(String(f.type)) >= 0)
      const shapeish = (n: string): boolean => /^(shape|shape[._]{1,2}(area|len|length)|st_area\(.*\)|st_length\(.*\))$/i.test(n)
      const byName = new Map<string, any>()
      for (const f of fields) byName.set(String(f.name).toLowerCase(), f)
      const pt: any = layer && layer.popupTemplate
      const infos: any[] = pt && pt.fieldInfos ? (pt.fieldInfos.toArray ? pt.fieldInfos.toArray() : Array.from(pt.fieldInfos)) : []
      const real = infos.filter((fi: any) => fi && fi.fieldName && !/^(expression|relationships)\//i.test(String(fi.fieldName)))
      if (real.length) {
        const out: Array<{ name: string, alias: string }> = []
        const seen = new Set<string>()
        for (const fi of real) {
          if (fi.visible === false) continue
          const f = byName.get(String(fi.fieldName).toLowerCase())
          if (!f || shapeish(String(f.name)) || seen.has(String(f.name))) continue
          seen.add(String(f.name))
          out.push({ name: String(f.name), alias: String(fi.label || f.alias || f.name) })
        }
        if (out.length) return out
      }
      return fields
        .filter((f: any) => !shapeish(String(f.name)))
        .map((f: any) => ({ name: String(f.name), alias: String(f.alias || f.name) }))
    } catch (e) { return [] }
  }

  /** The chosen name field if it is offered, else the display field, else
   *  the first offered field, else the object id. */
  featNameField = (layer: any): string => {
    const names = this.featFieldList(layer).map(f => f.name)
    if (this.state.seriesNameField && names.indexOf(this.state.seriesNameField) >= 0) return this.state.seriesNameField
    if (layer && layer.displayField && names.indexOf(layer.displayField) >= 0) return String(layer.displayField)
    // otherwise the first readable text field (an address or name reads far
    // better as a page name than an object id), then the first field
    const types: Record<string, string> = {}
    try { for (const f of ((layer && layer.fields) || [])) types[String(f.name)] = String(f.type) } catch (e) { /* none */ }
    const oid = String((layer && layer.objectIdField) || '')
    const text = names.find(n => types[n] === 'string' && n !== oid && !/^(globalid|guid|shape)/i.test(n))
    return String(text || names[0] || oid || '')
  }

  /** Attribute values as printed text: coded-value domains show their
   *  description, dates their local date. */
  private fmtAttrs = (layer: any, attrs: any): Record<string, string> => {
    const out: Record<string, string> = {}
    const fields: any[] = (layer && layer.fields) || []
    for (const k of Object.keys(attrs || {})) {
      const v = attrs[k]
      if (v === null || v === undefined) { out[k] = ''; continue }
      try {
        const dom: any = typeof layer.getFieldDomain === 'function' ? layer.getFieldDomain(k) : null
        if (dom && dom.type === 'coded-value' && typeof dom.getName === 'function') {
          const nm = dom.getName(v)
          if (nm !== null && nm !== undefined && nm !== '') { out[k] = String(nm); continue }
        }
      } catch (e) { /* raw value */ }
      const f = fields.find((x: any) => x && x.name === k)
      out[k] = f && f.type === 'date' && typeof v === 'number' ? new Date(v).toLocaleDateString() : String(v)
    }
    return out
  }

  /** Cache key: what decides WHICH features become pages. Scale and
   *  margin only re-lay the pages, so they are not part of it. */
  /** Filters on the page layer beyond its definition expression, as SQL
   *  where clauses: the layer view filter and the EB data source's current
   *  query (what Map Layers, Filter and Query widgets set). Best-effort;
   *  anything not readable is skipped. */
  featFilterWheres = (view: any, layer: any): string[] => {
    const out: string[] = []
    const add = (w: any): void => {
      const t = typeof w === 'string' ? w.trim() : ''
      if (!t || t === '1=1' || out.indexOf(t) >= 0) return
      if (layer && typeof layer.definitionExpression === 'string' && layer.definitionExpression.trim() === t) return
      out.push(t)
    }
    try {
      const lvs: any = view && view.allLayerViews
      const arr: any[] = lvs ? (lvs.toArray ? lvs.toArray() : Array.from(lvs)) : []
      const lv = arr.find((v: any) => v && v.layer === layer)
      if (lv && lv.filter && lv.filter.where) add(lv.filter.where)
    } catch (e) { /* no layer view filter */ }
    try {
      const jmv: any = this.state.jimuMapView
      const jlv: any = jmv && typeof jmv.getJimuLayerViewByAPILayer === 'function' ? jmv.getJimuLayerViewByAPILayer(layer) : null
      const ds: any = jlv && (typeof jlv.getLayerDataSource === 'function' ? jlv.getLayerDataSource() : jlv.layerDataSource)
      const qp: any = ds && typeof ds.getCurrentQueryParams === 'function' ? ds.getCurrentQueryParams() : null
      if (qp && qp.where) add(qp.where)
    } catch (e) { /* no data source filter */ }
    return out
  }

  featKey = (view: any, layer: any): string => {
    let ext = ''
    if (this.state.seriesScope === 'frame') {
      try { const g = this.printAreaPolygon(view); ext = 'f:' + (g ? g.rings[0].map((p: number[]) => Math.round(p[0]) + ' ' + Math.round(p[1])).join(',') : '?') } catch (e) { ext = '?' }
    } else if (this.state.seriesScope !== 'all') {
      try { const e = view.extent; ext = [e.xmin, e.ymin, e.xmax, e.ymax].map((v: number) => Math.round(v)).join(',') } catch (e) { ext = '?' }
    }
    const entry = this.featEntry()
    return [(entry && entry.layer === layer) ? entry.id : (layer && layer.id), this.state.seriesScope, this.featNameField(layer), this.state.seriesSortDesc ? 'desc' : 'asc', (layer && layer.definitionExpression) || '', this.featFilterWheres(view, layer).join(' AND '), ext].join('|')
  }

  /** Query the page features: in the current view or the whole layer,
   *  honoring the layer's own filter, sorted by the name field, capped. */
  fetchFeaturePages = async (view: any, layer: any): Promise<{ feats: FeaturePageInput[], total: number }> => {
    if (typeof layer.load === 'function') await layer.load()
    this.featUnsorted = false
    const CAP = this.seriesLimits().max
    const nameField = this.featNameField(layer)
    const q: any = typeof layer.createQuery === 'function' ? layer.createQuery() : {}
    if (!q.where) q.where = '1=1'
    // honor every filter the map shows: the layer's own definition
    // expression (applied by the layer itself), a layer view filter, and the
    // Experience Builder data source filter (Map Layers, Filter, Query ...)
    const extra = this.featFilterWheres(view, layer)
    if (extra.length) q.where = ['(' + q.where + ')'].concat(extra.map(w => '(' + w + ')')).join(' AND ')
    if (this.state.seriesScope === 'frame') {
      // only features inside the print area (the rectangle on the map)
      const g = this.printAreaPolygon(view)
      q.geometry = g ? new Polygon(g) : view.extent
      q.spatialRelationship = 'intersects'
    } else if (this.state.seriesScope !== 'all') { q.geometry = view.extent; q.spatialRelationship = 'intersects' }
    q.returnGeometry = true
    q.outFields = ['*']
    q.outSpatialReference = view.spatialReference
    let total = 0
    try { total = Number(await layer.queryFeatureCount(q)) || 0 } catch (e) { /* count optional */ }
    // one extra so an over-limit layer is detected even when the count
    // query fails
    q.num = CAP + 1
    let res: any
    try {
      if (nameField) q.orderByFields = [nameField + (this.state.seriesSortDesc ? ' DESC' : ' ASC')]
      res = await layer.queryFeatures(q)
    } catch (e) {
      // some sources cannot sort server-side: sort here instead (then the
      // "first N" over the limit are not strictly the first by name)
      q.orderByFields = null
      res = await layer.queryFeatures(q)
      this.featUnsorted = true
    }
    const list: any[] = (res && res.features) || []
    const feats: FeaturePageInput[] = []
    for (const f of list) {
      const g: any = f && f.geometry
      if (!g) continue
      let ex: any = g.extent
      if (!ex && isFinite(g.x) && isFinite(g.y)) ex = { xmin: g.x, xmax: g.x, ymin: g.y, ymax: g.y }
      if (!ex) continue
      const fields = this.fmtAttrs(layer, f.attributes)
      feats.push({
        xmin: ex.xmin, ymin: ex.ymin, xmax: ex.xmax, ymax: ex.ymax,
        name: nameField ? (fields[nameField] || '') : '',
        fields,
        geoms: this.overlayGeoms(g).map(x => x.g)
      })
    }
    if (nameField) {
      // keep a stable, human order even when the service ignored orderBy
      const dir = this.state.seriesSortDesc ? -1 : 1
      feats.sort((a, b) => dir * String(a.name || '').localeCompare(String(b.name || ''), undefined, { numeric: true, sensitivity: 'base' }))
    }
    // the extra feature only proves the layer is over the limit
    const found = Math.max(total, list.length)
    return { feats: feats.slice(0, CAP), total: found }
  }

  refreshFeaturePages = async (): Promise<void> => {
    const view: any = this.state.jimuMapView && this.state.jimuMapView.view
    const layer = this.featLayer()
    if (!view || !layer) { this.featCache = null; this.setState({ featCount: 0, featLoading: false }); return }
    const key = this.featKey(view, layer)
    if (this.featCache && this.featCache.key === key) return
    const seq = ++this.featSeq
    if (!this.state.featLoading) this.setState({ featLoading: true })
    try {
      const r = await this.fetchFeaturePages(view, layer)
      if (seq !== this.featSeq) return
      this.featCache = { key, feats: r.feats, total: r.total }
      this.setState({ featCount: r.total, featLoading: false }, () => this.updateSeriesPreview())
    } catch (e) {
      if (seq !== this.featSeq) return
      this.featCache = { key, feats: [], total: 0 }
      this.setState({ featCount: 0, featLoading: false })
    }
  }

  /** Page tiles for the fetched features at a frame size. */
  featTilesFor = (view: any, fw: number, fh: number, feats: FeaturePageInput[]): any[] => {
    const mpu = metersPerMapUnit(view.scale, view.resolution)
    const fixed = Math.max(0, parseInt(String(this.state.seriesFixedScale).replace(/[^0-9]/g, ''), 10) || 0)
    return featurePageTiles(feats, fw, fh, mpu, {
      mode: this.state.seriesScaleMode === 'fixed' && fixed > 0 ? 'fixed' : 'fit',
      marginPct: Math.max(0, Math.min(200, parseFloat(this.state.seriesMargin) || 0)),
      fixedScale: fixed,
      pointScale: fixed > 0 ? fixed : 1200
    })
  }

  seriesPageCount = (): number => {
    if (this.seriesFeatures()) {
      const n = this.featCache ? Math.min(this.featCache.total, this.seriesLimits().max) : 0
      return n > 0 ? n + 1 : 0
    }
    const r = Math.max(1, Math.min(8, parseInt(this.state.seriesRows, 10) || 1))
    const c = Math.max(1, Math.min(8, parseInt(this.state.seriesCols, 10) || 1))
    return r * c + 1
  }

  onExportSeries = async (): Promise<void> => {
    const { jimuMapView } = this.state
    const layout = this.getSelectedLayout()
    const view: any = jimuMapView && jimuMapView.view
    if (!view || !layout) return
    if (this.seriesBlocked()) return
    this.beacon?.action(this.seriesFeatures() ? 'export-series-features' : 'export-series')
    this.beginBusyClock(); this.seriesSheetStart = 0; this.seriesSheetsDone = 0; this.seriesCancelled = false
    this.setState({ busy: true, error: null, note: '', status: 'Preparing series\u2026', seriesStep: { done: 0, total: 1, kind: 'prep', page: 0, pageCount: 0 } })
    try {
      const mfEl: any = (layout.elements || []).find((e: any) => e.type === 'mapFrame')
      const ext = view.extent
      const rows = Math.max(1, Math.min(8, parseInt(this.state.seriesRows, 10) || 1))
      const cols = Math.max(1, Math.min(8, parseInt(this.state.seriesCols, 10) || 1))
      const mpu = metersPerMapUnit(view.scale, view.resolution)
      // tiles for a given frame size: the export calls this back with the
      // EXACT effective frame once the legend panel (if any) has shrunk it,
      // so the printed grid always matches the frame it prints in
      const tilesFor = (fw: number, fh: number) => {
        const env2 = this.seriesScaleEnv(envelopeForFrame(
          { xmin: ext.xmin, ymin: ext.ymin, xmax: ext.xmax, ymax: ext.ymax },
          rows, cols, fw, fh, 0.1))
        const t2 = gridTilesByCount(env2, rows, cols, fw, fh, 0.1)
        return { tiles: t2, scaleDenom: Math.ceil(((t2[0].xmax - t2[0].xmin) * mpu) / (fw * 0.0254)) }
      }
      // initial estimate from the preview's effective frame; the export
      // refines it through retile once the panel is computed exactly
      const mfEst: any = this.effFrameOf() || mfEl
      // data-driven pages: fresh query at export time, never the preview cache
      let featTotal = 0
      let featTilesFor: ((fw: number, fh: number) => { tiles: any[], scaleDenom: number }) | null = null
      if (this.seriesFeatures()) {
        const layer = this.featLayer()
        if (!layer) throw new Error((defaultMessages as any).seriesNoLayer)
        this.setState({ status: (defaultMessages as any).seriesFetching })
        const r = await this.fetchFeaturePages(view, layer)
        featTotal = r.total
        if (this.seriesCancelled) throw new Error('SERIES_CANCELLED')
        if (!r.feats.length) throw new Error((defaultMessages as any).seriesNoFeatures)
        // the fresh count can differ from the panel's (data edits, filters):
        // hold the limit here too
        const L = this.seriesLimits()
        if (r.total > L.max && L.mode !== 'first') {
          throw new Error(String((defaultMessages as any).seriesOverFeat).replace('{n}', String(r.total)).replace(/\{max\}/g, String(L.max)))
        }
        featTilesFor = (fw: number, fh: number) => {
          const t2 = this.featTilesFor(view, fw, fh, r.feats)
          return { tiles: t2, scaleDenom: Math.max(...t2.map((t: any) => Number(t.scale) || 0)) }
        }
      }
      const first = featTilesFor ? featTilesFor(mfEst.wIn, mfEst.hIn) : tilesFor(mfEst.wIn, mfEst.hIn)
      let tiles = first.tiles
      const scaleDenom = first.scaleDenom
      const options: RenderOptions = {}
      if (this.state.qrOn) {
        try {
          const qu = this.qrSafeUrl()
          if (qu) {
            (options as any).qrUrl = qu;
            (options as any).qrCaption = (defaultMessages as any).qrCaption || 'Scan for interactive map'
          }
        } catch (e) { /* QR is best-effort */ }
      }
      if (this.state.author) options.author = this.state.author
      if (this.state.copyright) options.copyright = this.state.copyright
      const cfgLogo = (this.props.config as any)?.defaultLogo
      if (cfgLogo) options.defaultLogo = cfgLogo
      options.includeLegend = this.state.includeLegend
      // data-driven pages get a locator overview per page (main Overview
      // switch); grid series print their key map instead
      options.showOverview = this.seriesFeatures() ? this.state.showOverview : false
      options.showGrid = this.state.showGrid
      if (this.state.legendPositionOv) options.legendPositionOverride = this.state.legendPositionOv
      // grid type and style choices apply to every sheet too
      if (this.state.gridTypeOv) options.gridTypeOverride = this.state.gridTypeOv
      this.applyGridStyle(options)
      if ((this.cfg() as any).legendWidgetId) options.legendWidgetId = String((this.cfg() as any).legendWidgetId)
      if ((this.props.config as any)?.includeAttribution !== false) {
        options.attribution = this.captureAttribution(view)
      }
      // the export reports the exact legend panel back, so the live series
      // grid preview matches the shrunken frame precisely from then on
      options.onPanelComputed = (panel) => { this.lastPanel = panel }
      options.isCancelled = () => this.seriesCancelled
      const family = this.state.fontFamily || (this.props.config as any)?.defaultFontFamily || ''
      const customs = this.customFontList()
      if (family.indexOf('custom:') === 0) {
        const nm = family.slice('custom:'.length)
        const f = customs.find(x => x.name === nm) || customs[0]
        if (f) options.customFont = f
      } else if (family === 'custom') {
        if (customs[0]) options.customFont = customs[0]
      } else if (family) {
        options.fontFamily = family as any
      }
      await this.applyTextContext(view, options)
      // the series draws its own page outlines and numbers on the map; the
      // sweep skips those by their marker, so a real selection still prints
      // on whichever sheets it falls on
      await this.collectViewDecorations(view, options)
      const effLayout = this.state.dpi ? { ...layout, dpi: Number(this.state.dpi) } : layout
      const maxImagePx = Number((this.props.config as any)?.maxImagePx) || 0
      const name = (this.buildFileName(layout) || 'map-series').replace(/\.pdf$/i, '') + (featTilesFor ? '-pages.pdf' : '-series.pdf')
      const cap = this.seriesLimits().max
      const result = await renderSeries(
        view, effLayout, this.state.title || layout.name || 'Map', name, maxImagePx,
        {
          tiles,
          scaleDenom,
          kind: featTilesFor ? 'features' : 'grid',
          retile: (fw: number, fh: number) => {
            const rt = featTilesFor ? featTilesFor(fw, fh) : tilesFor(fw, fh)
            tiles = rt.tiles // progress highlight follows the final grid
            return rt
          }
        }, options,
        (msg: string) => {
          this.setState({ status: msg })
          const pm = /^Exporting page (\d+) of (\d+)/i.exec(msg || '')
          if (pm) this.highlightSeriesTile(tiles, parseInt(pm[1], 10))
        },
        this.onSeriesStep
      )
      this.setState({
        busy: false,
        status: '',
        seriesStep: null,
        results: this.pushResult({
          name: result.fileName,
          url: result.url,
          meta: result.pages + ' pages \u00b7 ' + result.sizeKb + ' KB' +
            (featTotal > cap ? ' \u00b7 ' + String((defaultMessages as any).seriesCapped || '').replace('{cap}', String(cap)).replace('{n}', String(featTotal)) : '') +
            (result.warning ? ' \u00b7 ' + result.warning : '')
        })
      }, () => this.updateSeriesPreview())
    } catch (err: any) {
      if (!(err && err.message === 'SERIES_CANCELLED')) this.beacon?.error(err, 'export-series')
      const cancelled = !!(err && err.message === 'SERIES_CANCELLED')
      this.setState({ busy: false, status: '', seriesStep: null, note: cancelled ? String((defaultMessages as any).seriesCancelledNote || '') : '', error: cancelled ? null : ((err && err.message) || 'Series export failed.') }, () => {
        this.updateSeriesPreview()

      })
    }
  }

  describeLayout = (layout: PrintLayout): string => {
    return layout.pageWidthIn + ' × ' + layout.pageHeightIn + ' in · ' + layout.dpi + ' DPI · ' +
      (layout.preserve === 'scale' ? 'keeps map zoom level' : 'prints what you see')
  }

  getStyle = () => css`
    padding: 0;
    height: 100%;
    overflow: hidden;
    display: flex;
    flex-direction: column;
    position: relative;
    .pd-scroll { flex: 1 1 auto; overflow: auto; padding: 12px; min-height: 0; position: relative; }
    /* widget header: Help lives at the right, icon only, same as Droplets */
    .pd-topbar { flex: 0 0 auto; display: flex; align-items: center; justify-content: flex-end;
      padding: 4px 8px 0 8px; }

    /* The first-run hint is rendered by components/FirstRunHint.tsx, using
       useTokens() inline styles rather than CSS variables. The handoff's
       contrast lesson forbids a theme's info.light as a banner background:
       some Experience themes define it as a saturated color, and this one
       painted a solid blue block with white text. tokens.infoBg mixes the
       primary into the surface at 10 percent instead. */
    .pd-veil { position: absolute; left: 0; right: 0; top: 0; bottom: 0; z-index: 5;
      background: rgba(255, 255, 255, 0.72); }
    .pd-veil-inner { position: sticky; top: 32%; display: flex; justify-content: center; }
    .pd-veil-card { background: var(--sys-color-surface-paper, #fff); border: 1px solid var(--ref-palette-neutral-500, #d5d5d5);
      border-radius: 8px; box-shadow: 0 4px 14px rgba(0, 0, 0, 0.14); padding: 16px 20px; text-align: center; max-width: 250px;
      display: flex; flex-direction: column; align-items: center; gap: 8px; }
    .pd-veil-title { font-size: 13px; font-weight: 700; color: var(--ref-palette-neutral-1100, #2b2b2b); }
    .pd-veil-status { font-size: 11px; color: var(--sys-color-primary-dark, #0a5dc2); font-weight: 600; }
    .pd-dock {
      flex: 0 0 auto;
      padding: 10px 12px;
      border-top: 1px solid var(--ref-palette-neutral-500, #d5d5d5);
      background: var(--sys-color-surface-paper, #fff);
      box-shadow: 0 -3px 8px rgba(0, 0, 0, 0.07);
    }
    .pd-queue { margin-top: 8px; }
    .pd-q-head { display: flex; align-items: center; justify-content: space-between; margin-bottom: 4px; }
    .pd-q-title { font-size: 11px; font-weight: 700; color: var(--ref-palette-neutral-1100, #333); display: flex; align-items: center; gap: 6px; }
    .pd-q-count { background: var(--sys-color-primary-main, #076fe5); color: #fff; border-radius: 9px; font-size: 10px; font-weight: 700; padding: 0 6px; line-height: 15px; min-width: 15px; text-align: center; }
    .pd-q-list { list-style: none; margin: 0; padding: 0; max-height: 132px; overflow: auto; }
    .pd-q-row { display: flex; align-items: center; gap: 7px; font-size: 11px; padding: 4px 2px; border-radius: 4px; }
    .pd-q-row + .pd-q-row { border-top: 1px solid var(--ref-palette-neutral-300, #f0f0f0); }
    .pd-q-active { color: var(--ref-palette-neutral-1100, #444); }
    .pd-q-new { animation: pdQFlash 1.6s ease-out 1; }
    /* Tint the primary into the surface rather than using info.light, which
       some Experience themes define as a saturated color (handoff 11.2). */
    @keyframes pdQFlash {
      0% { background: #eef4fb; background: color-mix(in srgb, var(--sys-color-primary-main, #0079c1) 12%, var(--sys-color-surface-paper, #fff)); }
      100% { background: transparent; }
    }
    .pd-q-pill { flex: 0 0 auto; font-size: 9px; font-weight: 700; letter-spacing: 0.03em;
      color: var(--sys-color-primary-main, #0079c1);
      background: #eef4fb;
      background: color-mix(in srgb, var(--sys-color-primary-main, #0079c1) 12%, var(--sys-color-surface-paper, #fff));
      border-radius: 3px; padding: 1px 5px; }
    .pd-q-name { flex: 1 1 auto; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .pd-q-meta { flex: 0 0 auto; color: var(--ref-palette-neutral-1000, #6a6a6a); white-space: nowrap; font-size: 10px; }
    .pd-q-busy { display: block; }
    .pd-q-busyline { display: flex; align-items: center; gap: 7px; }
    .pd-q-barwrap { margin: 5px 2px 2px; height: 5px; border-radius: 3px; background: var(--ref-palette-neutral-400, #e2e2e2); overflow: hidden; }
    .pd-q-bar { height: 100%; background: var(--sys-color-primary-main, #076fe5); border-radius: 3px; transition: width 0.5s ease; }
    .pd-sp-head { font-weight: 600; }
    .pd-gstyle { border-left: 2px solid var(--ref-palette-neutral-500, #d0d0d0); padding-left: 8px; margin: 2px 0 6px; }
    .pd-gs-head { font-size: 11px; font-weight: 600; margin: 6px 0 2px; }
    .pd-color { width: 44px; height: 24px; padding: 0; border: 1px solid var(--ref-palette-neutral-600, #b0b0b0); border-radius: 3px; background: none; cursor: pointer; }
    .pd-color:focus-visible { outline: 2px solid var(--sys-color-primary-main, #076fe5); outline-offset: 1px; }
    .pd-sp-actions { display: flex; justify-content: flex-end; margin-top: 2px; }
    .pd-sp-track { display: flex; gap: 2px; margin: 6px 2px 3px; height: 8px; border-radius: 4px; overflow: hidden; background: var(--ref-palette-neutral-400, #e2e2e2); }
    .pd-sp-seg { flex: 1 1 0; min-width: 2px; background: var(--ref-palette-neutral-400, #e2e2e2); }
    .pd-sp-seg.is-done { background: var(--sys-color-primary-main, #076fe5); }
    .pd-sp-seg.is-active { background: var(--sys-color-primary-light, #7fb2f0); animation: pd-sp-pulse 1.2s ease-in-out infinite; }
    .pd-sp-fill { display: block; height: 100%; background: var(--sys-color-primary-main, #076fe5); transition: width 0.5s ease; }
    .pd-sp-foot { display: flex; justify-content: space-between; gap: 8px; font-size: 10px; color: var(--ref-palette-neutral-1000, #6a6a6a); padding: 0 2px; }
    .pd-sp-sub { margin-top: 2px; font-size: 10px; color: var(--ref-palette-neutral-1000, #6a6a6a); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; padding: 0 2px; }
    @keyframes pd-sp-pulse { 0%, 100% { opacity: 1; } 50% { opacity: 0.45; } }
    @media (prefers-reduced-motion: reduce) { .pd-sp-seg.is-active { animation: none; } .pd-sp-fill { transition: none; } }
    .pd-q-slow { margin-top: 4px; font-size: 10px; color: var(--ref-palette-neutral-1000, #6a6a6a); font-style: italic; }
    .pd-busy-banner { margin-top: 8px; font-size: 12.5px; font-weight: 700; color: var(--sys-color-primary-dark, #0a5dc2); }
    .pd-range { flex: 1 1 auto; min-width: 90px; accent-color: var(--sys-color-primary-main, #076fe5); }
    .pd-thumb { margin: 6px 0 2px; display: flex; align-items: flex-end; gap: 8px; }
    .pd-thumb svg { display: block; border-radius: 2px; box-shadow: 0 1px 3px rgba(0,0,0,0.12); }
    .pd-thumb-badge { font-size: 10px;
      color: var(--sys-color-primary-main, #0079c1);
      background: #eef4fb;
      background: color-mix(in srgb, var(--sys-color-primary-main, #0079c1) 12%, var(--sys-color-surface-paper, #fff));
      border-radius: 3px; padding: 1px 6px; }
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
    .pd-card-btn { all: unset; box-sizing: border-box; display: flex; width: 100%; justify-content: space-between; align-items: center; gap: 8px; cursor: pointer; margin-bottom: 10px; border-radius: 3px; }
    .pd-card-btn.is-closed { margin-bottom: 0; }
    .pd-card-btn:hover .pd-pa-title { text-decoration: underline; }
    .pd-card-btn:focus-visible { outline: 2px solid var(--sys-color-primary-main, #007ac2); outline-offset: 3px; }
    .pd-card-left { display: inline-flex; align-items: center; gap: 6px; min-width: 0; }
    .pd-card-body > .pd-row:last-of-type { margin-bottom: 0; }
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

  /** File-type pill text from a result name. */
  resultKind = (name: string): string => {
    const m = /\.([a-z0-9]+)$/i.exec(name || '')
    return m ? m[1].toUpperCase() : 'FILE'
  }

  /** The export dock: pinned beneath the scrolling options so the Export
   *  button and the job queue stay visible even with Advanced options
   *  expanded. Shared by service and pagx modes. */
  /* ---------------------------------------------------------------- */
  /* live page preview                                                */
  /* ---------------------------------------------------------------- */

  private previewPageTimer: any = null
  private previewPageRunning = false
  private previewPageAgain = false
  private lastPreviewSig = ''

  /** Everything the page shows that lives in widget state. A change here
   *  (or a pan/zoom, via the extent watcher) redraws the preview. */
  pagePreviewSig = (): string => {
    const s: any = this.state
    return [s.selectedLayoutId, s.title, s.author, s.copyright, s.includeLegend, s.showGrid, s.showOverview,
      s.legendPositionOv, s.gridTypeOv, s.gridStyleJson, s.naStyle, s.sbStyle, s.sbUnits, s.sbUnits2, s.fontFamily, s.qrOn,
      s.scaleMode, s.fixedScale, s.locked, s.mapOnly, s.includeSelection, s.outWkid].join('|')
  }

  queuePagePreview = (): void => {
    if (!this.state.pagePreviewOn) return
    if (this.previewPageTimer) clearTimeout(this.previewPageTimer)
    this.previewPageTimer = setTimeout(() => { void this.runPagePreview() }, 700)
  }

  /** Options for the preview: the same page-shaping choices the export
   *  uses, minus anything that only matters to the file (georeference,
   *  KMZ, custom font files, capture limits). */
  private buildPreviewOptions = async (view: any): Promise<RenderOptions> => {
    const options: RenderOptions = {}
    if (this.state.naStyle) options.northArrowStyle = this.state.naStyle as any
    if (this.state.sbStyle) options.scaleBarStyle = this.state.sbStyle as any
    if (this.state.sbUnits) options.scaleBarUnits = this.state.sbUnits as any
    if (this.state.sbUnits2 && (this.state.sbStyle === 'doubleAlternating' || this.state.sbStyle === 'hollowDouble')) options.scaleBarUnits2 = this.state.sbUnits2 as any
    const cfgLogo = (this.props.config as any)?.defaultLogo
    if (cfgLogo) options.defaultLogo = cfgLogo
    if (this.meEnabled()) {
      if (this.state.locked && this.lockedCenter && this.lockedScale) {
        options.scaleMode = 'fixed'; options.fixedScale = this.lockedScale; options.lockedCenter = this.lockedCenter
      } else {
        options.scaleMode = this.state.scaleMode as any
        if (this.state.scaleMode === 'fixed') options.fixedScale = Number(this.state.fixedScale) || undefined
      }
    }
    if (this.state.qrOn) {
      const qu = this.qrSafeUrl()
      if (qu) { (options as any).qrUrl = qu; (options as any).qrCaption = (defaultMessages as any).qrCaption || 'Scan for interactive map' }
    }
    if (this.state.author) options.author = this.state.author
    if (this.state.copyright) options.copyright = this.state.copyright
    if ((this.props.config as any)?.includeAttribution !== false) options.attribution = this.captureAttribution(view)
    options.includeLegend = this.state.includeLegend
    options.showOverview = this.state.showOverview
    options.showGrid = this.state.showGrid
    if (this.state.legendPositionOv) options.legendPositionOverride = this.state.legendPositionOv
    if (this.state.gridTypeOv) options.gridTypeOverride = this.state.gridTypeOv
    this.applyGridStyle(options)
    if (this.outSREnabled() && parseInt(this.state.outWkid, 10) > 0) options.outputWkid = parseInt(this.state.outWkid, 10)
    if (this.meMapOnly() && this.state.mapOnly) options.mapOnly = true
    const family = this.state.fontFamily || (this.props.config as any)?.defaultFontFamily || ''
    if (family && family.indexOf('custom') !== 0) options.fontFamily = family as any
    await this.applyTextContext(view, options)
    // selection outline, in the LIVE view's system (the preview is not reprojected)
    const out = options.outputWkid
    delete options.outputWkid
    try { await this.collectViewDecorations(view, options) } catch (e) { /* no selection */ }
    if (out) options.outputWkid = out
    return options
  }

  runPagePreview = async (): Promise<void> => {
    if (!this.state.pagePreviewOn || !this.uiVisible) return
    if (this.previewPageRunning) { this.previewPageAgain = true; return }
    const view: any = this.state.jimuMapView && this.state.jimuMapView.view
    const layout = this.getSelectedLayout()
    if (!view || !layout || this.state.busy || this.printSource() === 'service') return
    this.previewPageRunning = true
    this.lastPreviewSig = this.pagePreviewSig()
    if (!this.state.pagePreviewBusy) this.setState({ pagePreviewBusy: true })
    try {
      const options = await this.buildPreviewOptions(view)
      let rows: any[] = []
      if (this.state.includeLegend) {
        try {
          const dom = findLegendDom(String((this.cfg() as any).legendWidgetId || '') || undefined)
          if (dom) rows = await harvestLegendDom(dom)
        } catch (e) { rows = [] }
      }
      const r = await renderPagePreview(view, layout, this.state.title || layout.name || 'Map', options, rows, 640)
      const m: any = defaultMessages
      const note = String(m.pagePreviewScale || '1:{scale}').replace('{scale}', r.printedScale.toLocaleString()) +
        (r.notes.length ? ' \u00b7 ' + r.notes.join(' \u00b7 ') : '')
      this.setState({ pagePreviewUrl: r.dataUrl, pagePreviewNote: note, pagePreviewBusy: false })
    } catch (e: any) {
      this.setState({ pagePreviewBusy: false, pagePreviewNote: (defaultMessages as any).pagePreviewFailed })
    } finally {
      this.previewPageRunning = false
      if (this.previewPageAgain) { this.previewPageAgain = false; this.queuePagePreview() }
    }
  }

  /** Series panel body for data-driven pages. */
  renderFeaturePagesPanel = (messages: any): React.ReactNode => {
    const layers = this.featureLayerList()
    const entry = this.featEntry()
    const layer = entry ? entry.layer : null
    this.ensureFeatLoaded(layer)
    const fields = this.featFieldList(layer)
    const cap = this.seriesLimits().max
    const total = this.featCache ? this.featCache.total : null
    let estimate: string
    if (!layers.length) estimate = messages.seriesNoLayer
    else if (this.state.featLoading || total === null) estimate = messages.seriesFetching
    else if (total === 0) estimate = messages.seriesNoFeatures
    else if (total > cap) estimate = String(messages.seriesFeatFound).replace('{n}', String(total))
    else estimate = String(messages.seriesFeatEstimate).replace('{f}', String(total)).replace('{n}', String(total + 1))
    return (
      <React.Fragment>
        <div className='pd-desc'>{messages.seriesFeatHint}</div>
        {layers.length > 0 && (
        <React.Fragment>
        <div className='pd-row'>
          <Label className='pd-label' id={this.uid('slayer') + '-lbl'}>{messages.seriesLayer}</Label>
          <Select size='sm' aria-labelledby={this.uid('slayer') + '-lbl'} value={(entry && entry.id) || ''}
            onChange={(e: any) => this.setState({ seriesLayerId: e.target.value, seriesNameField: '' })}>
            {layers.map(l => <option key={l.id} value={l.id}>{l.title}</option>)}
          </Select>
        </div>
        <div className='pd-row'>
          <Label className='pd-label' id={this.uid('sname') + '-lbl'}>{messages.seriesNameField}</Label>
          <Select size='sm' aria-labelledby={this.uid('sname') + '-lbl'} value={this.featNameField(layer)}
            onChange={(e: any) => this.setState({ seriesNameField: e.target.value })}>
            {fields.map(f => <option key={f.name} value={f.name}>{f.alias}</option>)}
          </Select>
          <div className='pd-desc'>{messages.seriesNameHint}</div>
        </div>
        <div className='pd-row pd-inline'>
          <Label className='pd-label' id={this.uid('ssort') + '-lbl'}>{messages.seriesOrder}</Label>
          <Select size='sm' aria-labelledby={this.uid('ssort') + '-lbl'} value={this.state.seriesSortDesc ? 'desc' : 'asc'} style={{ width: 120 }}
            onChange={(e: any) => this.setState({ seriesSortDesc: e.target.value === 'desc' })}>
            <option value='asc'>{messages.seriesOrderAsc}</option>
            <option value='desc'>{messages.seriesOrderDesc}</option>
          </Select>
        </div>
        <div className='pd-row'>
          <Label className='pd-label' id={this.uid('sscope') + '-lbl'}>{messages.seriesScope}</Label>
          <Select size='sm' aria-labelledby={this.uid('sscope') + '-lbl'} value={this.state.seriesScope}
            onChange={(e: any) => this.setState({ seriesScope: e.target.value }, () => this.updatePreview())}>
            <option value='view'>{messages.seriesScopeView}</option>
            <option value='frame'>{messages.seriesScopeFrame}</option>
            <option value='all'>{messages.seriesScopeAll}</option>
          </Select>
          <div className='pd-desc'>{this.state.seriesScope === 'frame' ? messages.seriesScopeFrameHint : this.state.seriesScope === 'all' ? messages.seriesScopeAllHint : messages.seriesScopeViewHint}</div>
        </div>
        <div className='pd-row pd-inline'>
          <Label className='pd-label' id={this.uid('sscale') + '-lbl'}>{messages.seriesPageScale}</Label>
          <Select size='sm' aria-labelledby={this.uid('sscale') + '-lbl'} value={this.state.seriesScaleMode} style={{ width: 120 }}
            onChange={(e: any) => this.setState({ seriesScaleMode: e.target.value })}>
            <option value='fit'>{messages.seriesScaleFit}</option>
            <option value='fixed'>{messages.seriesScaleFixed}</option>
          </Select>
          {this.state.seriesScaleMode === 'fixed'
            ? (<React.Fragment>
                <span className='pd-desc'>1:</span>
                <TextInput size='sm' style={{ width: 90 }} aria-label={messages.seriesScaleFixed}
                  value={this.state.seriesFixedScale} onChange={(e) => this.setState({ seriesFixedScale: e.target.value })} />
              </React.Fragment>)
            : (<React.Fragment>
                <TextInput size='sm' style={{ width: 56 }} aria-label={messages.seriesMargin}
                  value={this.state.seriesMargin} onChange={(e) => this.setState({ seriesMargin: e.target.value })} />
                <span className='pd-desc'>{messages.seriesMargin}</span>
              </React.Fragment>)}
        </div>
        </React.Fragment>
        )}
        <div className='pd-desc' role='status' aria-live='polite'>{estimate}</div>
        {this.renderSeriesLimit(messages)}
      </React.Fragment>
    )
  }

  renderExportDock = (messages: any): React.ReactNode => {
    const hasQueue = this.state.busy || !!this.state.error || this.state.results.length > 0
    return (
      <div className='pd-dock'>
        <Tooltip title={this.state.jimuMapView ? messages.exportTip : messages.exportNoMap} placement='top'>
          <Button
            className='pd-export'
            type='primary'
            aria-busy={this.state.busy}
            aria-describedby={!this.state.jimuMapView ? this.uid('export-desc') : undefined}
            disabled={this.state.busy || !this.state.jimuMapView ||
              (this.state.seriesOpen && this.state.format === 'pdf' && this.ctrl('series') &&
                (this.seriesBlocked() || (this.seriesFeatures() && (this.state.featLoading || this.seriesPageCount() === 0))))}
            onClick={this.onExport}
          >
            {this.state.busy
              ? messages.exporting
              : (this.state.seriesOpen && this.state.format === 'pdf'
                  ? messages.exportSeriesN.replace('{n}', String(this.seriesPageCount()))
                  : messages.exportButton)}
          </Button>
        </Tooltip>
        {!this.state.jimuMapView && (
          <span id={this.uid('export-desc')} className='pd-sr-only'>{messages.exportNoMap}</span>
        )}
        {this.state.busy && !!this.state.status && (
          // a map series shows its own progress row (with one live headline)
          <div className='pd-busy-banner' role='status' aria-live={this.state.seriesStep ? 'off' : 'polite'}>{this.state.status}</div>
        )}
        <div role='alert' aria-live='assertive'>
          {this.state.error && (
            <div style={{ marginTop: 8 }}>
              <Alert type='error' text={this.state.error} withIcon style={{ width: '100%' }} />
            </div>
          )}
        </div>
        {this.state.note && !this.state.busy && (
          <div className='pd-desc' role='status' aria-live='polite' style={{ marginTop: 6 }}>{this.state.note}</div>
        )}
        {hasQueue && (
          <div className='pd-queue' role='status' aria-live={this.state.busy ? 'off' : 'polite'}>
            <div className='pd-q-head'>
              <span className='pd-q-title'>
                {messages.resultsLabel}
                {this.state.results.length > 0 && <span className='pd-q-count'>{this.state.results.length}</span>}
              </span>
              {this.state.results.length > 0 && (
                <Tooltip title={messages.resultsClearTip} placement='top'>
                  <Button size='sm' type='tertiary' className='pd-results-clear'
                    aria-label={messages.resultsClear} onClick={this.clearResults}>{messages.resultsClear}</Button>
                </Tooltip>
              )}
            </div>
            <ul className='pd-q-list'>
              {this.state.busy && (() => {
                const elapsed = Math.max(0, Math.round((Date.now() - this.busyStart) / 1000))
                const mm = Math.floor(elapsed / 60); const ss = String(elapsed % 60).padStart(2, '0')
                if (this.state.seriesStep) return this.renderSeriesProgress(this.state.seriesStep, messages, mm + ':' + ss)
                const m = /page (\d+) of (\d+)/i.exec(this.state.status || '')
                const frac = m ? Math.min(0.97, (parseInt(m[1], 10) - 1) / (parseInt(m[2], 10) + 1)) : -1
                return (
                  <li className='pd-q-row pd-q-active pd-q-busy'>
                    <div className='pd-q-busyline'>
                      <Loading type={LoadingType.Donut} width={14} height={14} />
                      <span className='pd-q-name'>{this.state.status || messages.exporting}</span>
                      <span className='pd-q-meta' aria-hidden='true'>{mm}:{ss}</span>
                    </div>
                    {frac >= 0 && (
                      <div className='pd-q-barwrap' aria-hidden='true'>
                        <div className='pd-q-bar' style={{ width: Math.round(frac * 100) + '%' }} />
                      </div>
                    )}
                    {elapsed > 20 && (
                      <div className='pd-q-slow'>{messages.exportSlowNotice}</div>
                    )}
                  </li>
                )
              })()}
              {this.state.results.map((r, i) => (
                <li key={r.url + r.name} className={'pd-q-row' + (i === 0 && !this.state.busy ? ' pd-q-new' : '')}>
                  <span className='pd-q-pill' aria-hidden='true'>{this.resultKind(r.name)}</span>
                  <a className='pd-q-name' href={r.url} download={r.name}>{r.name}</a>
                  <span className='pd-q-meta'>{r.meta}</span>
                  <button type='button' className='pd-results-del' title={messages.resultRemove}
                    aria-label={messages.resultRemove + ': ' + r.name}
                    onClick={() => this.removeResult(i)}><span aria-hidden='true'>×</span></button>
                </li>
              ))}
            </ul>
          </div>
        )}
      </div>
    )
  }

  render (): React.ReactNode {
    const { useMapWidgetIds } = this.props
    const layouts = this.getLayouts()
    const layout = this.getSelectedLayout()
    const messages = defaultMessages as any

    if (!useMapWidgetIds || useMapWidgetIds.length === 0) {
      return <WidgetPlaceholder icon={printIcon} message={messages.selectMapHint} widgetId={this.props.id} />
    }

    return (
      <div css={this.getStyle()} ref={this.rootRef}>
        <JimuMapViewComponent
          useMapWidgetId={useMapWidgetIds[0]}
          onActiveViewChange={this.onActiveViewChange}
        />

        <HelpPopup
          open={this.state.helpOpen}
          onClose={() => this.setState({ helpOpen: false })}
          sections={buildHelpSections(this.helpT, this.helpFeatures())}
          title={messages.helpTitle}
          intro={messages.helpIntro}
          searchPlaceholder={messages.helpSearchPlaceholder}
          noMatches={messages.helpNoMatches}
          closeLabel={messages.close}
        />

        {/* Help sits at the right of the widget header, icon only, exactly as
            it does in Droplets, so users find it in the same place in every
            widget without being told. */}
        <div className='pd-topbar'>
          {this.props.config?.showHelp !== false && (
              <Button size='sm' type='tertiary' icon onClick={this.openHelp}
                title={messages.helpTitle} aria-label={messages.helpTitle}>
                <CalciteIcon icon='question' scale='s' />
              </Button>
          )}
        </div>

        <div className='pd-scroll' aria-busy={this.state.busy}>
        {this.props.config?.showHelp !== false && !this.state.helpHintDismissed && !this.state.busy && (
          <FirstRunHint
            title={messages.firstRunTitle}
            body={messages.firstRunBody}
            linkLabel={messages.firstRunHelpLink}
            dismissLabel={messages.firstRunDismiss}
            onOpenHelp={this.openHelp}
            onDismiss={this.dismissHelpHint}
          />
        )}

        {this.state.busy && (
          <div className='pd-veil' role='status' aria-live='polite'>
            <div className='pd-veil-inner'>
              <div className='pd-veil-card'>
                <Loading type={LoadingType.Donut} width={26} height={26} />
                <div className='pd-veil-title'>{messages.exportWaitTitle}</div>
                {!!this.state.status && <div className='pd-veil-status'>{this.state.status}</div>}
              </div>
            </div>
          </div>
        )}

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
            <div className='pd-print-area' role='group' aria-labelledby={this.uid('gh-svcout')}>
              {this.cardHead('svcout', messages.groupOutput, messages, layout)}
              {this.cardOpen('svcout') && (
              <div id={this.uid('cb-svcout')} className='pd-card-body'>
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
              </div>
              )}
            </div>

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
              {this.renderSeriesTitleHelp(messages, layout)}
            </div>
            )}

            {this.ctrl('pagePreview') && !this.seriesActive() && (
            <React.Fragment>
              <div className='pd-row pd-inline'>
                <Label className='pd-label' id={this.uid('pprev') + '-lbl'}>{messages.pagePreviewLabel}</Label>
                <Switch aria-labelledby={this.uid('pprev') + '-lbl'} checked={this.state.pagePreviewOn}
                  onChange={(e: any) => this.setState({ pagePreviewOn: !!(e.target && e.target.checked) }, () => { if (this.state.pagePreviewOn) void this.runPagePreview() })} />
              </div>
              {this.state.pagePreviewOn && (
                <PagePreview
                  url={this.state.pagePreviewUrl}
                  busy={this.state.pagePreviewBusy}
                  note={this.state.pagePreviewNote}
                  alt={messages.pagePreviewAlt}
                  loadingText={messages.pagePreviewLoading}
                  updatingText={messages.pagePreviewUpdating}
                  aspect={layout ? layout.pageWidthIn / layout.pageHeightIn : 0}
                  captionId={this.uid('pprev-cap')} />
              )}
            </React.Fragment>
            )}

            {this.ctrl('pagePreview') && this.seriesActive() && (
              <div className='pd-desc' role='status'>{messages.pagePreviewSeriesNote}</div>
            )}

            {((this.props.config as any)?.showAdvancedOptions !== false) && (
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
            <div className='pd-print-area' role='group' aria-labelledby={this.uid('gh-area')}>
              {this.cardHead('area', messages.printAreaLabel, messages, layout)}
              {this.cardOpen('area') && (
              <div id={this.uid('cb-area')} className='pd-card-body'>
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
              {this.seriesActive() && (
                <div className='pd-desc'>{this.seriesFeatures() && this.state.seriesScope === 'frame' ? messages.seriesScaleNoteFrame : messages.seriesScaleNote}</div>
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
                      checked={this.state.previewOn || this.ddpFrameActive()} disabled={this.ddpFrameActive()}
                      onChange={(e) => this.setState({ previewOn: e.target.checked, locked: e.target.checked ? this.state.locked : false })} />
                  </Tooltip>
                </div>
              )}
              {this.ddpFrameActive() && <div className='pd-desc'>{messages.showPreviewForced}</div>}
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
            </div>
            )}
            {this.ctrl('series') && (
            <div className='pd-print-area' role='group' aria-labelledby={this.uid('gh-series')}>
              {this.cardHead('series', messages.groupSeries, messages, layout)}
              {this.cardOpen('series') && (
              <div id={this.uid('cb-series')} className='pd-card-body'>
              <div className='pd-row pd-pa-switch'>
                <Label className='pd-label' id={this.uid('sopen') + '-lbl'}>{messages.seriesSwitch}</Label>
                <Tooltip title={messages.seriesSwitchTip} placement='top'>
                  <Switch aria-labelledby={this.uid('sopen') + '-lbl'} checked={this.seriesActive()}
                    onChange={(e: any) => {
                      const on = !!(e.target && e.target.checked)
                      this.setState(on ? { seriesOpen: true, format: 'pdf' } : { seriesOpen: false })
                    }} />
                </Tooltip>
              </div>
              {this.seriesActive() && (
              <React.Fragment>
              <div className='pd-row'>
                <Label className='pd-label' id={this.uid('smode') + '-lbl'}>{messages.seriesMode}</Label>
                <Select size='sm' aria-labelledby={this.uid('smode') + '-lbl'} value={this.state.seriesMode}
                  onChange={(e: any) => this.setState({ seriesMode: e.target.value })}>
                  <option value='grid'>{messages.seriesModeGrid}</option>
                  <option value='features'>{messages.seriesModeFeatures}</option>
                </Select>
              </div>
              {!this.seriesFeatures() && (
              <React.Fragment>
              <div className='pd-desc'>{messages.seriesHint}</div>
              <div className='pd-row pd-inline'>
                <Label className='pd-label' id={this.uid('srows') + '-lbl'}>{messages.seriesRows}</Label>
                <TextInput id={this.uid('srows')} aria-labelledby={this.uid('srows') + '-lbl'} size='sm' style={{ width: 64 }}
                  value={this.state.seriesRows} onChange={(e) => this.setState({ seriesRows: e.target.value })} />
                <Label className='pd-label' id={this.uid('scols') + '-lbl'}>{messages.seriesCols}</Label>
                <TextInput id={this.uid('scols')} aria-labelledby={this.uid('scols') + '-lbl'} size='sm' style={{ width: 64 }}
                  value={this.state.seriesCols} onChange={(e) => this.setState({ seriesCols: e.target.value })} />
              </div>
              <div className='pd-row pd-inline'>
                <Label className='pd-label' id={this.uid('ssize') + '-lbl'}>{messages.seriesSize}</Label>
                <input type='range' className='pd-range' min={25} max={100} step={5}
                  aria-labelledby={this.uid('ssize') + '-lbl'}
                  value={Math.max(25, Math.min(100, parseInt(this.state.seriesSizePct, 10) || 100))}
                  onChange={(e: any) => this.setState({ seriesSizePct: e.target.value })} />
                <span className='pd-desc' style={{ minWidth: 34 }}>{(parseInt(this.state.seriesSizePct, 10) || 100)}%</span>
              </div>
              <div className='pd-desc'>
                {messages.seriesEstimate.replace('{n}', String(this.seriesSheetCount() + 1))}
              </div>
              {this.renderSeriesLimit(messages)}
              </React.Fragment>
              )}
              {this.seriesFeatures() && this.renderFeaturePagesPanel(messages)}
              </React.Fragment>
              )}
              </div>
              )}
            </div>
            )}
            <div className='pd-print-area' role='group' aria-labelledby={this.uid('gh-onmap')}>
              {this.cardHead('onmap', messages.groupOnMap, messages, layout)}
              {this.cardOpen('onmap') && (
              <div id={this.uid('cb-onmap')} className='pd-card-body'>
            {this.ctrl('legend') && layout && ((layout.elements && layout.elements.some(e => e.type === 'legend')) || (layout as any).legend?.enabled) && (
            <div className='pd-row pd-pa-switch'>
              <Label className='pd-label' id={this.uid('leg') + '-lbl'}>{messages.includeLegendLabel}</Label>
              <Tooltip title={this.state.mapOnly ? messages.disabledMapOnlyTip : messages.includeLegendTip} placement='top'>
                <Switch aria-labelledby={this.uid('leg') + '-lbl'} disabled={this.state.mapOnly} checked={this.state.includeLegend}
                  onChange={(e) => this.setState({ includeLegend: e.target.checked })} />
              </Tooltip>
            </div>
            )}
            {this.ctrl('legend') && layout && (layout as any).legend?.enabled && this.state.includeLegend && (
            <div className='pd-row' data-testid='legendPosSelect'>
              <Label className='pd-label' id={this.uid('legpos') + '-lbl'}>{messages.legendPositionLabel}</Label>
              <Tooltip title={this.state.mapOnly ? messages.disabledMapOnlyTip : messages.legendPositionTip} placement='top'>
              <Select id={this.uid('legpos')} aria-labelledby={this.uid('legpos') + '-lbl'} size='sm' disabled={this.state.mapOnly} value={this.state.legendPositionOv}
                onChange={(e: any) => this.setState({ legendPositionOv: e.target.value, legendPosUserSet: true, legendAutoPaged: false })}>
                <option value=''>{messages.layoutDefaultOption}</option>
                <option value='rightPanel'>{messages.legendPosRight}</option>
                <option value='secondPage'>{messages.legendPosSecondPage}</option>
                <option value='leftPanel'>{messages.legendPosLeft}</option>
                <option value='bottomPanel'>{messages.legendPosBottom}</option>
                <option value='topLeft'>{messages.legendPosTL}</option>
                <option value='topRight'>{messages.legendPosTR}</option>
                <option value='bottomLeft'>{messages.legendPosBL}</option>
                <option value='bottomRight'>{messages.legendPosBR}</option>
              </Select>
              </Tooltip>
            </div>
            )}
            {this.state.legendAutoPaged && this.state.legendPositionOv === 'secondPage' && this.state.includeLegend && !this.state.mapOnly && (
            <div className='pd-row' role='status' aria-live='polite'>
              <Alert type='info' text={messages.legendAutoPagedText} withIcon size='small' className='w-100'
                aria-label={messages.legendAutoPagedText} />
              <Button size='sm' type='tertiary'
                onClick={() => this.setState({ legendPositionOv: '', legendAutoPaged: false, legendPosUserSet: true })}>
                {messages.legendKeepBeside}
              </Button>
            </div>
            )}
            {(() => {
              const h = this.state.legendHint
              if (!h || this.state.legendHintDismissed || this.state.legendPositionOv === 'secondPage' ||
                  !this.state.includeLegend || this.state.mapOnly) return null
              const text = (h.level === 'cramped'
                ? (h.missed > 0
                    ? messages.legendHintMissed.replace('{count}', String(h.count)).replace('{missed}', String(h.missed))
                    : messages.legendHintShrunk.replace('{count}', String(h.count)).replace('{font}', String(h.fontPt)))
                : messages.legendHintMany.replace('{count}', String(h.count))) + ' ' + messages.legendHintSuffix
              return (
                <div className='pd-row' role='status' aria-live='polite'>
                  <Alert type={h.level === 'cramped' ? 'warning' : 'info'} text={text} withIcon size='small' className='w-100'
                    aria-label={text} />
                  <div className='pd-hint-actions'>
                    <Button size='sm' type='primary'
                      onClick={() => this.setState({ legendPositionOv: 'secondPage', legendHint: null })}>
                      {messages.legendUseSecondPage}
                    </Button>
                    <Button size='sm' type='tertiary'
                      onClick={() => this.setState({ legendHintDismissed: true })}>
                      {messages.legendHintDismiss}
                    </Button>
                  </div>
                </div>
              )
            })()}
            {this.ctrl('overview') && layout && (layout as any).overview?.enabled && (
            <div className='pd-row pd-pa-switch'>
              <Label className='pd-label' id={this.uid('ovw') + '-lbl'}>{messages.overviewToggleLabel}</Label>
              <Tooltip title={this.state.mapOnly ? messages.disabledMapOnlyTip : messages.overviewToggleTip} placement='top'>
                <Switch aria-labelledby={this.uid('ovw') + '-lbl'} disabled={this.state.mapOnly} checked={this.state.showOverview}
                  onChange={(e) => this.setState({ showOverview: e.target.checked })} />
              </Tooltip>
            </div>
            )}
            {this.ctrl('grid') && layout && (layout as any).grid?.enabled && (
            <div className='pd-row pd-pa-switch'>
              <Label className='pd-label' id={this.uid('grd') + '-lbl'}>{messages.gridToggleLabel}</Label>
              <Tooltip title={this.state.mapOnly ? messages.disabledMapOnlyTip : messages.gridToggleTip} placement='top'>
                <Switch aria-labelledby={this.uid('grd') + '-lbl'} disabled={this.state.mapOnly} checked={this.state.showGrid}
                  onChange={(e) => this.setState({ showGrid: e.target.checked })} />
              </Tooltip>
            </div>
            )}
            {this.ctrl('grid') && layout && (layout as any).grid?.enabled && this.state.showGrid && (
            <div className='pd-row'>
              <Label className='pd-label' id={this.uid('gridtype') + '-lbl'}>{messages.gridTypeLabel}</Label>
              <Tooltip title={this.state.mapOnly ? messages.disabledMapOnlyTip : messages.gridTypeSelTip} placement='top'>
              <Select id={this.uid('gridtype')} aria-labelledby={this.uid('gridtype') + '-lbl'} size='sm' disabled={this.state.mapOnly} value={this.state.gridTypeOv}
                onChange={(e: any) => this.setState({ gridTypeOv: e.target.value })}>
                <option value=''>{messages.layoutDefaultOption}</option>
                <option value='graticule'>{messages.gridTypeGraticule}</option>
                <option value='measured'>{messages.gridTypeMeasured}</option>
                <option value='reference'>{messages.gridTypeReference}</option>
              </Select>
              </Tooltip>
            </div>
            )}
            {this.ctrl('grid') && layout && (layout as any).grid?.enabled && this.state.showGrid && !this.state.mapOnly && this.renderGridStyle(messages, layout)}
            <div className='pd-row'>
              <div className='pd-pa-switch'>
                <Label className='pd-label' id={this.uid('sel') + '-lbl'}>{messages.selectionToggleLabel}</Label>
                <Tooltip title={messages.selectionToggleTip} placement='top'>
                  <Switch aria-labelledby={this.uid('sel') + '-lbl'} checked={this.state.includeSelection}
                    onChange={(e) => this.setState({ includeSelection: e.target.checked })} />
                </Tooltip>
              </div>
              <div className='pd-desc'>{messages.selectionToggleHint}</div>
            </div>
              </div>
              )}
            </div>
            <div className='pd-print-area' role='group' aria-labelledby={this.uid('gh-text')}>
              {this.cardHead('text', messages.groupPageText, messages, layout)}
              {this.cardOpen('text') && (
              <div id={this.uid('cb-text')} className='pd-card-body'>
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
            <div className='pd-row pd-inline'>
              <Label className='pd-label' id={this.uid('qr') + '-lbl'}>{messages.qrToggleLabel}</Label>
              <Switch aria-labelledby={this.uid('qr') + '-lbl'} checked={this.state.qrOn}
                onChange={(e: any) => this.setState({ qrOn: !!(e.target && e.target.checked) })} />
            </div>
            <div className='pd-desc'>{messages.qrToggleDesc}</div>
              </div>
              )}
            </div>
            {(this.ctrl('font') || (this.ctrl('northArrow') && layout && layout.elements && layout.elements.some(e => e.type === 'northArrow')) || (this.ctrl('scaleBar') && layout && layout.elements && layout.elements.some(e => e.type === 'scaleBar'))) && (
            <div className='pd-print-area' role='group' aria-labelledby={this.uid('gh-style')}>
              {this.cardHead('style', messages.groupStyle, messages, layout)}
              {this.cardOpen('style') && (
              <div id={this.uid('cb-style')} className='pd-card-body'>
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
                      (v) => this.setState({ sbStyle: v, sbUnits2: (v === 'doubleAlternating' || v === 'hollowDouble') ? this.state.sbUnits2 : '' }), this.uid('sbstyle') + '-lbl', messages.layoutDefault)}
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
                {(this.state.sbStyle === 'doubleAlternating' || this.state.sbStyle === 'hollowDouble') && (
                <div className='pd-row'>
                  <Label className='pd-label' id={this.uid('sbunits2') + '-lbl'}>{messages.scaleBarUnits2Label}</Label>
                  <Tooltip title={messages.scaleBarUnits2Tip} placement='top'>
                    <Select id={this.uid('sbunits2')} aria-labelledby={this.uid('sbunits2') + '-lbl'} size='sm' value={this.state.sbUnits2}
                      aria-describedby={this.uid('sbunits2-desc')}
                      onChange={(e: any) => this.setState({ sbUnits2: e.target.value })}>
                      <option value=''>{messages.layoutDefault}</option>
                      {SCALE_BAR_UNITS.map(u => (
                        <option key={u.value} value={u.value}>{u.label}</option>
                      ))}
                    </Select>
                  </Tooltip>
                  <div id={this.uid('sbunits2-desc')} className='pd-desc'>{messages.dualHint}</div>
                </div>
                )}
              </React.Fragment>
            )}
              </div>
              )}
            </div>
            )}
            {(this.ctrl('format') || this.ctrl('dpi') || this.outSREnabled() || this.meMapOnly() || this.ctrl('fileName')) && (
            <div className='pd-print-area' role='group' aria-labelledby={this.uid('gh-output')}>
              {this.cardHead('output', messages.groupOutput, messages, layout)}
              {this.cardOpen('output') && (
              <div id={this.uid('cb-output')} className='pd-card-body'>
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
            {this.meMapOnly() && this.state.mapOnly && this.rasterFormat(this.state.format) && (
            <div className='pd-row'>
              <div className='pd-pa-switch'>
                <Label className='pd-label' id={this.uid('geo') + '-lbl'}>{messages.georefLabel}</Label>
                <Tooltip title={messages.georefTip} placement='top'>
                  <Switch aria-labelledby={this.uid('geo') + '-lbl'} checked={this.state.georeference}
                    onChange={(e) => this.setState({ georeference: e.target.checked })} />
                </Tooltip>
              </div>
              <div className='pd-desc'>{messages.georefHint}</div>
            </div>
            )}
            {this.meMapOnly() && this.state.mapOnly && (
            <div className='pd-row'>
              <div className='pd-pa-switch'>
                <Label className='pd-label' id={this.uid('kmz') + '-lbl'}>{messages.kmzLabel}</Label>
                <Tooltip title={messages.kmzTip} placement='top'>
                  <Switch aria-labelledby={this.uid('kmz') + '-lbl'} checked={this.state.googleEarthKmz}
                    onChange={(e) => this.setState({ googleEarthKmz: e.target.checked })} />
                </Tooltip>
              </div>
              <div className='pd-desc'>{messages.kmzHint}</div>
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

              </div>
              )}
            </div>
            )}

          </React.Fragment>
        )}
        </div>

        {(this.printSource() === 'service' || layouts.length > 0) && this.renderExportDock(messages)}
      </div>
    )
  }
}
