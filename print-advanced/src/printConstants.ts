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
import { __t } from './runtime/i18n-t'

export type OutputFormat = 'pdf' | 'png32' | 'png8' | 'jpg' | 'gif' | 'eps' | 'svg' | 'svgz' | 'aix' | 'tiff'

export const FORMAT_LABELS: Array<{ value: OutputFormat, label: string, disabled?: boolean }> = [
    { value: 'pdf', label: __t("portableDocumentFormatPdf") },
    { value: 'png32', label: __t("_32BitPortableNetworkGraphicsPng32") },
    { value: 'png8', label: __t("_8BitPortableNetworkGraphicsPng8") },
    { value: 'jpg', label: __t("jointPhotographicExpertsGroupJpg") },
    { value: 'gif', label: __t("graphicsInterchangeFormatGif") },
    { value: 'eps', label: __t("encapsulatedPostScriptEps") },
    { value: 'svg', label: __t("scalableVectorGraphicsSvg") },
    { value: 'svgz', label: __t("compressedScalableVectorGraphicsSvgz") },
    { value: 'aix', label: __t("adobeIllustratorExchangeAix"), disabled: true },
    { value: 'tiff', label: __t("tagImageFileFormatTiff") }
]

export const FONT_FAMILIES: Array<{ value: FontFamily, label: string }> = [
    { value: 'sans', label: __t("sansSerifHelveticaArial") },
    { value: 'serif', label: __t("serifTimes") },
    { value: 'mono', label: __t("monospaceCourier") }
]

export const NORTH_ARROW_STYLES: Array<{ value: NorthArrowStyle, label: string }> = [
    { value: 'splitArrow', label: __t("splitArrow") },
    { value: 'solidTriangle', label: __t("solidTriangle") },
    { value: 'outlineArrow', label: __t("outlineTriangle") },
    { value: 'needle', label: __t("needle") },
    { value: 'simpleArrow', label: __t("simpleArrow") },
    { value: 'chevron', label: __t("chevron") },
    { value: 'meridian', label: __t("meridian") },
    { value: 'compassStar', label: __t("compassStar") },
    { value: 'compassRose', label: __t("compassRose") },
    { value: 'starburst', label: __t("starburst") },
    { value: 'circledArrow', label: __t("circledArrow") },
    { value: 'filledCircleArrow', label: __t("filledCircle") }
]

export const SCALE_BAR_STYLES: Array<{ value: ScaleBarStyle, label: string }> = [
    { value: 'alternating', label: __t("alternating") },
    { value: 'alternating2', label: __t("alternatingTicked") },
    { value: 'doubleAlternating', label: __t("doubleAlternating") },
    { value: 'hollow', label: __t("hollow") },
    { value: 'hollowDouble', label: __t("doubleHollow") },
    { value: 'singleDivision', label: __t("singleDivision") },
    { value: 'line', label: __t("line") },
    { value: 'line2', label: __t("lineLabelsBelow") },
    { value: 'scaleLine', label: __t("scaleLine") },
    { value: 'scaleLine2', label: __t("scaleLineCenter") },
    { value: 'steppedLine', label: __t("steppedLine") },
    { value: 'steppedFilled', label: __t("steppedFilled") }
]

export const SCALE_BAR_UNITS: Array<{ value: ScaleBarUnits, label: string }> = [
    { value: 'feet', label: __t("feet") },
    { value: 'miles', label: __t("miles") },
    { value: 'meters', label: __t("meters") },
    { value: 'kilometers', label: __t("kilometers") }
]
