# WebRTC browser playback — 2026-08-12

## Goal

User reported the WHEP player failing in the browser with:

```
Failed to execute 'setRemoteDescription' on 'RTCPeerConnection': Failed to set
remote answer sdp: The order of m-lines in answer doesn't match order in offer.
```

HLS played fine. Turned out to be three stacked bugs, each hiding the next, plus
a fourth issue that only appears on the large production streams.

## Why this was never caught

`plans/stitchd-absorb-mediamtx.md` recorded WebRTC as working because
"WHEP POST returns 201 with media on :8189" — the endpoint was checked for the
*shape* of its answer, never driven with a browser. Exactly the lesson already
written down for RTSP in that same doc: ffmpeg tolerated RTP timestamps VLC
would not. A protocol endpoint is only verified by a real client.

## The three bugs (all fixed, verified in Chrome)

1. **m-line / mid mismatch** — the error the user saw. `addTrack()` ran *before*
   `setRemoteDescription()`, with a hardcoded mid of `"video"`. libdatachannel
   matches media by mid, so it never reconciled with the offer's m-line and
   appended a second one. Reproduced with a hand-built offer:

   ```
   OFFER  m-lines (kind, mid): [['video', '0']]
   ANSWER m-lines (kind, mid): [['video', '0'], ['video', 'video']]
   ```

   Fix: read the offer's video mid and answer on it.

2. **No in-band SPS/PPS.** The encoder runs with `AV_CODEC_FLAG_GLOBAL_HEADER`,
   so parameter sets live in extradata. RTSP is fine — libavformat puts them in
   the SDP — but a browser needs them in the bitstream, and a viewer joining
   mid-stream could never recover. Measured: 9180 packets / 8.5 MB received,
   `framesDecoded` 0, `pliCount` 278. Fix: prepend them to every keyframe.
   Confirmed from the wire that a keyframe began `00000001 06 …` (SEI) then
   `00000001 65` (IDR) with no SPS/PPS anywhere.

3. **Hardcoded payload type 96 — which is VP8 in a Chrome offer.** We sent H.264
   on a payload type the browser had defined as something else, so it routed our
   packets to the wrong depacketizer and assembled nothing: `framesReceived` 0
   with *no codec stats at all*, plus a PLI flood. Fix: take the payload type
   and its fmtp from the offer (an answer may not redefine what a PT means) and
   prefer an H.264 entry matching the profile we encode. Chrome picked **116**.

Also: `profile-level-id` is now derived from the SPS we actually send
(libdatachannel's default advertises constrained baseline, our encoder is Main),
and the player calls `play()` explicitly so a hidden/backgrounded tab does not
sit on a black rectangle with the stream arriving behind it.

**Verified in Chrome against a side instance:** `video/H264` on the negotiated
pt 116, 800x450, 278 frames decoded, 15 fps, **pliCount 0**, playing.

## STILL BROKEN: large streams stall — no sender pacing

Production `entry` (1200x1352) negotiates correctly and decodes its first
frames, then stalls. Measured in Chrome after ~2 min:

| metric | value |
| --- | --- |
| packetsReceived | 85,183 |
| **packetsLost** | **16,242 (~16 %)** |
| nackCount | 2,107 |
| pliCount | 261 |
| framesReceived / Decoded | 120 / 120, then frozen |
| jitter | 0.007 |

16 % loss on a LAN is not a network fault — it is the sender bursting.
`track->send()` hands a whole encoded frame to libdatachannel at once, which
emits ~100+ RTP packets back to back with no pacing. A large keyframe overruns a
UDP buffer somewhere, the frame never completes, Chrome PLIs, the *next*
keyframe bursts just as hard, and it never recovers. The 800x450 test stream at
15 fps never hit this (pli 0), which fits: the problem scales with frame size.

Options, roughly in order of appeal:

1. **Pace the sender** — spread a frame's packets across the frame interval
   rather than emitting them in one burst. The real fix; needs a send queue and
   a timer in `webrtc.cpp`.
2. **Raise UDP buffer sizes** on the mux socket — cheap, may only move the cliff.
3. **Offer a smaller variant over WebRTC** — a dedicated low-bitrate output for
   browser viewers.

Not attempted yet; it is a distinct piece of work from the negotiation bugs and
wants its own validation, on the side instance, before touching production.

## Test rig

Same as `plans/stream-latency-2026-08.md`: `tmp-side-instance.sh` +
`tmp-rtsp-relay.py`. `plans/tmp-whep-offer.py` posts a Chrome-shaped offer and
diffs the answer's m-lines against it — that reproduces bug 1 in one command
without a browser. Bugs 2 and 3 needed a real browser and `getStats()`;
`framesReceived` vs `framesDecoded` vs a missing `codec` entry is what separates
"wrong payload type" from "cannot decode" from "not arriving".

## Follow-up 2026-08-16: mediamtx and the ffmpeg compositor deleted

Answering "why are we still using mediamtx?" turned up that we weren't — it had
not run since the cutover — but it survived as a `compositor: ffmpeg|native`
fallback, along with the entire ffmpeg filtergraph builder. Deleted outright
(`df5a8b6`).

Gone: `src/mediamtx.ts`, `src/hwaccel.ts`, `buildPipeline` /
`buildExtraCompositePipeline` / `buildCommand` / `ensureHwaccelWorks`, the
mediamtx launch and its CLI flags, the mediamtx control-API fallbacks in the
dashboard and watchdog, the second ffmpeg audio pump in `transcribe.ts`, the
52 MB mediamtx download in the Dockerfile, and the `compositor` / `hwaccel` /
`mediamtx_api_url` config keys. `src/ffmpeg.ts` became `src/stitchd.ts` with
only the config builder left. **4895 -> 3339 lines**, and `bun run check` is
clean for the first time in this work.

Kept deliberately: **ffprobe** probes cameras at startup and **ffmpeg** renders
the dashboard's snapshot thumbnails. Those are live users, not a fallback.

The GPU-or-loud-error rule moved rather than vanished: `ensureHwaccelWorks`
probed *ffmpeg's* CUDA support, which proved nothing about stitchd. stitchd
creates a CUDA device and opens NVDEC/NVENC at startup and exits on failure.

Verified before deploying: a dry run against the live `config.yaml` produced a
**byte-identical 45-line stitchd.conf**, so the process under supervision got
exactly what it got before.

### Raw streams in the dashboard

The same status change that lists `raw/<name>` (see
`stitchd: list the raw/<name> republishes`) is now rendered. All **16** paths
appear — 6 outputs and 10 raw. Raw rows are tagged `raw · rtsp only` and carry
just the RTSP link, because stitchd registers WebRTC and writes HLS only for
the encoded outputs; offering those links on a raw row would be two dead ends.

While in that markup, every `title=` tooltip was removed (invisible on touch);
the snapshot/copy affordance is now an inline hint. The page reports **0**
`title` attributes.

## Follow-up 2026-08-16b: the last two ffmpeg binaries are gone

"Can't stitchd do everything?" — yes. First, a correction that matters: stitchd
**is** ffmpeg where it counts. It static-links libavformat/libavcodec/libavutil/
libswresample. The goal was never to remove ffmpeg's code, only the external
binaries and the duplicated work they were doing.

**Snapshots.** The dashboard spawned an ffmpeg per stream per minute that
reconnected over RTSP and decoded a full frame — up to 2688x1512 — to make a
320px thumbnail. Listing the raw cameras had just taken that from 6 spawns a
minute to **16**, so this got worse before it got better. stitchd already holds
every one of those frames on the GPU: a new kernel box-filters NV12 down to
thumbnail size as planar YUV420, and libavcodec's mjpeg encoder (already
linked) makes the JPEG. Served at `GET /api/snapshot/<name>`.

