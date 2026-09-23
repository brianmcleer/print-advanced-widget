# Changelog

Newest first. Every release bumps `manifest.json` and `package.json` together.

## 1.13.0 (2026-09-23)

- Map series fixes from a full review:
  - Cancel: a Cancel button in the progress row stops the series after the current step (also during preparation and before a page's overview); nothing downloads and a note says so. Cancels are not reported as errors.
  - The data-driven page count stays current at any size (it used to stop refreshing above 30 pages, which could leave Export wrongly disabled), and it also follows display-only layer filters, scale, fixed scale and lock changes.
  - The page limit is checked again at export with the fresh count, and holds even when a service cannot count (one extra feature is fetched to detect it).
  - Inside the print area draws and follows its rectangle even when Show print area is off, so what you see is what picks the pages.
  - Layer and map watchers use reactiveUtils (the old watch() API is gone in the 5.x SDK), so visibility, filter and pan changes are always picked up.
  - The page 1 title sample uses the real page total; the over-limit note fills in the limit everywhere; the key map no longer highlights a sheet while legend pages compose.
  - Screen readers hear one progress headline per page, not the clock every second.
  - Help text no longer mentions the old 31-page limit, and names the Overview inset switch correctly.
- Data-driven pages honor every filter the map shows: the layer's definition expression (what Map Layers and the out-of-the-box Map Layers filter set), a layer view filter, and the Experience Builder data source filter (Filter, Query and similar widgets), joined with AND. Changing a layer's filter re-counts the pages.
- Map series guardrails (browser, not ArcGIS Pro): new Settings section Map series limits with Warn above (default 20 map pages), Limit (default 50, up to 200) and Over the limit (Stop the export, or for one page per feature Print the first pages). Above the warning a yellow note gives a rough time and file size; over the limit a red note explains how to narrow it and Export is disabled. Replaces the fixed 31-page grid limit and the silent 30-feature cap. All three round-trip through XML.
- Data-driven pages linked to the main options:
  - Map title: while Map series is open, buttons under Map title add Page name, Page number or any visible field ({pageName}, {page} of {pages}, {field:NAME}), and a live line shows how page 1's title will read.
  - Order: sort pages A to Z or Z to A by the name field.
  - Overview inset: the main Overview inset switch now adds a locator overview to every data-driven page, centered on that page's feature (grid series keep their key map).
  - Scale: the main Scale row explains that series pages set their own scale, and with Inside the print area, that it sets the rectangle used to pick features.
- Data-driven pages: the page name field list offers only fields published as visible (the layer's field settings from the web map or service, in that order and with those labels); hidden fields, Arcade expressions and shape fields are left out. Layers with no field settings still offer every attribute field.
- Map series progress (grid and one page per feature): the export row now shows Page 3 of 12 (with the feature name for data-driven pages), a segmented bar with one segment per page plus the index page and saving (a plain bar past 60 steps), the step count and percent, the time elapsed, about how long is left once a page has finished, and the current sub-step (capturing, rendering symbols, legend). It is a real progressbar (aria-valuenow, aria-valuetext) with a polite live headline, and the active segment stops pulsing under reduced motion.
- Data-driven pages: new Features choice Inside the print area, so only features touching the print area rectangle get a page (the rectangle stays on the map as the filter). In the current map view and Whole layer (beyond the map) remain, each with a one-line explanation.
- Data-driven pages: the layer list now includes layers inside group layers at any depth and the sublayers of map image services (group sublayers are walked, raster sublayers left out), each titled with its group path (Utilities / Water / Mains). The list follows the map's own layers, in layer list order: only layers turned on (with every parent group on) are offered, basemap layers and layers hidden from the layer list (listMode hide, such as helper layers other widgets add) are left out, and it updates as layers are switched on and off. It reads the map itself, so it works the same with the out-of-the-box Map Layers widget, Map Layers Custom, or no layer list at all. Layers in groups that have not been opened yet load on demand, so their name fields appear.
- Vector output: custom path markers (SVG paths with lines and curves, sized and centered like the SDK) and picture markers (any web image, embedded once and drawn at the symbol size) now print as vectors. Picture markers with an angle keep the layer as pixels.
- Vector labels: label classes with a where clause are evaluated per feature (comparisons, IS NULL, IN, LIKE, BETWEEN, AND, OR, NOT, parentheses), so layers that label only some features, or style classes differently, print as vector text too. Where clauses using functions keep the layer as pixels.
- Page preview: the preview frame is now its own themed component (border, background and caption from the app's theme tokens), with a text alternative, aria-busy while refreshing and a polite live caption.
- Help guide: new troubleshooting lines for the page preview and layers that stay as pixels; corner labels and the wider vector support are covered. Every new setting round-trips through XML export and import, and hand-edited "true"/"false" strings are coerced for every new switch.

## 1.12.0 (2026-09-23)

- Vector phase 2 (with the experimental vector setting on):
  - Labels: layers with labels now print as vectors too. Supported label classes use a plain field expression ($feature.NAME, $feature["NAME"], quoted text joined with +, or the legacy [NAME] form) and a text symbol (color, size, bold or italic, halo, offsets). Placement follows the map: points above, below, left or right per the class, polygons at an interior point (works for C and L shaped parcels), lines centered along the longest part and kept upright. Labels sit on top of every layer and are deconflicted across layers, dropping any that would overlap or leave the map frame, like the SDK. Each layer's labels get their own PDF layer ("Parcels labels") and stay searchable, selectable text. Label classes with a where clause, Arcade functions or non-text symbols keep that layer as pixels, with the reason in the export note. Label classes out of their scale range are left off.
  - Hatched fills: all six hatch styles (horizontal, vertical, forward and backward diagonal, cross, diagonal cross) are drawn as real lines clipped to each polygon, screen-aligned like the map.
  - Rotated maps: vectors, labels, the selection outline and the data-driven page outline now draw through the capture's pixel-to-ground transform, so they line up on a turned map. Markers and polygon labels stay upright; line labels follow the line.
  - Map series and data-driven pages: every sheet and the index page plan, hide and draw their own vector layers; raster fallbacks are listed once for the whole series.
- The selection highlight now prints on rotated maps as well.

## 1.11.0 (2026-09-23)

- Live page preview: a Page preview switch under the layout picker shows the whole printed page in the panel and redraws as you pan, zoom or change any option (title, legend, grid, north arrow, scale bar, scale mode, fixed scale, lock, map only, QR, author). It is fast because the map comes from a screenshot of the live map cut to the print frame, with no offscreen view and no tile loading; the rest of the page is drawn by the same code the export uses, so the legend panel, grid and corner labels, text tokens, logos, QR code and selection outline land exactly where they will print. Gray marks print area beyond the screen, and the overview inset shows as a labeled box. The caption shows the printed scale. Hidden while the map series panel is open. New per-control switch in Settings (Page preview), shown by default; the preview itself starts off.

## 1.10.0 (2026-09-23)

- True vector feature layers (experimental, Settings switch, off by default): in PDF and SVG single-map exports, feature layers drawn with simple symbols print as real vector shapes instead of pixels. Supported: single symbol, unique values (up to three fields) and class breaks renderers; solid and hollow fills with transparency, every simple line dash style, circle, square, diamond, triangle, cross and x markers with size, angle and offsets; layer opacity; polygon holes; the layer's own filter. Each vector layer gets its own PDF layer named after the map layer, clipped to the map frame and generalized to a quarter point so parcel maps stay small. The layer is hidden only in the offscreen capture view, never on the live map.
- Honest fallback: layers with labels, clustering, effects, blend modes, time filtering, visual variables, Arcade renderers, hatched fills, picture or path markers, more than 20,000 features, or a service transfer limit stay as pixels, and the export note lists each one with the reason. Rotated maps and map series keep the raster path for now.
- Drawing backends gained path, clip, transparency and dash support (PDF through jsPDF graphics states, SVG through clip paths and opacity attributes).

## 1.9.0 (2026-09-23)

- Data-driven pages: the map series can now make one page per feature (Pages from: One page per feature). Pick a feature layer, a page name field (also the page order; coded-value domains and dates print as text), features in the current view or the whole layer (the layer's own filter always applies), and best-fit scale with a margin (rounded up to two significant digits, like Pro) or one fixed scale. Each page centers on its feature and outlines it in orange on its own Page feature layer, prints its name in the title, and gets GeoPDF coordinates, PDF layers and an index page. Up to 30 feature pages per export, in page name order. The live preview outlines every page on the map before export.
- New dynamic text {field:NAME} for the page feature's attributes, with Pro's preStr/postStr/emptyStr. Pro's map series tag <dyn type="page" property="attribute" field="NAME"/> now imports from .pagx instead of being stripped. The title box takes {pageName} and {field:NAME} too.
- The legend scale filter runs page by page on data-driven pages, since each page has its own scale.

## 1.8.0 (2026-09-23)

- PDF layers: every part of the page goes in its own optional content group (ISO 32000 section 8.11): Map, Grid, Selection, Map frame, Overview map, Legend, North arrow and scale bar, Text, Graphics, QR code, plus Map series for page outlines and numbers. Acrobat, Avenza Maps, ArcGIS Pro, QGIS and GDAL list them as layers you can switch on and off. Legend pages use the Legend layer. No dependency: written through jsPDF build events. Verified with PyMuPDF (every layer toggles, all off leaves a blank page), GDAL layer listing, and qpdf.
- SVG layers: the same parts become Inkscape and Illustrator layers (top-level groups with inkscape:groupmode="layer").
- PDFs that carry layers or GeoPDF now declare PDF 1.7.
- Settings switch: Layers in PDF and SVG exports (on by default; round-trips through XML).
- Help guide: a line on using the layers.

## 1.7.0 (2026-09-23)

- GeoPDF: every PDF map frame is georeferenced with an ISO 32000 geospatial Measure dictionary (viewport, four control points, EPSG code and WKT). Avenza Maps shows a live location dot, Acrobat's Geospatial Location tool reads coordinates, and ArcGIS Pro, QGIS and GDAL open the PDF in place. Works for any coordinate system, rotated maps, map-only PDFs, and every sheet plus the index page of a map series. Verified with GDAL 3.8 on UTM 12N, State Plane Colorado Central (US feet), Web Mercator and WGS84, north-up and rotated, sub-millimeter at the frame corners. Settings switch: GeoPDF coordinates in PDF exports (on by default).
- Rotated georeferencing: new setting Keep map rotation in georeferenced images (off by default). A rotated map-only export then writes a rotated world file, a GeoTIFF with ModelTransformationTag (34264), and a rotated Google Earth quad, instead of forcing north-up. Georeferencing now runs off the capture's full pixel-to-ground transform.
- Grid corner labels: graticule and measured grids can label the four neatline corners with full lat/long (to the second) or northing/easting. Edge labels that would crowd a corner are dropped. Per-layout switch in the grid settings.
- Legend: new setting Hide legend layers with nothing in the print area (off by default). One count query per visible feature layer or map-image sublayer, honoring definition expressions; anything that cannot be asked or does not answer in time is kept. Map series judge against the whole series area.
- Legend: the scale filter (hide layers not drawn at the print scale) is now a settings switch, on by default, and it round-trips through XML export and import. Previously it was always on.
- Fix: a group heading whose only child group was emptied by a legend filter is now removed too.
- Help guide: GeoPDF line under formats, and the georeferencing note follows the keep-rotation setting.

## 1.6.6 (2026-09-18)

- Settings: a **Show help guide** option. Turn it off and the question-mark button and the first-run hint both disappear; the guide itself is untouched. Undefined means on, so apps configured before this release keep their help button.

## 1.6.5 (2026-09-18)

- Security: the beacon's session id now falls back to `crypto.getRandomValues` and then to a clock value instead of `Math.random`, which CodeQL flags as insecure randomness (shared beacon 1.1.1). The id only groups one page load's events; it is never a secret or a credential.
- Build: `tsconfig.json` is `jsx: react-jsx` with `jsxImportSource: @emotion/react`, matching the Experience Builder client. ts-loader reads the widget tsconfig, and the previous classic `jsx: react` setting made the settings panel and runtime fail with "Cannot convert undefined or null to object" after a full rebuild. No functional change.

## 1.6.4 (2026-09-18)

- Added: anonymous usage and error telemetry (shared beacon module; off unless the portal publishes an exb-beacon-sink table; telemetry: false in config disables it).

## 1.6.3 (2026-09-18)

- Security: pinned the transitive dompurify (via jspdf) to 3.4.13 or newer with a pnpm override, closing the two Dependabot alerts (IN_PLACE hook removal XSS, CUSTOM_ELEMENT_HANDLING bypass).

## 1.6.2 (2026-09-17)

- Packaging: the Visual Studio editor shims are no longer in the release zip. `publish.ps1` strips them from a staging copy (`$ReleaseOnlyExclude`) and refuses to zip if any ambient `declare module` of react, jimu or esri survives. The shims stay in the GitHub repo; clone users delete them before building.

## Earlier releases

See the GitHub releases page and the changelog section of the README, if any.

