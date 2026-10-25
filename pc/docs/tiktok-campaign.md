# SHUSHA TikTok pilot operations

The pilot reuses the existing authenticated asynchronous `tiktok.post` task
channel and the mobile trusted script. It adds no remote-control permission, new
Node Server deployment or TikTok Direct Post API connection. It is not a TikTok
Shop checkout, a customer-message sender or proof of account eligibility.

Keep `TIKTOK_CAMPAIGN_ENABLED=false` until the merchant has reviewed the complete
videos, captions, destinations, account/device binding and schedule. The empty
[environment template](tiktok-campaign.env.example) contains only the new variable
names. Copy values into an existing **private** environment file; never commit a
real environment, campaign, account handle, source evidence, rendered video,
approval, journal or inquiry record.

## Prepare one reviewable bundle

Use exactly three distinct styles with authorized original photos. The local
[renderer](../../scripts/tiktok/README.md) prepares silent 18-second portrait
videos from four or five photos per style. It fits the whole photo and adds copy
outside it; it does not generate or retouch products. A render report records
source/output hashes and actual ffprobe metadata. Rendering is preparation only.

Review each video from beginning to end. Keep its SKU, original-photo evidence,
rendered hash, English title, complete caption and destination together. Do not
rotate independent caption and photo pools for this campaign. Do not invent MOQ,
profit, availability, delivery times or prices. Availability, freight and payment
remain manually confirmed. Use the website as the primary inquiry destination;
when the account has no usable profile link, use an accurate "DM us with the
style code" fallback. Do not suggest a caption URL is a clickable profile link.
Do not post automated DMs or comments.

Before the first dispatch, verify the intended account and authorized phone,
the installed application and trusted-script release, accessible exact media
file, and account support for per-post **Public** audience plus commercial
disclosure **Your brand**. A private account without the required public option
stops; the script must not change global account privacy, consent to rights
dialogs or claim a paid partnership. Browser/device observations and a real post
are separate acceptance evidence from local tests.

The campaign binds one account and one device. The media on the phone must match
the reviewed MP4 byte-for-byte. The client hashes it before execution, and the
trusted script hashes it again around the editor/commit boundary. Its filename
is only a convenience. Do not transfer unreviewed assets or enable a campaign
merely because its filename contains a hash.

## Private manifest schema

Store `manifest.json` in an ignored `.tmp/` directory or another private folder.
This abbreviated schema uses placeholders, not real accounts, assets, approvals
or accepted hashes. Supply **three** complete creative objects; the second and
third must also have their own UUID, SKU, approved media and schedule.

```json
{
  "schemaVersion": 1,
  "campaignId": "<private-pilot-id>",
  "expectedHandle": "<pinned-account-without-at-sign>",
  "deviceClientId": "<existing-authorized-device-id>",
  "timezone": "Asia/Shanghai",
  "creatives": [
    {
      "publicationId": "<stable-uuid>",
      "sku": "<SHUSHA-L-style-number>",
      "videoPath": "<absolute-private-mp4-path>",
      "devicePath": "/sdcard/Download/<name>-<first-16-hash-characters>.mp4",
      "sha256": "<64-lowercase-hex-approved-video-sha256>",
      "title": "<reviewed-English-title>",
      "caption": "<reviewed-complete-English-caption>",
      "landingUrl": "https://shop.this-time.com/wholesale?utm_source=tiktok&utm_campaign=<pilot>&utm_content=<style>",
      "sourceVerifiedAt": "<ISO-8601-source-review-time>",
      "sourceEvidenceSha256": "<64-lowercase-hex-private-source-evidence-sha256>",
      "scheduledAt": "<future-date>T13:00:00.000Z",
      "postSettings": {
        "audience": "PUBLIC",
        "commercialDisclosure": "YOUR_BRAND"
      }
    }
  ]
}
```

