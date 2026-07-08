/**
 * Pure UI constants shared by the runtime widget and the settings panel.
 *
 * IMPORTANT: this module must stay free of 'esri/*' imports (and of anything
 * that imports 'esri/*', like pdfRenderer). The settings panel loads in the
 * builder page, where the ArcGIS JSAPI's AMD loader (window.require) may not
 * be available yet - an esri import in the settings bundle makes the whole
 * settings module fail to load ("window.require is not a function") and the
 * widget hangs on the loading spinner.
 */
import { ScaleBarUnits, ScaleBarStyle, NorthArrowStyle, FontFamily } from './config'

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