`blue` and `bullet` are opened audio-only, so nothing decodes their video and
they were the only two of sixteen with no thumbnail. They now decode exactly
one frame on request, starting at a keyframe, from packets already in hand —
the first request after startup arms it and returns 503, the next serves. The
dashboard prewarms every 60 s, so a hover is always warm.

**Probing.** The supervisor needs camera geometry before it can generate
stitchd's config, so it shelled out to ffprobe per camera. `stitchd --probe
<url>...` answers with the same libavformat — one process for ten. It prefers
`r_frame_rate` over `avg_frame_rate`: they agree on the bays, but the bullet
throttles when idle and measured **9 fps against its nominal 20**, and the
layout must not depend on how busy a scene was at startup.

### Result

| | before | after |
| --- | --- | --- |
| Binaries in `/usr/local/bin` | bun, ffmpeg, ffprobe, mediamtx, stitchd, whisper×2 | bun, stitchd, whisper×2 |
| Image weight removed | — | **~104 MB** (52 mediamtx + 52 ffmpeg/ffprobe) |
| Snapshot cost | 16 process spawns + 16 RTSP sessions + 16 full decodes / min | 16 GETs against frames already in memory |
| `client playing` log lines / 3 min | ~48 | **5** |
| Container CPU | ~35 % | **~28 %** |
| Snapshots working | 16/16 | **16/16** (verified through the dashboard's own route) |

Verified before deploying: a full dry run against the live `config.yaml`, now
probing through stitchd, produced a **byte-identical 45-line stitchd.conf**.

## Where the web UI lives (2026-08-16c)

Four pieces, none of them previously a file on disk:

| Surface | Source | Served by |
| --- | --- | --- |
| Dashboard | `src/web/dashboard.html` (808 lines) | bun, `:9000/` |
| HLS player | `src/web/player.html` (53 lines) | bun, `/hls/<name>/` and `/all-field` via Caddy |
| WHEP player | `compositor/src/player.h` (`kPlayerHtml`) | **stitchd**, `:8889/whep/<name>` |
| hls.js | `node_modules/hls.js/dist/hls.min.js`, 543 KB | bun, `<base>/hls.js` |

The first two were template literals inside `dashboard.ts` — 861 lines of
markup, CSS and browser JS with no highlighting, no formatting and nothing to
catch a typo short of loading the page (`bun run check` validated the
TypeScript around them and never looked inside). Now real files;
`dashboard.ts` drops **1296 → 443** lines of actual server code.

**Extraction gotcha worth keeping:** copy the template's *source text* and you
ship its escapes. The player contains
`location.pathname.replace(/\/+$/, '')`, which is written `\/` inside a
template literal — a raw copy silently shipped the extra backslash and broke
the regex. `scripts/extract-web-assets.ts` evaluates the literal in JS instead,
so escape processing happens exactly as the browser saw it.

**Measuring gotcha:** comparing the served page by piping curl through ssh into
a file on Windows silently dropped 45 bytes from *both* sides, which read as a
convincing "IDENTICAL". Compare on the Linux box (`cmp` served vs the deployed
file) — that showed 36495 == 36495, and the regex survived intact.

`player.h` stays embedded in stitchd deliberately: that binary deploys as a
single static file, and a sibling asset it could fail to find is the worse
trade there.

Verified after deploy: dashboard renders 16 rows (6 outputs + 10 raw), live
data populating, **zero JS errors**, and the HLS player page still returns 200
with its `<video>` and an intact regex.
