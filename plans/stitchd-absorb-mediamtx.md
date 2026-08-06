# Absorb mediamtx into stitchd — DONE (cutover 2026-07-31)

## Status: mediamtx is gone

Verified on sentinel after the cutover deploy (`4b46911`):

```
mediamtx processes           0
stitchd processes            1
NVR connections             10   (exactly one per camera)
internal localhost RTSP      0   (was ~24)
```

All six outputs serve from stitchd over RTSP :8554 — full hevc 7560x2688,
full-low h264 3600x1280, the-field 4096x1216, john 3024x1344, entry 1200x1352,
all-field h264 3686x3290. HLS 200 at `/hls/<name>/index.m3u8`. Audio 10/10
channels, lag 0 s. WHEP POST returns 201 with media on :8189 carrying BOTH the
`stream.tomsawyerlabs.com` host candidate and the STUN srflx candidate.

| Goal | Before | After |
| --- | --- | --- |
| single app | 5 processes | 3 (stitchd, whisper-server, bun) |
| internal stream copies | ~24 | **0** |
| mediamtx roles | 6 | 0 |

## Client verification

VLC confirmed **smooth** by the user on 2026-08-03 after two RTSP bugs were
fixed:

1. **UDP transport refused.** VLC requests plain UDP on SETUP first and only
   falls back to interleaved TCP if refused. mediamtx had been configured
   `rtspTransports:[tcp]` so clients never got the choice; answering 461 made
   VLC fail outright. SETUP now serves both (`4c61cb6`).
2. **RTP clock wrong.** `avformat_write_header` rewrites `st->time_base` to
   1/90000 for the rtp muxer, but packets were still being fed in the encoder's
   time base — consecutive frames landed 1 tick apart instead of 3000, so a
   player's clock collapsed right after the first frame. **ffmpeg tolerates this
   and VLC does not**, which is why every earlier ffmpeg-based test passed while
   VLC showed one frame and died (`d2ecd15`). Packets with no PTS now fall back
   to DTS or are dropped rather than emitting garbage (`137fd89`).

**Testing lesson worth keeping:** ffmpeg re-derives timing and masks broken RTP
timestamps. Validating an RTSP server with ffmpeg alone is not sufficient —
parse the RTP headers, or test with a strict client.
`/tmp/rtpcheck.py` on sentinel captures interleaved RTP and prints frame deltas.

## Own UI — done

The dashboard no longer touches mediamtx. stitchd serves `GET /api/status` on
the port it already runs for WHEP (no second HTTP server), reporting per-output
codec/geometry/drops plus live RTSP and WebRTC sessions. The payload is
deliberately mediamtx-shaped so the existing UI reads a new source without a
rewrite. Verified: `/api/paths` 6 streams, `/api/rtsp` real peers, `/api/webrtc`
viewers, `/api/snapshot/*` real JPEGs, dashboard 200.

## STILL OWED

1. **Off-LAN iOS validation of WebRTC.** The answer SDP carries the mux port,
   the `stream.tomsawyerlabs.com` host candidate and the STUN srflx candidate,
   but no iPhone on cellular has loaded the public field stream since the
   cutover. This is the one externally-visible thing that could still be wrong.
2. **Three unexplained RTP timestamp anomalies per ~160 frames**, roughly +/-1
   hour, consistent across all five H.264 outputs. ffmpeg reports no
   discontinuities, libav logs nothing, and VLC now plays smoothly — so this may
   be benign. Measure in ARRIVAL order with modular arithmetic; sorting is wrong
   for a wrapping 32-bit counter (that mistake produced a false "BAD" verdict
   once already).
3. ~~**`raw/*` per-camera streams are gone.**~~ DONE — stitchd republishes every
   camera verbatim at `raw/<name>` (`3083396`).
4. **The public stream is still down. Caddy fronts `/webrtc/*` and `/all-field`
   with the mediamtx endpoint layout.** A prefix-rewrite patch was staged in the
   ops repo and then found insufficient — see below.

## Public endpoint (`stream.tomsawyerlabs.com`) — BROKEN, fix in progress

