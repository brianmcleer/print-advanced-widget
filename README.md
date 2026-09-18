# print-advanced-widget

[![License](https://img.shields.io/github/license/brianmcleer/print-advanced-widget)](LICENSE) [![Release](https://img.shields.io/github/v/release/brianmcleer/=tag)](https://github.com/brianmcleer/print-advanced-widget/releases) [![Issues](https://img.shields.io/github/issues/brianmcleer/print-advanced-widget)](https://github.com/brianmcleer/print-advanced-widget/issues)

Repository for the Print Advanced custom widget for ArcGIS Experience Builder Developer Edition (1.19 and 1.20, React 19).

Print Advanced reproduces an ArcGIS Pro layout (.pagx) in the browser and exports it with no print service required. An optional Esri print service path is included for server side layouts. For the full feature list and install steps, see the widget README in the `print-advanced` subfolder.

Author: Brian McLeer, City of Grand Junction, CO.

## Esri Community

Post and discussion: https://community.esri.com/t5/experience-builder-custom-widgets/print-advanced-beta-use-arcgis-pro-pagx-layout/ba-p/1712031

## Repository layout

```
print-advanced-widget/            <- this repo
â”œâ”€â”€ README.md                     <- this file (GitHub landing page)
â”œâ”€â”€ LICENSE                       <- Apache-2.0
â”œâ”€â”€ .gitignore                    <- ignores node_modules, .vs, dist, OS cruft
â”œâ”€â”€ publish.ps1                   <- one-command publish/update script
â””â”€â”€ print-advanced/               <- the widget (drops into your-extensions/widgets)
    â”œâ”€â”€ package.json
    â”œâ”€â”€ package-lock.json
    â”œâ”€â”€ manifest.json
    â”œâ”€â”€ config.json
    â”œâ”€â”€ icon.svg
    â”œâ”€â”€ README.md                 <- install steps, features, troubleshooting
    â”œâ”€â”€ LICENSE
    â”œâ”€â”€ .gitignore
    â”œâ”€â”€ .npmignore
    â””â”€â”€ src/ ...
```

The widget lives in the `print-advanced` subfolder so this repo can hold project level files without polluting the shareable widget. Only the `print-advanced` folder is dropped into an Experience Builder install.

## Install (for users)

See `print-advanced/README.md` for the full steps. In short: place the `print-advanced` folder in `client\your-extensions\widgets\`, run `npm install` from the `client` folder, then restart.

### The release zip and the editor shims

The zip is the widget only. The Visual Studio type shims in the repo (`print-advanced/src/exb-editor-shims-print-advanced.d.ts`, `print-advanced/src/exb-editor-shims.d.ts`) are left out on purpose: their ambient `declare module` blocks are not file-scoped and would rewrite the react, jimu and esri types for every other widget in your `your-extensions` folder.

If you clone the repository instead of using the zip, delete `print-advanced/src/exb-editor-shims-print-advanced.d.ts` and the other shim files listed above before building; nothing else depends on them.

## Publishing updates (for the maintainer)

`publish.ps1` syncs the widget from the live Experience Builder folder into this repo's `print-advanced` subfolder (skipping `node_modules` and `.vs`), commits, pushes to GitHub, and optionally cuts a release. Edit the three variables at the top of the script if paths change.

- Code update only:
  ```
  powershell -ExecutionPolicy Bypass -File .\publish.ps1
  ```
- Code update plus a new downloadable version:
  ```
  powershell -ExecutionPolicy Bypass -File .\publish.ps1 -Release v1.0.0
  ```

Version tags must increase and never repeat. Bug fix: v1.0.1. New feature: v1.1.0. Major change: v2.0.0.

For the Esri Community post, zip the `print-advanced-widget\print-advanced\` subfolder (not the live EB widget folder) and upload that as the attachment, so it stays in sync with the GitHub release and stays free of `node_modules` and `.vs`.

## Contributors

- Brian McLeer, City of Grand Junction, CO (author, maintainer)
- Nicholas Cramer, Polk County, OR (contributor)

## License

Apache-2.0. See the LICENSE file.
