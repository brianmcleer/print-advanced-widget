import { ImmutableObject } from 'seamless-immutable'

export type ImageFormat = 'jpg' | 'png'
export type PreserveMode = 'scale' | 'extent'
export type ScaleBarUnits = 'feet' | 'miles' | 'meters' | 'kilometers'
/** Pro scale bar styles (CIM structural styles + line styles). */
export type ScaleBarStyle = 'alternating' | 'alternating2' | 'doubleAlternating' | 'hollow' | 'hollowDouble' | 'singleDivision' | 'line' | 'line2' | 'scaleLine' | 'scaleLine2' | 'steppedLine' | 'steppedFilled'
/** Widget north arrow archetypes (Pro's are proprietary font glyphs). */
export type NorthArrowStyle = 'splitArrow' | 'solidTriangle' | 'outlineArrow' | 'needle' | 'simpleArrow' | 'chevron' | 'meridian' | 'compassStar' | 'compassRose' | 'starburst' | 'circledArrow' | 'filledCircleArrow'
export type RGB = [number, number, number]
/** Cross-format font families (jsPDF built-ins constrain the set: embedding
 *  licensed TTFs like Tahoma is not done). */
export type FontFamily = 'sans' | 'serif' | 'mono'

/**
 * Layout elements imported from an ArcGIS Pro .pagx (CIM) file.
 * All positions are INCHES from the TOP-LEFT of the page (CIM's bottom-left
 * origin is converted at import time).
 */
export interface ElBase {
  xIn: number
  yIn: number
  wIn: number
  hIn: number
  name?: string
}

export interface MapFrameEl extends ElBase {
  type: 'mapFrame'
  borderColor: RGB | null
  borderWidthPt: number
}

export interface TextEl extends ElBase {
  type: 'text'
  /** Text with <dyn .../> tags already normalized to runtime tokens. */
  text: string
  fontSizePt: number
  bold: boolean
  italic: boolean
  align: 'left' | 'center' | 'right'
  valign: 'top' | 'center' | 'bottom'
  color: RGB
  /** True when the text is the layout's dynamic title - runtime title replaces it. */
  isTitle: boolean
}

export interface LineEl {
  type: 'line'
  name?: string
  /** Polyline points in inches, top-left origin. */
  points: Array<[number, number]>
  color: RGB
  widthPt: number
}

export interface NorthArrowEl extends ElBase {
  type: 'northArrow'
}

export interface ScaleBarEl extends ElBase {
  type: 'scaleBar'
  units: ScaleBarUnits
  /** Style from the pagx; the runtime can override per export. */
  style?: ScaleBarStyle
  divisions: number
  subdivisions: number
  barHeightPt: number
  labelSizePt: number
  /** Unit label ("Miles") size; pagx stores it separately from division labels. */
  unitLabelSizePt?: number
  color1: RGB
  color2: RGB
}

export interface PictureEl extends ElBase {
  type: 'picture'
  /** Original file name from the pagx sourceURL - informational label only. */
  sourceName: string
  /** Attached in settings; falls back to the widget-level defaultLogo. */
  dataUrl?: string
  /** Fill the picture box white behind the image (reproduces opaque-BMP look). */
  whiteBg?: boolean
  /** From the CIM element anchor: where the aspect-fitted image sits in its
   *  box. Pro-measured: BottomLeftCorner anchors the image to the box bottom. */
  anchorH?: 'left' | 'center' | 'right'
  anchorV?: 'top' | 'center' | 'bottom'
}

export interface LegendEl extends ElBase {
  type: 'legend'
  maxItems: number
}

export type LayoutElement =
  | MapFrameEl | TextEl | LineEl | NorthArrowEl | ScaleBarEl | PictureEl | LegendEl

export type LegendPatchSize = 'small' | 'medium' | 'large'

/** Settings-defined legend configuration (per layout). The legend content
 *  mirrors the JSAPI Legend model (what the Legend widget shows); these
 *  options control placement and Pro-style presentation. */
export type LegendPosition = OverviewPosition | 'leftPanel' | 'rightPanel' | 'bottomPanel' | 'secondPage'

export interface LegendConfig {
  enabled: boolean
  /** Corner overlay, or a panel ADJACENT to the map (the map frame shrinks
   *  to make room). Used when the .pagx has no legend frame. */
  position: LegendPosition
  /** Panel modes: 'auto' sizes the panel to the legend content;
   *  'fixed' uses widthIn (side panels) or heightIn (bottom panel). */
  panelSizeMode?: 'auto' | 'fixed'
  widthIn: number
  heightIn: number
  marginIn: number
  title: string
  showTitle: boolean
  /** 0 = automatic column count; 1-6 fixed. */
  columns: number
  /** Base item font size; layer headings +1, title +3. Auto-shrinks to fit. */
  baseFontPt: number
  patchSize: LegendPatchSize
  showLayerNames: boolean
  background: boolean
  bgColor: RGB
  borderColor: RGB
  borderWidthPt: number
}

export type GridType = 'graticule' | 'measured' | 'reference'
export type GridLineStyle = 'solid' | 'ticks' | 'crosses'

/** Settings-defined grid or graticule drawn over the map frame, in the
 *  spirit of ArcGIS Pro layout grids (graticule = lat/lon, measured =
 *  projected map units, reference = alphanumeric index). */
export interface GridConfig {
  enabled: boolean
  type: GridType
  /** 'auto' picks a clean interval; 'fixed' uses fixedInterval. */
  intervalMode: 'auto' | 'fixed'
  /** Degrees for graticule, map units for measured grid. */
  fixedInterval?: number
  lineStyle: GridLineStyle
  lineColor: RGB
  lineWidthPt: number
  labels: boolean
  labelsInside: boolean
  labelSizePt: number
  /** Reference grid only: index cell counts. */
  refCols?: number
  refRows?: number
}