The staged ops patch only rewrites paths (`/webrtc/` → `/whep/`, `/all-field` →
`/hls/all-field`). Reviewed against what stitchd and the dashboard actually
serve, that is **not enough** — three separate breaks, all verified by reading
the serving code, none by hitting the box (sentinel was rebooting):

1. **No player page anywhere.** mediamtx served an HTML player at both
   `/all-field` (hls.js) and `/webrtc/all-field`. stitchd's WHEP handler is
   POST-only — `method != "POST"` returns 404 (`compositor/src/webrtc.cpp:267`).
   The dashboard's HLS route calls `Bun.file()` on the path and 404s when it
   isn't a regular file, so a bare directory `/hls/all-field` 404s too
   (`src/dashboard.ts:1073`). Path rewriting alone therefore turns one 404 into
   a different 404 for any browser that loads the page URL.
2. **`header_down Location ^/ /webrtc/` now produces a dead URL.** It was
   written for mediamtx, which emitted `/all-field/whep/session/<id>`. stitchd
   emits `Location: /whep/all-field` (`compositor/src/webrtc.cpp:352`), so the
   rule rewrites it to `/webrtc/whep/all-field` — which does not match
   `@webrtc_authed` (`path /webrtc/all-field*`), falls through to
   `handle /webrtc/*`, and **401s** on the session PATCH/DELETE. Correct rule is
   `header_down Location ^/whep/ /webrtc/`.
3. **`@webrtc_static` (`/webrtc/all-field/reader.js`) is dead weight.** That was
   mediamtx's player library. stitchd has no such asset; the block can go.

Two more mediamtx leftovers found in the same read, not public-facing but
broken: the dashboard builds LAN HLS links against the dead `:8890`
(`src/dashboard.ts:183`) and `/api/hls` still proxies mediamtx's
`/v3/hlsmuxers/list` (`src/dashboard.ts:1160`).

### Chosen fix

Serve our own player pages so the **public URL contract is unchanged** and the
Caddy rules stay path-rewrites only:

- stitchd: `GET /whep/<stream>` returns an embedded HTML WebRTC player (POST
  still does WHEP). The page forwards `location.search` onto its own POST so the
  single `?token=` in the iframe URL covers the whole exchange, exactly as
  mediamtx's page did.
- dashboard: `GET /hls/<name>` (directory, no file) returns an embedded hls.js
  player; `/hls/<name>/index.m3u8` and segments keep working as today.
- Caddy: the staged path rewrites, plus the corrected `Location` rule, minus the
  `reader.js` block.

**Open question blocking the shape of this:** nobody has confirmed what the pFMS
scoreboard actually iframes — the player *page* (`/all-field`) or the playlist
(`/all-field/index.m3u8`) straight into its own player. If it is the playlist,
the HLS player page is unnecessary and the staged rewrite is already enough for
that transport. Check Caddy's access log for `stream.tomsawyerlabs.com` once
sentinel is back up.

### Do not

- Do not push the currently-staged `stream.tomsawyerlabs.com.caddy` as-is. It
  ships breaks 1 and 2 above.
- Do not validate this endpoint with `curl -o /dev/null -w %{http_code}` alone —
  a 200 on `index.m3u8` says nothing about whether a browser can play it, and
  this project has already been burned three times by checks that passed on
  something other than the thing under test (ffmpeg masking broken RTP
  timestamps, `ffprobe` answering from the SDP with zero frames flowing,
  `strings` being absent so deployed code looked missing).

---


## Goal

Make `stitchd` the whole media system: ingest from the NVR, composite on GPU,
extract audio, and serve clients directly — deleting mediamtx and every internal
localhost RTSP hop.

## Why (measured, not assumed)

The `raw/*` fan-out exists almost entirely to serve ourselves. RTSP sessions on
sentinel over a 6 h window:

```
~23,000 sessions from 127.0.0.1   (stitchd, audio pump, snapshotter)
      6 sessions from real LAN clients
```

So today we run a full streaming server, pull 10 cameras into it, then read them
back over localhost to feed processes in the *same container*. stitchd also
publishes its 6 outputs back into that same server over RTSP. Every internal hop
costs a demux/remux and a per-reader queue that can overflow — which is the
direct cause of the still-open "reader is too slow" discards
(see [transcription-audio-path.md](transcription-audio-path.md)).

