/**
 * Shared print scale/extent math for Print Advanced.
 * Used by BOTH the live on-map preview overlay (widget.tsx) and the offscreen
 * export capture (pdfRenderer.ts) so the preview rectangle and the actual
 * printed area are always computed identically.
 */

export const M_PER_IN = 0.0254

export type PrintScaleMode = 'current' | 'preserveExtent' | 'fixed'

/** Meters per map unit at a view center (accounts for projection distortion). */
export function metersPerMapUnit (viewScale: number, viewResolution: number): number {
  if (!(viewResolution > 0)) return 1
  return (viewScale * M_PER_IN) / (96 * viewResolution)
}

export interface PrintExtent {
  xmin: number, ymin: number, xmax: number, ymax: number, widthMU: number, heightMU: number
}

/**
 * Ground extent (in map units) a frameWIn x frameHIn paper-inch frame covers at
 * printedScale, centered on (cx, cy). mpu = meters per map unit at the center.
 */
export function printExtent (
  cx: number, cy: number, mpu: number,
  frameWIn: number, frameHIn: number, printedScale: number
): PrintExtent {
  const wMU = (frameWIn * printedScale * M_PER_IN) / mpu
  const hMU = (frameHIn * printedScale * M_PER_IN) / mpu
  return { xmin: cx - wMU / 2, ymin: cy - hMU / 2, xmax: cx + wMU / 2, ymax: cy + hMU / 2, widthMU: wMU, heightMU: hMU }
}

/** Polygon ring for the extent, optionally rotated about its center (map deg, CCW). */
export function extentRings (ext: PrintExtent, cx: number, cy: number, rotationDeg = 0): number[][] {
  const pts: number[][] = [
    [ext.xmin, ext.ymax], [ext.xmax, ext.ymax],
    [ext.xmax, ext.ymin], [ext.xmin, ext.ymin], [ext.xmin, ext.ymax]
  ]
  if (!rotationDeg) return pts
  const t = -rotationDeg * Math.PI / 180
  const cos = Math.cos(t), sin = Math.sin(t)
  return pts.map(([x, y]) => {
    const dx = x - cx, dy = y - cy
    return [cx + dx * cos - dy * sin, cy + dx * sin + dy * cos]
  })
}

/** The scale that a "preserve current extent" print would use for this frame. */
export function extentFitScale (
  extWidthMU: number, extHeightMU: number, mpu: number,
  frameWIn: number, frameHIn: number, capW: number, capH: number
): number {
  const srcAR = extWidthMU / extHeightMU
  const tgtAR = capW / capH
  const groundWmu = srcAR > tgtAR ? extHeightMU * tgtAR : extWidthMU
  const groundMeters = groundWmu * mpu
  return groundMeters / (frameWIn * M_PER_IN)
}

/** Resolve printed scale from the chosen mode. */
export function resolvePrintedScale (
  mode: PrintScaleMode, viewScale: number, fixedScale: number | undefined, fitScale: number
): number {
  if (mode === 'fixed' && fixedScale && fixedScale > 0) return fixedScale
  if (mode === 'preserveExtent' && fitScale > 0) return fitScale
  return viewScale
}
