// Editor-only declarations for Experience Builder 1.21 / pnpm layouts.
// These declarations emit no JavaScript and do not alter widget behavior.

declare function require(moduleName: string): any

declare module '@emotion/react/jsx-runtime' {
  export * from 'react/jsx-runtime'
}

// Visual Studio can occasionally resolve these Experience Builder aliases to
// ArcGIS declaration files without treating them as modules. These exact
// ambient declarations preserve the runtime imports while keeping editor
// analysis stable. All members are intentionally broad and type-only.
declare module 'esri/Graphic' {
  export default class Graphic {
    constructor(properties?: any)
    [key: string]: any
  }
}

declare module 'esri/rest/print' {
  export function execute(url: string, params: any, options?: any): Promise<any>
}

declare module 'esri/rest/support/PrintTemplate' {
  export default class PrintTemplate {
    constructor(properties?: any)
    [key: string]: any
  }
}

declare module 'esri/rest/support/PrintParameters' {
  export default class PrintParameters {
    constructor(properties?: any)
    [key: string]: any
  }
}

declare module 'esri/geometry/SpatialReference' {
  export default class SpatialReference {
    constructor(properties?: any)
    [key: string]: any
  }
}

// ArcGIS reactive utilities are ESM at runtime. Some Visual Studio TypeScript
// hosts opened at the widget folder resolve the declaration file as a script
// instead of a module, so provide the small public surface used by this widget.
declare module 'esri/core/reactiveUtils' {
  export function watch(getValue: (...args: any[]) => any, callback: (...args: any[]) => void, options?: any): any
  export function whenOnce(predicate: (...args: any[]) => any, options?: any): Promise<any>
  export function when(predicate: (...args: any[]) => any, callback: (...args: any[]) => void, options?: any): any
  export function once(evented: any, eventName: string): Promise<any>
  export function on(getTarget: (...args: any[]) => any, eventName: string, callback: (...args: any[]) => void, options?: any): any
}

// Type-only fallback for editors that cannot see the widget's pnpm-linked
// dependency. The runtime module is still supplied by the package.json
// dependency and is bundled normally by Experience Builder.
declare module 'jspdf' {
  export class jsPDF {
    constructor(options?: any)
    [key: string]: any
  }
  export default jsPDF
}


// MapView is a real ArcGIS Maps SDK ESM module at runtime. Visual Studio can
// misclassify its pnpm-linked declaration file as a script when a widget folder
// is opened directly, so expose the constructor and broad instance surface used
// by this widget for editor analysis only.
declare module 'esri/views/MapView' {
  export default class MapView {
    constructor(properties?: any)
    [key: string]: any
  }
}

// Type-only editor fallback for the symbol preview helper used by the PDF
// legend renderer. Experience Builder still loads the real ArcGIS module.
declare module 'esri/symbols/support/symbolUtils' {
  export function renderPreviewHTML(symbol: any, options?: any): Promise<HTMLElement>
  export function renderPreviewImage(symbol: any, options?: any): Promise<any>
  export function getDisplayedSymbol(symbol: any): Promise<any>
}