## Environment / context

- `compositor/` builds `stitchd` via CMake: C++20 + CUDA (sm_89), linking our
  **own static libav\*** from `/opt/ffmpeg` (`libavformat libavcodec libavutil
  libswresample`) plus `CUDA::cudart`. New C++ deps go in the builder image.
- `stitchd` today: `av_find_best_stream(VIDEO)` per input, drops every non-video
  packet (`main.cpp:130`), composites GPU-resident, publishes outputs over RTSP.
- Supervisor is Bun (`src/index.ts`); dashboard (`src/dashboard.ts`, 1076 lines)
  reads mediamtx's control API; `src/transcribe.ts` owns the audio pump and the
  whisper consumer.
- Live config is owned by the **ops** repo, not here.

## What mediamtx actually does (all of it must be replaced)

| Job | Port | Replacement | Difficulty |
| --- | --- | --- | --- |
| NVR ingest, 10 pulls + reconnect | — | `avformat_open_input` per camera | **Easy** — already done for 8 |
| Internal fan-out of `raw/*` | 8554 | in-process buffers | **Easy** — deletes the hop entirely |
| RTSP server | 8554 | RTP/RTSP over TCP interleaved | Moderate |
| HLS | 8890 | libavformat `hls` muxer → disk + HTTP | **Easy** — muxer already linked |
| **WebRTC + UDP mux** | 8889 / 8189 | **libdatachannel** (ICE/DTLS-SRTP/SDP) + WHEP | **Hard** |
| Control API | 9997 | small HTTP server; dashboard reads it | Easy |
| Auth / permissions | — | Caddy already fronts the public path | Easy |

## Decisions already made (don't re-ask)

- **Full replacement is the goal.** User directive, 2026-07-30.
- **Do NOT hand-roll WebRTC.** Use `libdatachannel` (ICE + DTLS-SRTP + SDP,
  BSD-licensed, mature). Hand-rolling DTLS-SRTP is the one way this project
  ends badly.
- **HLS via libavformat's `hls` muxer**, not a hand-written segmenter — we
  already link it statically.
- **Stage it.** Every stage must leave the system fully working and deployable
  on its own. No big-bang cutover.
- Do NOT bother with `-thread_queue_size` on the audio pump — Stage 1 deletes
  that pump entirely.
- **Deploy authority (user, 2026-07-30):** free to build/deploy new stitchd
  binaries and restart the restitch container / streams without asking.
  **Do NOT reboot sentinel** — other work is running on that box in parallel.
  So: `docker restart restitch` and stitchd swaps are fine; anything that
  reboots the host is not, including deploys that could trip the
  NVIDIA-driver reboot path in the ops repo.

## The one genuinely risky piece

WebRTC (Stage 4) carries the **public field stream**: `stream.tomsawyerlabs.com`
→ Cloudflare → office → steamboat → sentinel, gated by `STREAM_WEBRTC_TOKEN` in
Caddy, with media on a **WAN-forwarded UDP 8189**. Three contracts must survive
byte-for-byte or the public stream breaks:

1. UDP mux stays on **8189** (the WAN forward points at exactly this port).
2. `webrtcAdditionalHosts` equivalent — advertise `stream.tomsawyerlabs.com` as
   an ICE candidate (split-horizon DNS).
3. STUN (`stun.l.google.com:19302`) for the numeric-IP srflx candidate that
   Safari/iOS require (WebKit ignores non-mDNS FQDN candidates).

Stage 4 must be validated from an actual off-LAN iPhone before mediamtx is
deleted. Until then mediamtx stays installed and can be re-pointed in one config
change.

## Plan / steps

Ordered so the highest value and lowest risk land first, and so the outstanding
discard bug dies in Stage 1.

