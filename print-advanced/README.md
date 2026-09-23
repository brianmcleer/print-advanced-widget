# Print Advanced

An advanced print widget for ArcGIS Experience Builder Developer Edition (1.19 to 1.21, React 19). It reproduces an ArcGIS Pro layout (.pagx) in the browser and exports it, with no print service required. An optional Esri print service path is also included for server side layouts.

Author: Brian McLeer, City of Grand Junction, CO.

## What it does

You share a layout from ArcGIS Pro as a layout file (.pagx) and import it once in the widget settings. The widget parses the CIM layout and rebuilds it at print time against the live map, so the output matches the Pro page design without a print service.

Two print sources are available:

- Client side (.pagx): the default. The map frame, texts, lines, north arrow, scale bar, pictures, and legend are drawn in the browser. Exports to PDF and SVG are vector. PNG32, PNG8, JPG, GIF, and TIFF are also supported, along with EPS.
- Esri print service (URL): optional. The map is posted to an ExportWebMap service for server side layouts. This path adds AIX support.

## Features

- Client side rendering of ArcGIS Pro .pagx layouts, calibrated against real Pro output.
- Import one or more .pagx layouts at a time in the settings panel; each becomes a selectable layout.
- Print area preview on the live map, with scale modes (preserve scale, preserve extent, fixed scale, or pick from a list) and a lock toggle.
- Output coordinate system (WKID) selection in both print sources.
- 12 north arrow styles and 9 scale bar styles, each shown as a visual thumbnail picker, plus a Layout default option.
- Author, copyright, and attribution tokens.
- Legend and map only export, with optional pixel sizing for map only.
- Multiple custom fonts by URL, including Google Fonts import.
- Recent exports list with per item remove and a clear all button.
- Per control visibility and export defaults set by an administrator in the settings panel.
- XML import and export of the entire configuration, so a setup can be moved between apps.
- GeoPDF output: every PDF map frame carries its coordinate system and corner coordinates (ISO 32000 geospatial), so Avenza Maps shows a blue dot, Acrobat reads coordinates, and ArcGIS Pro, QGIS and GDAL place the PDF on the ground. Map series georeference every sheet and the index page. On by default; a settings switch turns it off.
- Georeferenced map only images: true GeoTIFF, world file with .prj, or Google Earth KMZ. An optional setting keeps a rotated map rotated (rotated world file, GeoTIFF ModelTransformationTag, rotated KMZ quad).
- PDF and SVG layers: map, grid, selection, overview, legend, north arrow and scale bar, text, graphics and QR code each toggle on and off in Acrobat, Avenza Maps, Illustrator or Inkscape.
- Live page preview: the whole printed page, redrawn in the panel as you pan and change options.
- Vector feature layers (experimental): simple-symbol feature layers, including hatched fills, custom and picture markers and field labels (with where clauses), print as true vector shapes and searchable text in PDF and SVG, on rotated maps and every map series sheet, with an honest raster fallback that names each layer it could not reproduce.
- Data-driven pages: one page per feature (parcels, parks, projects) with best-fit or fixed scale, the page feature outlined, {field:NAME} dynamic text, and an index page. Pick any layer that is turned on, including layers in groups, nested groups and map image services. Only fields published as visible are offered, every layer filter is honored (Map Layers, Filter widgets, the map itself), and pages can come from the current view, the print area, or the whole layer. Title buttons add the page name, page number or any field, with a live sample of page 1, and each page can carry its own locator overview.
- Map series progress: page by page bar ("Page 3 of 12"), time left, and a Cancel button.
- Map series guardrails: this runs in the browser, not ArcGIS Pro, so an admin sets a warning (default 20 pages) and a hard limit (default 50, up to 200) in the settings.
- Grid corner labels: the four neatline corners labeled with full lat/long or northing/easting.
- Legend filters: hide layers not drawn at the print scale (on by default) and hide layers with no features in the print area (off by default).

## Requirements

- ArcGIS Experience Builder Developer Edition 1.19 to 1.21 (React 19). EB 1.18 and earlier (React 18) are not supported.
- The widget dependencies (jspdf, upng-js, utif, gifenc) are declared in package.json and are installed automatically by the standard client install described below. No per package commands are needed.

## Install

1. Download the release zip and extract it.
2. Place the `print-advanced` folder into your install at:
   `client\your-extensions\widgets\print-advanced`
   The `manifest.json` must sit directly inside that folder. Do not nest it a second level deep (for example `widgets\print-advanced\print-advanced`); nesting is the usual reason a widget does not register.
3. From the `client` folder, run `npm install`. Experience Builder installs the widget dependencies from package.json for you.
4. Restart the client (`npm start`) and hard refresh the browser.

### The release zip and the editor shims

The zip is the widget only. The Visual Studio type shims in the repo (`print-advanced/src/exb-editor-shims-print-advanced.d.ts`, `print-advanced/src/exb-editor-shims.d.ts`) are left out on purpose: their ambient `declare module` blocks are not file-scoped and would rewrite the react, jimu and esri types for every other widget in your `your-extensions` folder.

If you clone the repository instead of using the zip, delete `print-advanced/src/exb-editor-shims-print-advanced.d.ts` and the other shim files listed above before building; nothing else depends on them.

## Usage telemetry

This widget records anonymous usage counts and errors so the GIS Division can see which widgets and versions are in use and which errors users hit. It records the app id and title, widget name and version, the action name, a truncated error message, the site host name and browser family. It never records usernames, coordinates, addresses, attribute values or URLs with query strings. Where the data goes: on page load the widget asks the app's portal for a public item tagged `exb-beacon-sink` and posts to that table. If your portal has no such item, nothing is sent anywhere. To turn it off for an app, set `"telemetry": false` in the widget's config, or users can enable Do Not Track in their browser. The shared module is `src/shared/beacon.ts`.

## Troubleshooting: "print-advanced is duplicated"

This build error means the widget name is registered more than once, so a second copy exists somewhere. Replacing only one folder does not fix it. Check in this order:

1. A nested folder: `widgets\print-advanced\print-advanced`. The manifest must sit directly inside the widget folder, not a second level deep. This is the usual cause when a zip is extracted into a folder that already has the widget name.
2. A leftover folder from an earlier build or version, including any `-copy` folder, or a folder under a previous name if the widget was renamed.
3. A stale compiled build in `client\dist\widgets`. Stop the client server, delete the matching folder under `dist\widgets` (or run a clean build), then start again. This is common after moving a widget between EB versions.

Tell for the nesting case: if removing one copy makes the widget disappear from the Entrypoint list entirely, the copy that remains is nested too deep. Move it so the manifest is directly inside the widget folder.

## Feedback

Questions, bug reports, and beta feedback are welcome on the Esri Community post:
https://community.esri.com/t5/experience-builder-custom-widgets/print-advanced-beta-use-arcgis-pro-pagx-layout/ba-p/1712031

Or open an issue on the GitHub repository:
https://github.com/brianmcleer/print-advanced-widget

## Contributors

- Brian McLeer, City of Grand Junction, CO (author, maintainer)
- Nicholas Cramer, Polk County, OR (contributor)

## License

Apache-2.0. See the LICENSE file.
