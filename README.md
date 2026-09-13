# 直到地极 · An interactive map of the Acts of the Apostles

A 3D relief map of the world the book of Acts moves through: 63 places, the four
itineraries drawn over real terrain, and the Roman provinces as they stood
around AD 50. Simplified Chinese, Traditional Chinese and English.

It is a sibling of [messiah-land-map](https://github.com/nullbotnone/messiah-land-map)
and reuses most of its engine — the projection and the Google-Earth-style pointer
controls, the canvas terrain renderer, the greedy label declutter, and the
three-way script toggle that converts the DOM after each render. What is new here
is the journeys layer and a frame twenty times wider.

## The map at a glance

* **Terrain** — GMRT, resampled onto a 0.025° (~2.8 km) grid, 521,541 nodes,
  drawn as a depth-sorted mesh with hillshading from the true surface gradient.
  Heights are exaggerated 20×; at this width they would otherwise be invisible.
  The full mesh takes about half a second to paint, so it is drawn once the view
  settles; while you drag, a coarser pass aims at a fixed budget of ~15,000 cells
  (`DRAFT_STRIDE`) so the grid step and the drag feel stay independent.
* **No coastline vector.** The builder writes every negative elevation outside
  the Jordan rift as zero, so the zero-metre contour *is* the shore. That is the
  one change that lets the map span a sea full of islands without carrying a
  shapefile — the Israel map needed a digitised coast because its frame had a
  single monotone shoreline in it.
* **Provinces** — hand-authored rings, tinted by standing (Italy, senatorial,
  imperial, client kingdom). They are generous blobs rather than surveyed
  borders, which is affordable because only dry cells are tinted: wherever a ring
  runs out over water, the sea trims it.
* **Journeys** — each itinerary is a list of gazetteer ids, resampled at 0.15°
  and draped over the ground. Acts names the stops, not the tracks, so an
  overland leg follows the Roman road that joined two towns and a sea leg the
  shortest sensible course. Pick a journey from the legend or the filter bar and
  the other three drop back.

## Running it

```
npm install
npm run dev            # vite dev server
npm run build:static   # static bundle into dist-static/
```

`npm run build:dem` refetches `app/dem.ts` from the GMRT grid service — one
request for the whole box, a few seconds. It only needs running if the bounds or
the grid step change.

`npm run build:zh` regenerates `app/zh-hant.ts` after any Chinese text changes —
it derives a Simplified→Traditional table from OpenCC covering only this site's
vocabulary, so the 6 MB of OpenCC dictionaries never reach the browser.

## Checks

CI runs all of these, and they are worth running before a commit:

| command | what it holds |
| --- | --- |
| `npm run verify` | DEM grid alignment against surveyed landmarks, no dry land below sea level outside the Jordan rift, every place inside the frame, every journey stop resolving |
| `npm run check:view` | markers sit *on* the mesh, cursor-anchored zoom holds within half a pixel in both projections, itineraries stay in frame, the exaggeration figure quoted in the prose matches `EXAGGERATION` |
| `npm run check:videos` | every embedded video still resolves and still belongs to the BibleProject channel; every place it names exists; every video in the catalogue is used |
| `npm run check:en` | every user-visible Chinese string has an English form in `app/en.json`, and nothing in the table is stale |
| `npm run lint` | `tsc --noEmit` |

## Videos

Twenty-five of the sixty-three places carry a BibleProject video, from
`app/videos.ts`. Acts is a book of journeys and BibleProject covers it as four
narratives — Pentecost, then Acts 8–12, 13–20 and 21–28 — so those are stories of
specific places rather than surveys. That is why they qualify where a book
overview would not: an overview of Acts is no more a video about Philippi than an
overview of Mark is a video about Gadara, and the two "Book of Acts Summary"
videos are deliberately absent.

A place earns one when its own passage sits inside a video's span *and* something
actually happens there. The second half does most of the work: Amphipolis and
Apollonia are "they passed through" (17:1), Samothrace and Neapolis are one verse
of sailing (16:11), Syracuse and Rhegium are ports the ship touched on the way
north. None of them get one. Each mapping carries the passage that earns it, so
the pairing can be checked rather than trusted.

The labels name the span — 使徒行传 13–20, not just a title — so a reader can see
they are getting the leg of the journey rather than a film about that one town.

Nothing is requested from YouTube until a reader asks for it. The panel shows a
poster; the `<iframe>` is only created on click, and it is keyed by place id so
moving to another site takes the player back down. The poster deliberately has no
thumbnail — an image from `i.ytimg.com` would tell Google about everyone who
merely opened a panel, which is the thing the lazy embed exists to avoid. The
embed itself goes to `youtube-nocookie.com`.

CI runs `check:videos` on every push but is not allowed to fail the build on it,
since an outage at YouTube is no reason to stop shipping terrain.

BibleProject is not affiliated with this map. The videos are embedded and
credited in the panel, never rehosted.

## Layout

```
app/dem.ts        generated elevation grid (base64 Int16, ~1.4 MB, ~375 KB gzipped)
app/geo.ts        provinces, region labels, seas, peaks — hand-authored
app/places.ts     the gazetteer and the four itineraries
app/videos.ts     the BibleProject videos and which place each belongs to
app/terrain.ts    projection, palette, sea mask, the canvas renderer
app/page.tsx      the whole UI, one client component
app/en.json       Chinese → English lookup, keyed by the simplified source text
```

## Sources and caveats

Elevation from [GMRT](https://www.gmrt.org/), the Global Multi-Resolution
Topography synthesis, through its
[GridServer](https://www.gmrt.org/services/index.html).

The grid was 0.1° to begin with, off point-query elevation APIs. Those meter by
the hundred-coordinate call — OpenTopoData allows a thousand a day, Open-Meteo
starts refusing well before that — and 0.05° needs thirteen hundred calls, so
the finer grid came with a change of source. GMRT serves a whole bounding box in
one request, which is why the resolution is now a choice rather than a quota.

Resolution is a single constant, `STEP` in `scripts/build-dem.mjs`. Halving it
quadruples the node count, the payload and the draw cost — 0.05° was 130,771
nodes and a 200 KB gzipped bundle, 0.025° is 521,541 and 485 KB — so measure
before going further. Ask for a GMRT tier two or three times finer than `STEP`;
the builder refuses a tier coarser than it. Hosting the grid as a separate binary
asset instead of base64 in the bundle was measured and dropped: it saves about
10% after gzip, which does not pay for making the DEM load asynchronously.

GMRT carries bathymetry, so the sea arrives as real depth and the builder
flattens it. Keep the rift box inland when changing it: an earlier one reached
far enough north-west to take in open Mediterranean, and that seafloor was then
preserved as if it were the Dead Sea, down to −1155 m. `npm run verify` now
floors the whole grid at the Dead Sea's own depth to catch exactly that.

Even at 5.5 km a cell the smallest islands are marginal — Cauda is about ten
kilometres across — so a few gazetteer sites still land in what the grid calls
open water; `verify` reports the count. Provincial borders and ancient place
names are educational approximations, and the route lines show the order of
travel, not surveyed tracks.

## Licence

[Apache License 2.0](LICENSE), copyright 2026 Jie Li. Use it, change it, ship it
commercially — keep the notice and say what you changed. No warranty. The
terrain and bathymetry come from GMRT and the place data from the gazetteers
named above; those carry their own terms, so check them before redistributing a
built map.