1. [ ] **← current. Ingest + audio + `raw/*` ownership, in one step.**
   stitchd opens the 10 NVR URLs directly (video **and** audio) AND becomes the
   source of `raw/*`, so mediamtx stops pulling from the NVR in the same change.
   Decode audio to PCM, resample to 16 kHz mono per camera, hand an N-channel
   interleaved stream to the transcription consumer over a pipe — the exact byte
   format `src/transcribe.ts` already parses, so the Bun side barely changes.
   **Deletes:** 18 internal RTSP sessions, the audio-pump ffmpeg, `amerge`, and
   the "reader is too slow" bug *by construction*.
   mediamtx keeps serving clients; stitchd still publishes to it.

   **These were originally two stages. Merged deliberately:** doing ingest first
   and `raw/*` ownership second leaves an intermediate state where stitchd and
   mediamtx BOTH pull every camera — 20 NVR connections instead of 10. Trading
   18 localhost hops for a doubled load on the NVR is a regression, even
   transiently. The NVR must never see more than one connection per camera.

2. [x] **HLS in stitchd** — DONE (`08ea885` + `9baacdab`). stitchd clones the
       already-encoded packets into an fMP4 HLS muxer (`--hls-dir`); the
       existing Bun dashboard serves them at `/hls/<output>/index.m3u8`. No
       second encode, no second HTTP server. Verified live: all 6 outputs
       segmenting, HTTP 200 with correct MIME types, ffmpeg decodes the
       HTTP-served playlist (exit 0), path traversal rejected (encoded forms
       400, unencoded normalized to 404).
       fMP4 not mpegts because `full` is HEVC. HLS is strictly secondary — an
       HLS failure logs once and leaves RTSP running.

3. [x] **RTSP server in stitchd** — DONE (`da0e008` + `e860487`). Running on
       **8555** alongside mediamtx's 8554, both serving the same encoded
       packets, so clients cut over one at a time instead of in a flag day.
       libavformat's rtp muxer does packetization; one muxer per client; TCP
       interleaved only; a busy client is skipped, never queued behind.
       Verified live: `rtsp://sentinel:8555/entry` reports h264 1200x1352 @30
       and decodes cleanly, as does `the-field`.

4. [~] **WebRTC via libdatachannel** + WHEP. Preserve the three contracts above.
   Validate off-LAN on iOS *before* proceeding.
   - [x] Dependency linked (`26f8dc0`): libdatachannel v0.22.5, static, bundled
         libjuice backend, `media=1`, proven by the self-check.
         **Verified up front that libjuice's `enableIceUdpMux` lets many peers
         share ONE UDP port** — without that the 8189 WAN forward makes this
         approach impossible, so it had to be checked before writing code.
   - [ ] WHEP endpoint + SDP exchange.
   - [ ] H.264 RTP into a peer connection (packetizers exist in libdatachannel).
   - [ ] Pin the UDP mux to 8189, advertise `stream.tomsawyerlabs.com`, STUN.
   - [ ] Off-LAN iOS validation.

5. [ ] **Control API + dashboard cutover, then delete mediamtx.**

## Stage 1 shipped (2026-07-31) + a correction to the stage ordering

Stage 1's audio half is live (`503acda` + `7ab2351`). Verified on the box one
minute after deploy: `attaching to stitchd audio for 10 camera(s)`, **zero**
amerge audio-pump processes, all 10 channels reporting distinct plausible levels
(Bay 1 -31.6 ... Doorbell -56.5 dBFS, which is what proves the interleave order
survives the round trip), lag 0 s / rate 100.0%, all paths ready, readers 24 ->
14.

### The remaining half of Stage 1 does NOT reduce copying — reordered

The plan assumed "stitchd ingests from the NVR directly" was a win on its own.
Counting the sessions says otherwise, because mediamtx still needs `raw/*` for
the dashboard snapshotter and occasional external viewing:

| | NVR | stitchd reads mediamtx | stitchd publishes | total internal |
| --- | --- | --- | --- | --- |
| today (post Stage 1) | 10 (mediamtx) | 10 | 6 | ~20 |
| NVR-direct + republish `raw/*` | 10 (stitchd) | 0 | 6 + 10 | ~20 |

It is a **lateral move**: the 10 reads become 10 publishes. More C++, more risk,
same copy count — and this project exists to reduce copying.

**The copies only actually disappear when mediamtx is deleted**, because the
publish path IS the remaining hop. So ingest should move LAST, together with (or
just before) deleting mediamtx — not first.

Revised order: build the serving side (HLS -> RTSP -> WebRTC), then take ingest
and delete mediamtx in one step. Stage numbering below is unchanged; only the
*ingest* portion of Stage 1 is deferred to sit with Stage 5.

