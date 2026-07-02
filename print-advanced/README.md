# Print Advanced

An advanced print widget for ArcGIS Experience Builder Developer Edition (1.19 and 1.20, React 19). It reproduces an ArcGIS Pro layout (.pagx) in the browser and exports it, with no print service required. An optional Esri print service path is also included for server side layouts.

Author: Brian McLeer, City of Grand Junction, CO.

## What it does

You share a layout from ArcGIS Pro as a layout file (.pagx) and import it once in the widget settings. The widget parses the CIM layout and rebuilds it at print time against the live map, so the output matches the Pro page design without a print service.

Two print sources are available:

- Client side (.pagx): the default. The map frame, texts, lines, north arrow, scale bar, pictures, and legend are drawn in the browser. Exports to PDF and SVG are vector. PNG32, PNG8, JPG, GIF, and TIFF are also supported, along with EPS.
- Esri print service (URL): optional. The map is posted to an ExportWebMap service for server side layouts. This path adds AIX support.

## Features

- Client side rendering of ArcGIS Pro .pagx layouts, calibrated against real Pro output.
- Print area preview on the live map, with scale modes (preserve scale, preserve extent, fixed scale, or pick from a list) and a lock toggle.
- Output coordinate system (WKID) selection in both print sources.
- 12 north arrow styles and 9 scale bar styles, each shown as a visual thumbnail picker, plus a Layout default option.
- Author, copyright, and attribution tokens.
- Legend and map only export, with optional pixel sizing for map only.
- Multiple custom fonts by URL, including Google Fonts import.
- Recent exports list with per item remove and a clear all button.
- Per control visibility and export defaults set by an administrator in the settings panel.
- XML import and export of the entire configuration, so a setup can be moved between apps.

## Requirements

- ArcGIS Experience Builder Developer Edition 1.19 or 1.20 (React 19). EB 1.18 and earlier (React 18) are not supported.
- The widget dependencies (jspdf, upng-js, utif, gifenc) are declared in package.json and are installed automatically by the standard client install described below. No per package commands are needed.

## Install

1. Download the release zip and extract it.
2. Place the `print-advanced` folder into your install at:
   `client\your-extensions\widgets\print-advanced`
   The `manifest.json` must sit directly inside that folder. Do not nest it a second level deep (for example `widgets\print-advanced\print-advanced`); nesting is the usual reason a widget does not register.
3. From the `client` folder, run `npm install`. Experience Builder installs the widget dependencies from package.json for you.
4. Restart the client (`npm start`) and hard refresh the browser.

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

## License

Apache-2.0. See the LICENSE file.
