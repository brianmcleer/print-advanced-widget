/**
 * helpSections - the CONTENT of the Print Advanced help guide.
 *
 * Every line is gated on a feature flag the widget computes from its config
 * and the loaded layout, so nobody reads about a button their app does not
 * have. `when(flag, ...keys)` is the whole gating mechanism, and `listOf`
 * builds "a, b and c" out of only the parts that are switched on.
 *
 * Presentation lives in components/HelpPopup.tsx and is the same on every
 * widget. This file is the only one that changes per widget.
 *
 * Icons are Calcite icon names, the same vocabulary Droplets uses, so the
 * guide reads as one family of widgets rather than several.
 *
 * Author: Brian McLeer, City of Grand Junction
 */
import type { HelpSection } from './components/HelpPopup'

/** One boolean per optional feature that has help text. */
export interface HelpFeatures {
  service: boolean
  printArea: boolean
  mapOnly: boolean
  georeference: boolean
  kmz: boolean
  legend: boolean
  overview: boolean
  grid: boolean
  series: boolean
  outSR: boolean
  qr: boolean
  selection: boolean
  fonts: boolean
  /** PDF exports carry GeoPDF coordinates (Settings, on unless turned off). */
  geoPdf?: boolean
  /** PDF and SVG exports carry toggleable layers (Settings, on by default). */
  pdfLayers?: boolean
  /** Feature layers print as vectors in PDF and SVG (Settings, off by default). */
  vector?: boolean
  /** The live Page preview switch is shown. */
  pagePreview?: boolean
  /** Georeferenced images keep the map rotation (Settings, off by default). */
  keepRotation?: boolean
}

type T = (id: string, values?: Record<string, string>) => string

export function buildHelpSections (t: T, f: HelpFeatures): HelpSection[] {
  const when = (on: boolean, ...ids: string[]): string[] => (on ? ids.map(id => t(id)) : [])
  const listOf = (parts: string[]): string =>
    parts.length <= 1
      ? (parts[0] || '')
      : parts.slice(0, -1).join(', ') + ' ' + t('helpAnd') + ' ' + parts[parts.length - 1]

  // the "what these switches control" sentence, built from what is on, so
  // it never promises a legend to an app whose layout has none
  const optionalParts = listOf([
    ...(f.legend ? [t('helpPartLegend')] : []),
    ...(f.grid ? [t('helpPartGrid')] : []),
    ...(f.overview ? [t('helpPartOverview')] : []),
    ...(f.qr ? [t('helpPartQr')] : []),
    ...(f.fonts ? [t('helpPartFont')] : [])
  ])

  const sections: HelpSection[] = []

  sections.push({
    key: 'start',
    icon: 'play',
    title: t('helpStartTitle'),
    ordered: true,
    body: [
      t('helpStart1'),
      t('helpStart2'),
      t('helpStart3'),
      t('helpStart4'),
      ...when(!!f.pagePreview, 'helpStartPreview')
    ]
  })

  if (f.printArea) {
    sections.push({
      key: 'area',
      icon: 'map',
      title: t('helpAreaTitle'),
      intro: t('helpAreaIntro'),
      body: [
        t('helpAreaCurrent'),
        t('helpAreaExtent'),
        t('helpAreaFixed'),
        t('helpAreaPreview'),
        t('helpAreaLock')
      ]
    })
  }

  if (optionalParts) {
    sections.push({
      key: 'parts',
      icon: 'list-check',
      title: t('helpPartsTitle'),
      intro: t('helpPartsIntro', { parts: optionalParts }),
      body: [
        ...when(f.legend, 'helpPartsLegend', 'helpPartsLegendPos', 'helpPartsLegendScale'),
        ...when(f.grid, 'helpPartsGrid'),
        ...when(f.overview, 'helpPartsOverview'),
        ...when(f.qr, 'helpPartsQr'),
        ...when(f.fonts, 'helpPartsFont')
      ]
    })
  }

  if (f.selection) {
    sections.push({
      key: 'select',
      icon: 'cursor-marquee',
      title: t('helpSelectTitle'),
      intro: t('helpSelectIntro'),
      body: [
        t('helpSelect1'),
        t('helpSelect2'),
        t('helpSelect3')
      ]
    })
  }

  sections.push({
    key: 'format',
    icon: 'file',
    title: t('helpFormatTitle'),
    intro: t('helpFormatIntro'),
    body: [
      t('helpFormatPdf'),
      ...when(!!f.geoPdf, 'helpFormatGeoPdf'),
      ...when(!!f.pdfLayers, 'helpFormatLayers'),
      ...when(!!f.vector, 'helpFormatVector'),
      t('helpFormatSvg'),
      t('helpFormatPng'),
      t('helpFormatTiff'),
      t('helpFormatDpi'),
      ...when(f.mapOnly, 'helpFormatMapOnly')
    ]
  })

  if (f.georeference || f.kmz) {
    sections.push({
      key: 'geo',
      icon: 'globe',
      title: t('helpGeoTitle'),
      intro: t('helpGeoIntro'),
      body: [
        ...when(f.georeference, 'helpGeoTiff', 'helpGeoWorld'),
        ...when(f.georeference && !f.keepRotation, 'helpGeoNorth'),
        ...when(f.georeference && !!f.keepRotation, 'helpGeoRotated'),
        ...when(f.kmz, 'helpGeoKmz', 'helpGeoKmzOpen'),
        ...when(f.outSR, 'helpGeoOutSR')
      ]
    })
  }

  if (f.series) {
    sections.push({
      key: 'series',
      icon: 'grid-unit',
      title: t('helpSeriesTitle'),
      intro: t('helpSeriesIntro'),
      body: [
        t('helpSeries1'),
        t('helpSeries2'),
        t('helpSeries3'),
        t('helpSeries4'),
        t('helpSeries5'),
        t('helpSeriesFeatures'),
        t('helpSeriesLinks'),
        t('helpSeriesLimits'),
        t('helpSeriesProgress')
      ]
    })
  }

  sections.push({
    key: 'results',
    icon: 'download',
    title: t('helpResultsTitle'),
    body: [
      t('helpResults1'),
      t('helpResults2'),
      t('helpResults3')
    ]
  })

  sections.push({
    key: 'trouble',
    icon: 'exclamation-mark-triangle',
    title: t('helpTroubleTitle'),
    body: [
      t('helpTroubleBlank'),
      ...when(f.selection, 'helpTroubleSelection'),
      t('helpTroubleSoft'),
      ...when(f.legend, 'helpTroubleLegend'),
      ...when(!!f.vector, 'helpTroubleVector'),
      ...when(!!f.pagePreview, 'helpTroublePreview'),
      t('helpTroubleSlow'),
      ...when(f.series, 'helpTroubleSeriesLimit'),
      ...when(f.series, 'helpTroubleSeries'),
      t('helpTroubleNoDownload'),
      ...when(f.service, 'helpTroubleService'),
      t('helpTroubleContact')
    ]
  })

  sections.push({
    key: 'tips',
    icon: 'lightbulb',
    title: t('helpTipsTitle'),
    body: [
      t('helpTips1'),
      t('helpTips2'),
      t('helpTips3')
    ]
  })

  return sections
}
