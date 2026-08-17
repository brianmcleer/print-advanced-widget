# Print Advanced: The Two Summits and the Notice Workflow

Plan of record for the three largest remaining features. Written against the
current engine internals so implementation sessions can start building
immediately. House style: no em dashes, PowerShell 5.1 semicolons.

## 1. Map Series (grid or corridor, one PDF, index page)

Goal: staff pick a grid over an area or a corridor along a line; the widget
exports one PDF with a page per tile plus an index page showing tile outlines
and page numbers. This is the single feature that still drags staff back to
ArcGIS Pro.

Architecture, building on what exists:
- Tile math is pure geometry. A new lib module (seriesMath.ts) computes tile
  extents from (a) a rectangle plus rows x cols or target scale, or (b) a
  polyline corridor buffered to frame aspect, walked at fixed overlap
  (10 to 20 percent). Inputs are ground units; reuse metersPerMapUnit and
  extentFitScale from scaleMath.
- Capture loop reuses captureMapHiRes once per tile with scaleMode fixed and
  lockedCenter per tile. CRITICAL known hazards already solved elsewhere:
  set tmp.map = null before destroy (shared WebMap destruction), and respect
  memoryConstrainedDevice caps. Captures must run SEQUENTIALLY, never
  parallel, or GPU memory compounds; reuse one offscreen view across tiles
  (create once, goTo per tile, screenshot, destroy at end) to avoid N view
  startups.
- PDF assembly follows the multi-page legend precedent exactly: one jsPDF
  doc, composePage per tile with doc.addPage, page furniture per tile
  (title token {page} of {pages}, tile id in a corner), legend on the pages
  the admin chooses (first page, all pages, or additional pages).
- Index page: render composePage with a synthetic capture of the OVERVIEW
  extent (one extra captureMapHiRes at the series envelope), then draw tile
  rectangles and page numbers as vector overlays using the existing
  ground-to-page transform (printExtent inverse; the grid renderer already
  does ground-to-page math to copy).
- UI: a Series section in Advanced options, gated by admin control. Draw
  extent (reuse the preview rectangle interaction) or pick a corridor by
  clicking a line feature. Estimated page count shown BEFORE export; hard
  cap (default 30 pages, admin setting) with the honest-warning pattern.
  Queue shows one job with per-tile progress (Tile 4 of 12).
- Proof battery: pure tests on seriesMath (tile counts, overlap, corridor
  turns, aspect); real-pdf proof asserting page count, per-page scale text,
  and index rectangles within page bounds via pymupdf.
- Estimated effort: 2 to 3 sessions. Session 1 seriesMath plus proofs;
  Session 2 capture loop plus PDF assembly plus proofs; Session 3 UI,
  queue integration, iOS budgets, docs.

## 2. True Vector Output (feature layers as PDF linework)

Goal: render visible FeatureLayers as vector paths in the PDF instead of
pixels in the raster capture. Infinite zoom crispness, small files, and the
last gap to Pro-quality output.

Strategy: hybrid, not purist. Basemaps and rasters stay in the capture;
operational FeatureLayers are EXCLUDED from the capture (layer.visible off on
the offscreen view only) and drawn as vectors on top. This sidesteps the
impossible (vector basemap tiles) and wins where it matters.
- Data: layer.queryFeatures on the print extent with outSR = capture SR,
  maxRecordCount paging, geometry generalized to page resolution
  (maxAllowableOffset = ground units per 0.5 pt) so files stay small.
- Transform: ground-to-page points via the same math the grid renderer uses.
  Clip to the map frame with a jsPDF clipping path (drawing.ts gains
  saveClip and restore).
- Symbology: an SLD-lite mapper from renderer JSON to PdfDrawer calls.
  Phase 1 supports simple and unique-value renderers with SimpleFill,
  SimpleLine, SimpleMarker (circle, square, diamond, x, cross). Anything
  unsupported (picture markers, complex fills, class breaks initially,
  labels) FALLS BACK per layer to the raster capture, honestly noted in the
  result meta (Vector: 4 layers, raster fallback: 2). Labels stay raster in
  phase 1; phase 2 evaluates queryFeatures with returned label text plus a
  greedy placement pass.
- Draw order: capture image first, then vector layers bottom-to-top in map
  order, then grid, then furniture. Transparency via jsPDF GState alpha.
- Proof battery: pymupdf get_drawings counts per symbol class, path point
  counts vs generalization budget, clip containment, and a visual contact
  sheet. A byte-size assertion (vector page smaller than raster equivalent
  for a parcels layer).
- Risks: SVG export path needs the same clip support; iOS memory improves
  (smaller captures) but queryFeatures adds network time, so progress text
  per layer. Effort: 3 to 4 sessions. Ship phase 1 behind an admin toggle
  (Vector overlays: experimental).

## 3. Public-Notice Exhibit Mode (synergy with mailing-labels-widget)

Goal: planning staff produce the notice map AND the mailing labels from one
buffer in one sitting.

- Input contract: the mailing-labels widget already computes subject parcel,
  buffer distance, buffer ring, and selected parcels. Define a tiny shared
  JSON payload (subject geometry, ring geometry, parcel geometries plus ids,
  distance text) passed either via a jimu message action (widget to widget on
  the same page) or a session key.
- Rendering is almost free: the ring and highlights are exactly the vector
  overlay machinery from Summit 2 phase 1 (two symbolized geometry sets),
  drawable even before Summit 2 ships as a special case. Furniture: a
  standard exhibit block (Notice of Public Hearing, case number token
  {case}, buffer distance, date) as an admin-configured text element
  template, plus the disclaimer text setting.
- One new layout element token: {case}; XML export carries it automatically
  (generic serializer, verified).
- Effort: 1 to 2 sessions once the message contract is agreed; the
  mailing-labels side needs a Send to Print Advanced action.

## Sequencing recommendation

Notice exhibit first (smallest, immediate staff value, and it forces the
vector overlay primitives into existence), then Map Series, then full Vector
phase 1. Each ships behind an admin toggle with the proof-battery discipline:
nothing merges without a machine-verified assertion suite.
