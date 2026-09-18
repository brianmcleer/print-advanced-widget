# Changelog

Newest first. Every release bumps `manifest.json` and `package.json` together.

## 1.6.4 (2026-09-18)

- Added: anonymous usage and error telemetry (shared beacon module; off unless the portal publishes an exb-beacon-sink table; telemetry: false in config disables it).

## 1.6.3 (2026-09-18)

- Security: pinned the transitive dompurify (via jspdf) to 3.4.13 or newer with a pnpm override, closing the two Dependabot alerts (IN_PLACE hook removal XSS, CUSTOM_ELEMENT_HANDLING bypass).

## 1.6.2 (2026-09-17)

- Packaging: the Visual Studio editor shims are no longer in the release zip. `publish.ps1` strips them from a staging copy (`$ReleaseOnlyExclude`) and refuses to zip if any ambient `declare module` of react, jimu or esri survives. The shims stay in the GitHub repo; clone users delete them before building.

## Earlier releases

See the GitHub releases page and the changelog section of the README, if any.

