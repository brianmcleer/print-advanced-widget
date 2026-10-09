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
    { value: 'pdf', get label () { return __t("portableDocumentFormatPdf") } },
    { value: 'png32', get label () { return __t("_32BitPortableNetworkGraphicsPng32") } },
    { value: 'png8', get label () { return __t("_8BitPortableNetworkGraphicsPng8") } },
    { value: 'jpg', get label () { return __t("jointPhotographicExpertsGroupJpg") } },
    { value: 'gif', get label () { return __t("graphicsInterchangeFormatGif") } },
    { value: 'eps', get label () { return __t("encapsulatedPostScriptEps") } },
    { value: 'svg', get label () { return __t("scalableVectorGraphicsSvg") } },
    { value: 'svgz', get label () { return __t("compressedScalableVectorGraphicsSvgz") } },
    { value: 'aix', get label () { return __t("adobeIllustratorExchangeAix") }, disabled: true },
    { value: 'tiff', get label () { return __t("tagImageFileFormatTiff") } }
]

export const FONT_FAMILIES: Array<{ value: FontFamily, label: string }> = [
    { value: 'sans', get label () { return __t("sansSerifHelveticaArial") } },
    { value: 'serif', get label () { return __t("serifTimes") } },
    { value: 'mono', get label () { return __t("monospaceCourier") } }
]

export const NORTH_ARROW_STYLES: Array<{ value: NorthArrowStyle, label: string }> = [
    { value: 'splitArrow', get label () { return __t("splitArrow") } },
    { value: 'solidTriangle', get label () { return __t("solidTriangle") } },
    { value: 'outlineArrow', get label () { return __t("outlineTriangle") } },
    { value: 'needle', get label () { return __t("needle") } },
    { value: 'simpleArrow', get label () { return __t("simpleArrow") } },
    { value: 'chevron', get label () { return __t("chevron") } },
    { value: 'meridian', get label () { return __t("meridian") } },
    { value: 'compassStar', get label () { return __t("compassStar") } },
    { value: 'compassRose', get label () { return __t("compassRose") } },
    { value: 'starburst', get label () { return __t("starburst") } },
    { value: 'circledArrow', get label () { return __t("circledArrow") } },
    { value: 'filledCircleArrow', get label () { return __t("filledCircle") } }
]

export const SCALE_BAR_STYLES: Array<{ value: ScaleBarStyle, label: string }> = [
    { value: 'alternating', get label () { return __t("alternating") } },
    { value: 'alternating2', get label () { return __t("alternatingTicked") } },
    { value: 'doubleAlternating', get label () { return __t("doubleAlternating") } },
    { value: 'hollow', get label () { return __t("hollow") } },
    { value: 'hollowDouble', get label () { return __t("doubleHollow") } },
    { value: 'singleDivision', get label () { return __t("singleDivision") } },
    { value: 'line', get label () { return __t("line") } },
    { value: 'line2', get label () { return __t("lineLabelsBelow") } },
    { value: 'scaleLine', get label () { return __t("scaleLine") } },
    { value: 'scaleLine2', get label () { return __t("scaleLineCenter") } },
    { value: 'steppedLine', get label () { return __t("steppedLine") } },
    { value: 'steppedFilled', get label () { return __t("steppedFilled") } }
]

export const SCALE_BAR_UNITS: Array<{ value: ScaleBarUnits, label: string }> = [
    { value: 'feet', get label () { return __t("feet") } },
    { value: 'miles', get label () { return __t("miles") } },
    { value: 'meters', get label () { return __t("meters") } },
    { value: 'kilometers', get label () { return __t("kilometers") } }
]