export type OverviewPosition = 'topLeft' | 'topRight' | 'bottomLeft' | 'bottomRight'

/** Settings-defined overview (inset) map drawn inside the main map frame.
 *  Captured at a zoomed-out scale with an extent indicator showing the
 *  printed map's footprint. */
export interface OverviewConfig {
  enabled: boolean
  position: OverviewPosition
  widthIn: number
  heightIn: number
  /** Gap between the inset and the map frame edge. */
  marginIn: number
  /** Overview scale = printed scale x multiplier (used when fixedScale unset). */
  scaleMultiplier: number
  /** Absolute overview scale; overrides the multiplier when > 0. */
  fixedScale?: number
  indicatorColor: RGB
  indicatorWidthPt: number
  borderColor: RGB
  borderWidthPt: number
}

export interface PrintLayout {
  id: string
  name: string
  /** pagx file this layout was imported from. */
  sourceFile?: string
  pageWidthIn: number
  pageHeightIn: number

  // Output options (the LOOK comes from the pagx; these are capture options)
  dpi: number
  imageFormat: ImageFormat
  preserve: PreserveMode

  /** Optional settings-defined overview inset. Older configs lack this key
   *  (ExB does not backfill config), so all reads must guard undefined. */
  overview?: OverviewConfig

  /** Optional settings-defined grid/graticule. Same backfill caveat. */
  grid?: GridConfig

  /** Optional settings-defined legend. Same backfill caveat. */
  legend?: LegendConfig

  elements: LayoutElement[]
}

export interface Config {
  layouts: PrintLayout[]
  /** Hard cap on the longest capture dimension (WebGL texture safety). */
  maxImagePx?: number
  /** Admin-set initial values for the runtime controls. Users can still
   *  change any control that remains visible. */
  runtimeDefaults?: {
    format?: string
    dpi?: string
    northArrowStyle?: string
    scaleBarStyle?: string
    scaleBarUnits?: string
    scaleBarUnits2?: string
  }
  /** Per-control visibility in the runtime widget (default: all shown).
   *  Hidden controls still apply their configured default values. */
  controls?: {
    title?: boolean
    format?: boolean
    dpi?: boolean
    font?: boolean
    northArrow?: boolean
    scaleBar?: boolean
    fileName?: boolean
  }
  /** Restrict which export formats users may pick (default: all). The
   *  runtime default format must be in this list to take effect. */
  enabledFormats?: string[]
  /** Open the Advanced options section expanded. */
  advancedOpenByDefault?: boolean
  /** Print area / map extent & scale controls. */
  mapExtent?: {
    enabled?: boolean
    showPreview?: boolean
    showPreserveScale?: boolean
    showPreserveExtent?: boolean
    showForceScale?: boolean
    showScaleSelect?: boolean
    showLock?: boolean
    defaultMode?: 'current' | 'preserveExtent' | 'fixed'
    defaultScale?: number
    scaleChoices?: number[]
    previewOnByDefault?: boolean
    /** Preview overlay appearance. */
    previewOutlineColor?: string
    previewOutlineWidth?: number
    previewFillColor?: string
  }
  /** Initial map title. Token: {layout} = layout name. */
  defaultTitle?: string
  /** Default author text ({author} token); blank falls back to the username. */
  defaultAuthor?: string
  /** Default copyright text ({copyright} token). */
  defaultCopyright?: string
  /** Include map/data attribution ({attribution} token). Default true. */
  includeAttribution?: boolean
  /** Offer a "Map only" export toggle in the widget. */
  enableMapOnly?: boolean
  /** Offer an "Output coordinate system (WKID)" input in the widget. */
  enableOutputSR?: boolean
  /** Default output WKID (blank = map's own spatial reference). */
  defaultOutputWkid?: number
  /** Default output filename (no extension). Tokens: {title} {date} */
  defaultFilename?: string
  /** Widget-level logo (PNG dataURL). Used by any picture element without its
   *  own attached image - independent of the pagx's file paths. */
  defaultLogo?: string
  /** Default font family for all page text (title, labels, footer) across
   *  every output format. Runtime Advanced options can override per export. */
  defaultFontFamily?: FontFamily
  /** Custom font loaded BY URL at export time - nothing embedded in the
   *  widget or config. TTF only (jsPDF requirement). The URL host must allow
   *  cross-origin GET (raw.githubusercontent.com and most CDNs do). */
  /** @deprecated single custom font - migrated into customFonts. Still read for back-compat. */
  customFont?: {
    name: string
    url: string
    boldUrl?: string
  }
  /** Custom fonts loaded by URL at export time (TTF). Nothing embedded. */
  customFonts?: Array<{
    name: string
    url: string
    boldUrl?: string
  }>
  /** Print source: client-side pagx rendering (default) or an Esri
   *  ExportWebMap print service. Service mode adds the printServiceUrl path. */
  printSource?: 'pagx' | 'service'
  /** ExportWebMap print service REST URL (…/GPServer/Export%20Web%20Map%20Task). */
  printServiceUrl?: string
  /** Layout template names offered in service mode (as the service expects them). */
  serviceTemplates?: string[]
  /** Show the collapsible Advanced options section in the runtime widget.
   *  Turn off for kiosk-style apps where users should only pick a layout,
   *  type a title, and export. Default: true. */
  showAdvancedOptions?: boolean
}

export type IMConfig = ImmutableObject<Config>

let seq = 0
export function newLayoutId (): string {
  seq++
  return 'layout-' + Date.now().toString(36) + '-' + seq
}