The actual SKU format is `SHUSHA-L` followed by four digits. Publication UUIDs and
SKUs are unique. Use a distinct complete creative for each style. Each schedule
is **21:00 Asia/Shanghai**, expressed as 13:00 UTC, at least two days after the
previous one. The local video must be a nonempty MP4 of at most 200 MiB. Source
review time must be no later than its slot. Refresh and review changed source
facts before approval; a timestamp alone does not establish current stock or
rights. There is no arbitrary URL upload, source scraping or source API key in
this runner.

The approved digest covers the complete manifest, including schedule, private
source reference, account, device, video hash and copy. Changing any field
invalidates approval. Keep the original approved files while an attempt is
unresolved; editing the account/device or creative cannot redirect recovery.

## Review, approve and observe the first attempt

Run these commands from `pc/` with installed local dependencies. The paths and
values below are placeholders. `review` validates the manifest and prints its
digest; it does not authorize or dispatch anything.

```powershell
$campaignDirectory = 'D:\private\shusha-pilot'
.\node_modules\.bin\tsx.cmd src/tiktok-campaign-runner.ts review $campaignDirectory
```

Only after the merchant reviews that exact complete bundle, record the matching
digest and the actual reviewing operator's identifier:

```powershell
.\node_modules\.bin\tsx.cmd src/tiktok-campaign-runner.ts approve $campaignDirectory '<reviewed-manifest-sha256>' '<reviewer>'
```

Do not generate approval as part of rendering, tests, a worker or a device editor
ACK. The script's `EDITOR_READY` ACK is an internal persistence handshake, **not
merchant creative approval**. The mobile client persists the original observed
Public/Your-brand evidence before acknowledging it and before `COMMITTING`.
That proof is timestamped once and retained through original-ID recovery; old
publications do not acquire fabricated verification flags.

The first real attempt requires the approved manifest and an observing operator.
Run this within its scheduled one-minute window:

```powershell
.\node_modules\.bin\tsx.cmd src/tiktok-campaign-runner.ts observed-first $campaignDirectory
```

The runner persists `DISPATCHING` before contacting the existing task service.
A task receipt becomes `ACCEPTED`, which means asynchronous acceptance only.
Lost or ambiguous delivery becomes `HOLD`. Neither state proves publication.
The same publication is never automatically dispatched again as a new publish.
Keep existing active locks; inspect their process/operation state before any
manual recovery. Never delete a lock to force another attempt.

## Inspect and recover the original publication

```powershell
.\node_modules\.bin\tsx.cmd src/tiktok-campaign-runner.ts inspect $campaignDirectory '<original-publication-uuid>'
.\node_modules\.bin\tsx.cmd src/tiktok-campaign-runner.ts status $campaignDirectory '<original-publication-uuid>'
.\node_modules\.bin\tsx.cmd src/tiktok-campaign-runner.ts recover $campaignDirectory '<original-publication-uuid>'
```

`inspect` polls the latest original/recovery receipt. `status` and `recover` queue
an asynchronous task using the **same UUID**, pinned account/device and approved
creative. Use `inspect` again to read its result. Recovery searches for the
original work/link; it does not publish again. Do not switch IDs to bypass an
unknown result, clear the private ledger or substitute another style.

Technical acceptance requires the task's actual device/script identity and
creation time, matching v2 UUID, `LINK_CONFIRMED`/`SUCCESS`, the pinned-account
canonical video URL and post ID, original Public/Your-brand proof, and matching
media/caption hashes. Hash-only `creativeEvidence` exposes no paths, account or
raw caption. `captionSha256` is exactly:

```javascript
sha256(JSON.stringify({ title: selectedTitle, details: selectedDetails }))
```

The object key order shown is intentional. `mediaSha256` is emitted only for a
record whose actual media fingerprint equals its explicitly approved hash.
`requestFingerprint` identifies the original mobile ledger request. These new
fields are optional for older generic v2 records, whose original fingerprint
encoding remains unchanged; campaign acceptance requires the new evidence.

