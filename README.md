# TELLY — Live English TV

Mobile-first IPTV browser for ~2,900 free English-language channels, built as a
static web app — no build step, no backend.

**Data:** the open-source [iptv-org](https://github.com/iptv-org/iptv) playlists,
fetched client-side (CORS-enabled):

- `languages/eng.m3u` — every English-language channel
- `countries/au.m3u` — merged in so all 🇦🇺 Australian channels are guaranteed

## Features

- **Auto-categorized** — 27 categories (News, Sports, Movies, Kids…) parsed from
  the playlist's `group-title`; "Undefined" channels are rescued via keyword rules.
  Religious channels are excluded (by playlist category and by name keywords)
- **Three view modes** — card grid, dense logo wall, detailed list
- **Zoomable thumbnails** — pinch the grid on touch, or use the toolbar slider
- **Country filter** with flags (parsed from `tvg-id`), search, favorites (localStorage)
- **In-app player** — hls.js with retry/error handling, native HLS on iOS,
  related-channels rail, copy-URL fallback for VLC
- **Multiview** — watch up to 15 channels at once on a video wall that always
  fits the screen; tap a tile for sound, keys 1–9 switch audio, per-tile
  quality capping saves bandwidth. Add channels from the player (⊞), by
  long-pressing any card, or via pick mode
- Lazy-loaded logos with generated initial placeholders, infinite scroll,
  12-hour channel cache, collapsing toolbar on scroll

- **Multiview picture-in-picture** — hitting ＋Add pops the audible channel
  into PiP (native OS window, in-app floating dock as fallback) so it keeps
  playing while you browse for more channels

## Running

Serve the repo over HTTP:

```bash
python3 -m http.server 8877   # http://localhost:8877/
```

## Stream checker

Validate every stream in the playlists — reports broken URLs by failure type
(404/403/timeout/DNS/TLS…) with same-channel replacement suggestions:

```bash
node tools/check-streams.mjs   # writes tools/report/stream-report.json + broken.csv
```

Note: streams come from public broadcasters — some are offline or geo-blocked.
