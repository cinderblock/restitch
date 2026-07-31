# Absorb mediamtx into stitchd

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

2. [ ] **HLS in stitchd** (libavformat `hls` muxer → disk, HTTP serves it).

3. [ ] **RTSP server in stitchd.** VLC / Home Assistant talk to stitchd directly.

4. [ ] **WebRTC via libdatachannel** + WHEP. Preserve the three contracts above.
   Validate off-LAN on iOS *before* proceeding.

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
- [ ] Stage 1.

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