Technical success enters `REVIEW_REQUIRED`, not public acceptance. Independently
open the public post as an ordinary viewer and verify the exact style, copy,
commercial disclosure and public visibility. Save that observation privately,
hash it, and only then record acceptance:

```powershell
.\node_modules\.bin\tsx.cmd src/tiktok-campaign-runner.ts accept-public $campaignDirectory '<original-publication-uuid>' '<canonical-video-url>' '<reviewer>' '<private-public-review-evidence-sha256>'
```

The second and third posts stay held until every preceding attempt is
`PUBLIC_ACCEPTED`. A successful own-profile link, task code, test, screenshot
from the editor or promise of future public access does not satisfy that gate.

## Scheduling and explicit replanning

After a genuinely accepted first post, a reviewed future schedule can use the
worker inside the existing PC process. Set the private directory and enable its
flag deliberately. It performs bounded passes every 15 seconds; it does not
add a service, server endpoint, phone privilege or cloud scheduler. Keep exactly
one intended PC worker. A manual bounded pass uses:

```powershell
.\node_modules\.bin\tsx.cmd src/tiktok-campaign-runner.ts tick $campaignDirectory
```

There is no catch-up. A slot at least one minute late becomes `MISSED`; later
creatives stay held. Only never-dispatched missed slots can be explicitly moved:

```powershell
.\node_modules\.bin\tsx.cmd src/tiktok-campaign-runner.ts reschedule $campaignDirectory '<new-future-date>T13:00:00.000Z' '<reviewer>'
.\node_modules\.bin\tsx.cmd src/tiktok-campaign-runner.ts review $campaignDirectory
```

Replanning preserves UUIDs, journals the old manifest/approval/ledger, invalidates
approval, and moves remaining slots at two-day intervals. Review the new bundle
and approve its **new digest** before continuing. An attempted, uncertain or
unreviewed publication cannot use rescheduling to become another fresh publish.
The first real post still needs `observed-first` if none has been accepted yet.

## Private inquiry tracking

Copy [the header-only CSV template](tiktok-inquiries.csv) to a private location.
It contains no customer examples. Keep the public template empty. Record one row
per inquiry with a stable private ID. Update that row when following up rather
than counting the same lead again. Use these fields:

| Field | Meaning |
| --- | --- |
| inquiry_id | Stable private ID used to deduplicate inquiries and follow-up |
| day | Local date of inquiry/follow-up |
| source | Campaign or source reference, such as TikTok/UTM |
| country | Customer-stated destination country when provided |
| selling_channel | Customer-stated online store, social selling or other selling channel |
| styles | Requested SHUSHA style codes |
| qty | Quantity actually requested, blank if unknown |
| qualified | Country, selling channel, styles and quantities are all provided |
| quoted | Whether an actual quote was supplied |
| followup | Next manual action/date or its outcome |

Keep customer handles, messages, contact details, quotations, bank details and
order references private. Do not add them to Git, public captions or test
fixtures. An inquiry is not a paid order; merchant confirmation and independently
verified incoming funds remain separate steps. No automatic customer messaging,
payment, refund, inventory replenishment or historical-order import is enabled
by this pilot.

## Local validation and remaining live acceptance

The PC campaign tests use private synthetic files and mocked transports. Mobile
policy tests cover optional-field validation, original fingerprint preservation,
hash mismatch before ledger creation, immutable settings evidence, recovery and
unknown-outcome holds. Trusted-script VM tests exercise precommit ordering with
synthetic UI/file APIs. Renderer tests validate layout and local-only inputs.
These tests do not access a phone, publish a TikTok post or prove public reach.
The observed first real publication and independent public review are still
required before reporting live acceptance or enabling later unattended slots.

From the repository root, run the additional trusted-script and renderer checks
with local dependencies/tools; the complete render integration requires local
ffmpeg, ffprobe and a supported font:

```powershell
node mobile/test/tiktok-script-settings.test.mjs
node --test scripts/tiktok/render-pilot.test.mjs scripts/tiktok/render-pilot.integration.test.mjs
```
