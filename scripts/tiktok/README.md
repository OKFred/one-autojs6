# Local SHUSHA pilot video renderer

This helper prepares **private review videos**. It does not approve a campaign,
connect to a phone, publish posts, download photos or add music. Use authorized,
reviewed original photos. Keep the source photos, manifests, videos and reports in
an ignored `.tmp/` directory or another private location.

The fixed design is a silent 18-second, 30 fps, 1080 x 1920 H.264 MP4. Each of
four or five photos receives equal screen time. The entire photo fits inside a
solid background; there is no crop, generated product imagery, recoloring or
retouching. SHUSHA and the title appear above it. The SKU and short English copy
sit on a solid green lower band. Text stays between x=90 and approximately x=922,
below y=132 and above y=1630. Review the result in the actual TikTok composer,
because its controls vary by app version and device. The photos remain separate
from the overlays, and the original files are not changed.

The brand uses 64 px type, titles 40 px and captions 50 px, with a 840 x 900 photo
fit box above the band. Before rendering any video, the helper measures every
overlay using ffmpeg's own drawtext glyph metrics with the selected local font.
An overlay wider than 840 px or taller than its safe area fails preparation;
character counts alone never establish fit. The private report retains the
measured pixel bounds for each overlay.

Install/use local `ffmpeg` and `ffprobe` binaries with libx264 and drawtext. No
dependency is downloaded by this script. Optional `FFMPEG_PATH` and
`FFPROBE_PATH` environment variables select local executables. `fontFile` selects
a local font; otherwise Segoe UI, Arial or DejaVu Sans is located locally.

Create `.tmp/tiktok-synthetic/manifest.json`. The following is a synthetic schema
example; the named photos do not exist in this repository:

```json
{
  "outputDirectory": "rendered-review-v1",
  "videos": [
    {
      "id": "sample-a",
      "sku": "SHUSHA-DEMO-A",
      "title": "Synthetic style preview",
      "images": ["photos/a.png", "photos/b.png", "photos/c.png", "photos/d.png"],
      "frames": ["Front view", "Back view", "Detail view", "Ask about availability"]
    },
    {
      "id": "sample-b",
      "sku": "SHUSHA-DEMO-B",
      "title": "Synthetic second style",
      "images": ["photos/e.png", "photos/f.png", "photos/g.png", "photos/h.png"],
      "frames": ["Front view", "Back view", "Detail view", "Ask about availability"]
    },
    {
      "id": "sample-c",
      "sku": "SHUSHA-DEMO-C",
      "title": "Synthetic third style",
      "images": ["photos/i.png", "photos/j.png", "photos/k.png", "photos/l.png"],
      "frames": ["Front view", "Back view", "Detail view", "Ask about availability"]
    }
  ]
}
```

There must be exactly three video entries with distinct IDs. Each needs four or
five distinct local photos and the same number of frame captions. Paths are
resolved relative to the manifest. Copy is printable English; long copy fails
validation instead of being cut off. Titles wrap to two lines of 26 characters;
captions wrap to four lines of 26 characters. Keep captions short, accurate and
free of unverified shipping, price or inventory promises.

```powershell
node scripts/tiktok/render-pilot.mjs .tmp/tiktok-synthetic/manifest.json
node --test scripts/tiktok/render-pilot.test.mjs
node --test scripts/tiktok/render-pilot.integration.test.mjs
```

Existing outputs are never replaced. Use a new private output directory for an
updated creative. On failure, inspect any `.partial.mp4` before choosing a fresh
directory; the helper does not silently retry or overwrite it. The private
`render-report.private.json` records source file SHA-256 values, output SHA-256,
font hash and actual ffprobe streams/format metadata. It verifies H.264,
1080 x 1920, limited-range yuv420p, exactly 540 frames at 30 fps, 18 seconds and a
single video stream with no audio. The integration test creates only synthetic
JPEG/WebP color images and renders the complete four/five-photo pipeline using
local ffmpeg; it does not use supplier materials or a device. Rendering
does not prove asset rights, creative approval, TikTok publication or public
visibility. The merchant still reviews each complete rendered video before the
campaign manifest is approved.