## Findings / gotchas

- stitchd already receives the audio packets it needs — it discards them one
  line after demux. Stage 1 is mostly *stop throwing them away*.
- `blue` and `bullet` are opened by nothing but the audio pump today, so Stage 1
  must add them as inputs (audio-only is fine).
- `writeQueueSize: 65536` in the mediamtx config exists because a 7560x2688 HEVC
  keyframe exceeds 1000 RTP packets; any replacement RTSP/RTP writer needs
  equivalent headroom or large keyframes will be shredded.
- mediamtx's generous `readTimeout/writeTimeout: 5m` exists because the
  compositor takes ~30 s to connect all inputs before producing frames. Any
  replacement server must tolerate a slow first frame.
- The dashboard depends on `/v3/paths/list`, `/v3/rtspsessions/list`,
  `/v3/webrtcsessions/list`, `/v3/hlsmuxers/list`. Stage 5 must supply
  equivalents or the dashboard loses its stream state.

## Things not to do

- Don't hand-roll DTLS-SRTP or ICE.
- Don't delete mediamtx until Stage 4 is validated off-LAN on iOS — the public
  field stream is the one externally-visible thing that can break badly.
- Don't change the UDP mux port from 8189; a WAN forward depends on it.
- Don't do a big-bang cutover. Each stage ships independently.
- Don't evaluate any discard-related change on a restitch process younger than
  ~3 h (standing rule, learned twice — a fresh process always reads clean).

## Progress log

- [x] Scoped: measured internal-vs-external reader split, inventoried every
      mediamtx role, confirmed the build system and its constraints.
- [x] Caught a staging flaw while re-checking against the stated goal: the
      original Stage 1/2 split would have doubled NVR connections in between.
      Merged into one step.
- [x] Stage 1 (audio half) shipped and verified live.
- [x] Stage 2 (HLS) shipped and verified live.
- [x] Stage 3 (RTSP) shipped and verified live on 8555.
- [ ] Stage 4: WebRTC (the hard one — carries the public field stream).

## Cutover still owed (Stages 2-3 run in parallel with mediamtx today)

HLS and RTSP are currently served by BOTH stitchd and mediamtx. That is
deliberate — it makes cutover incremental — but it is duplicated work until
consumers are repointed:

| Consumer | today | after cutover |
| --- | --- | --- |
| VLC / Home Assistant | `rtsp://sentinel:8554/<name>` | `:8555` |
| pFMS scoreboard (HLS) | mediamtx `:8890` | dashboard `/hls/<name>/index.m3u8` |

Repointing is an ops-repo config change, not a restitch one.

## Gotcha for the discard verification

The standing "never judge on a process younger than ~3 h" rule collides with
active development: **every deploy restarts restitch and resets that clock.**
Stage 1's structural fix (the discarding reader no longer exists) has therefore
never had an uninterrupted 3 h window. To actually confirm it, stop deploying
and leave the box alone for ~4 h, then check:

```bash
ssh sentinel 'docker inspect restitch --format "{{.State.StartedAt}}";   docker logs restitch --since 30m 2>&1 | grep -c "reader is too slow"'
```

## Stream-copy accounting (the actual scoreboard)

Persistent internal sessions carrying media between processes in the same
container. This is what "minimize stream copying" means concretely:

| State | NVR pulls | internal localhost RTSP | separate processes |
| --- | --- | --- | --- |
| today | 10 | ~24 (8 video + 10 audio + 6 publish) + snapshotter | mediamtx, stitchd, audio ffmpeg, whisper, Bun |
| after Stage 1 | 10 | 6 (publish only) | mediamtx, stitchd, whisper, Bun |
| after Stage 2 (HLS) | 10 | 6 | same |
| after Stage 3 (RTSP) | 10 | 6 | same |
| after Stage 4 (WebRTC) | 10 | 6 | same |
| after Stage 5 (delete mediamtx) | 10 | **0** | stitchd, whisper, Bun |

Stage 1 removes ~75% of the copying. The last 6 hops only disappear when
mediamtx is actually deleted, because publishing to it IS the remaining hop.
