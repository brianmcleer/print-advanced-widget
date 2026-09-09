// exb-editor-shims-print-advanced.d.ts
// City of Grand Junction GIS Division
//
// Widget-specific companion to exb-editor-shims.d.ts. Editor-only, emits no
// JavaScript, and the Experience Builder webpack build never reads it.
//
// Kept SEPARATE on purpose: the shared shim file is a copy of the master at
// client\your-extensions\widgets\_vs\exb-editor-shims.d.ts and per the widget
// handoff is copied, never rewritten, so a newer master can be dropped in as
// a clean overwrite. Anything only Print Advanced needs lives here instead.
//
// Under mode B there is no "paths" and "types": [], so Visual Studio resolves
// nothing from node_modules. That includes this widget's four real runtime
// dependencies, which webpack still installs and bundles normally.
//
// ── NO IMPORTS IN THIS FILE ─────────────────────────────────────────────────
// An `import` of a bare specifier inside a `declare module` block triggers
// real module resolution. This file is loaded FIRST (see tsconfig "files"),
// before the shared shim has registered `declare module 'react'`, so an
// `import * as ReactNS from 'react'` here made TypeScript walk the ancestor
// node_modules directories and open
// client\node_modules\@types\react\index.d.ts, which is exactly the
// IDE1100 "Access to the path is denied" line. `tsc --traceResolution`
// showed it as the very first resolution request in the program.
//
// The shared shim can use such imports because it declares `module 'react'`
// itself, earlier in the same file. This file must not, so every shape below
// is spelled out locally: plain call signatures instead of React.FC, and
// inlined object types instead of intersections with jimu types.
// ────────────────────────────────────────────────────────────────────────────

// The widget's declared dependencies (package.json), type-only here.
declare module 'jspdf' {
  export class jsPDF {
    constructor (options?: any)
    [key: string]: any
  }
  export default jsPDF
}

declare module 'upng-js' {
  const UPNG: any
  export default UPNG
}

declare module 'utif' {
  const UTIF: any
  export default UTIF
}

declare module 'gifenc' {
  export const GIFEncoder: any
  export const quantize: any
  export const applyPalette: any
  const gifenc: any
  export default gifenc
}

// Experience Builder's React wrappers for Calcite web components. The real
// module is jimu-ui/calcite-components. Supplied BY Experience Builder, so it
// is deliberately not a package.json dependency.
declare module 'calcite-components' {
  // Plain call signatures rather than React.FC. See the NO IMPORTS note at the
  // top of this file: importing 'react' here is what sent Visual Studio into
  // client\node_modules\@types\react.
  export const CalciteIcon: (props: { icon: string, scale?: 's' | 'm' | 'l', flipRtl?: boolean, [key: string]: any }) => any
  export const CalciteChip: (props: { scale?: 's' | 'm' | 'l', appearance?: 'outline' | 'outline-fill' | 'solid', kind?: 'brand' | 'inverse' | 'neutral', icon?: string, closable?: boolean, onCalciteChipClose?: (event: any) => void, children?: any, [key: string]: any }) => any
}

// The widget icon is loaded with require('./assets/icons/icon.svg'), which
// webpack resolves through a loader TypeScript knows nothing about.
declare module '*.svg' {
  const content: any
  export default content
}

// require() is used for the icon above and for the lazy jimu-core read in
// widget.tsx (see dataSourceList: a named import of an export a given EB
// build lacks would fail the whole bundle, a lazy read degrades quietly).
declare function require (moduleName: string): any

// ─────────────────── ArcGIS Maps SDK modules this widget uses ───────────────
//
// The shared shim declares a catch-all `declare module 'esri/*'` whose note
// says "none in this widget today": it was written for a widget with no esri
// imports, and gives every esri module a single `any` DEFAULT export. That is
// not enough here. This widget imports ten esri modules, uses MapView as a
// TYPE in a dozen signatures (a default-exported `any` value is not a type,
// TS2749), and imports two modules as namespaces for their named functions
// (TS2339 on reactiveUtils.watch and print.execute). A specific ambient
// module beats the wildcard, so each one used is declared here.
//
// All type-only. The build resolves the real Maps SDK modules.

declare module 'esri/views/MapView' {
  export default class MapView {
    constructor (properties?: any)
    [key: string]: any
  }
}

declare module 'esri/Graphic' {
  export default class Graphic {
    constructor (properties?: any)
    attributes: any
    geometry: any
    symbol: any
    layer?: any
    popupTemplate?: any
    [key: string]: any
  }
}

declare module 'esri/geometry/SpatialReference' {
  export default class SpatialReference {
    constructor (properties?: any)
    wkid?: number
    latestWkid?: number
    isGeographic?: boolean
    isWebMercator?: boolean
    unit?: string
    wkt?: string
    [key: string]: any
  }
}

declare module 'esri/rest/support/PrintTemplate' {
  export default class PrintTemplate {
    constructor (properties?: any)
    [key: string]: any
  }
}

declare module 'esri/rest/support/PrintParameters' {
  export default class PrintParameters {
    constructor (properties?: any)
    [key: string]: any
  }
}

// Namespace imports: the members actually called, so a typo is still caught.
declare module 'esri/rest/print' {
  export function execute (url: string, params: any, options?: any): Promise<any>
}

declare module 'esri/core/reactiveUtils' {
  export function watch (getValue: (...args: any[]) => any, callback: (...args: any[]) => void, options?: any): { remove: () => void }
  export function when (predicate: (...args: any[]) => any, callback: (...args: any[]) => void, options?: any): { remove: () => void }
  export function whenOnce (predicate: (...args: any[]) => any, options?: any): Promise<any>
  export function once (evented: any, eventName: string): Promise<any>
  export function on (getTarget: (...args: any[]) => any, eventName: string, callback: (...args: any[]) => void, options?: any): { remove: () => void }
}

declare module 'esri/symbols/support/symbolUtils' {
  export function renderPreviewHTML (symbol: any, options?: any): Promise<HTMLElement>
  export function renderPreviewImage (symbol: any, options?: any): Promise<any>
  export function getDisplayedSymbol (symbol: any): Promise<any>
}

// ─────────────── jimu members the shared shim leaves as `any` ───────────────
//
// The shared shim declares 'jimu-for-builder' and 'jimu-ui/*' in shorthand
// form, which makes every import from them a namespace rather than a type, so
// settings.tsx's `AllWidgetSettingProps` fails as a type annotation (TS2709).
// Declaring the two specific module ids gives them real shapes.

declare module 'jimu-for-builder' {
  // Shape inlined rather than intersected with jimu-core's AllWidgetProps,
  // so this block needs no import. Members beyond these are `any`.
  export type AllWidgetSettingProps<C = any> = {
    id: string
    widgetId?: string
    config: C
    useMapWidgetIds?: any
    onSettingChange: (settings: any, outputDataSources?: any) => void
    intl?: any
    theme?: any
    portalUrl?: string
    [key: string]: any
  }
  export const getAppConfigAction: any
  export const utils: any
}

declare module 'jimu-ui/advanced/setting-components' {
  export const SettingSection: (props: { title?: string, role?: string, 'aria-label'?: string, className?: string, children?: any, [key: string]: any }) => any
  export const SettingRow: (props: { label?: string, tag?: string, flow?: 'wrap' | 'no-wrap', truncateLabel?: boolean, className?: string, children?: any, [key: string]: any }) => any
  export const MapWidgetSelector: (props: { useMapWidgetIds?: any, onSelect?: (ids: string[]) => void, [key: string]: any }) => any
}
