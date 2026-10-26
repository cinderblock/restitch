# Full-size JPEG still export (for the practice-field scheduler's issue reports)

## Goal

Let another service fetch a fresh, full-resolution JPEG of any stream's newest frame over
HTTP, so the practice-field scheduler can attach a picture of the field (`all-field`) to a
field issue report the moment it is filed. Until now the only still was the dashboard's
hover thumbnail: 320 px wide, cached for about a minute, compressed hard.

Asked for by the user on 2026-10-26 ("We can add jpeg still export to restitch…"), after the
scheduler's first version pointed at a single UniFi camera in Home Assistant and the
composite was what was wanted.

## Environment / context

- Worktree `C:/Users/camer/git/restitch-still-export`, branch `field-still-export`, cut from
  `origin/master` at `1a44a46` on 2026-10-26. The main checkout at `C:/Users/camer/git/restitch`
  sits on `webrtc-ice-servers` and was 111 commits behind origin; left alone.
- The still is produced by `stitchd` (C++/CUDA, `compositor/`), which already holds every
  frame on the GPU and already answers `GET /api/snapshot/<name>` on its WebRTC HTTP port with
  a 320 px thumbnail (`encode_snapshot_jpeg` in `compositor/src/main.cpp`, the route in
  `compositor/src/webrtc.cpp`). The bun supervisor's dashboard (`src/dashboard.ts`, port 9000) proxies and caches those thumbnails for its hover previews.
- `all-field` is 3686×3290; a full frame is ~18 MB of planes back over PCIe and a real MJPEG
  encode, still well inside a frame interval and only on request.
- Compiling stitchd happens on sentinel in a container (`compositor/README.md`). The
  `stitchd-dev:latest` image there predates libdatachannel/OpenSSL and no longer configures;
  `stitchd-build:test` has everything (`/opt/libdatachannel`, `libssl-dev`, `/opt/ffmpeg`).
  Source was synced to `/tmp/stitchd-src-still-export`; a failed first configure left
  root-owned files in `build/`, so the good build is in `build-ok/`.

## Decisions already made (don't re-ask)

1. **One stitchd route, a `width` query.** `GET /api/snapshot/<name>` stays the thumbnail
   when called bare (the dashboard's prewarm and hover are untouched). `?width=<px>` picks a
   width (16–16384, clamped), `?width=full` is the frame as composed. Fewer moving parts than
   a second route in stitchd.
2. **The dashboard grows `GET /api/still/<name>[?width=<px>]`** on port 9000, which is the
   LAN-facing documented entrypoint. It proxies to stitchd with `width=full` (or the given
   width), never caches (`Cache-Control: no-store`), and coalesces identical in-flight
   requests per path+width so a burst costs one encode. The thumbnail route keeps its cache.
3. **Quality follows size.** The MJPEG `qscale` is 6 at thumbnail widths (≤640 px, as
   before) and 3 for anything larger or full-size: a still is kept as a record of what the
   field looked like.
4. **The downscale kernel is reused as-is.** It is a box filter; at 1:1 each destination
   pixel covers exactly one source pixel, so "full" is simply `target_w = source width`.
5. **No auth on the route.** The dashboard is LAN-only, like every other port on this box;
   the scheduler reaches it over the LAN as `http://sentinel.tsl:9000/api/still/all-field`.

## Plan / steps

1. [x] Read stitchd's snapshot path and the dashboard's proxy.
2. [x] `compositor/src/webrtc.h` / `webrtc.cpp`: provider takes `(name, width)`; route parses
       `?width=`.
3. [x] `compositor/src/main.cpp`: `encode_snapshot_jpeg(frame, target_w, qscale)`, 0 = full;
       provider passes the width and picks the quality.
4. [x] `src/dashboard.ts`: `grabStill` + `/api/still/<path>` route.
5. [x] `README.md`: the two URLs documented.
6. [x] `bun run check` (supervisor typecheck) clean; stitchd compiled clean on sentinel in
       `stitchd-build:test` (`[100%] Built target stitchd`, 2026-10-26 ~5:49 PM PDT).
7. [x] Pushed: `master` fast-forwarded to `f86818a` on 2026-10-26 at 12:28 PM PDT (19:28Z);
       CI run 40386990134 built it in about 5 minutes (registry cache held). Pinned in ops
       `8536ed7` (digest `sha256:23fea754…`), deploy run 40387918002 green, live on sentinel
       by 12:50 PM PDT (19:50Z). Verified from this machine:
       `/api/still/all-field` → 200, 3686×3290, 2.3 MB, 0.13 s, `cache-control: no-store`;
       `?width=800` → 800×714, 166 KB; bare `/api/snapshot/all-field` still 320×286 with
       `no-cache`, so the dashboard hovers are untouched. The picture is the composite.
8. [ ] Scheduler compose: `FIELD_CAMERAS: Field=http://sentinel.tsl:9000/api/still/all-field`
       is written, uncommitted, in the ops worktree `C:/Users/camer/git/ops-restitch-pin`
       (branch `restitch-pin-f86818a` off `origin/master`); waits on the user's per-change yes.
       It only does something once a scheduler build with the feature (`d4f848f` or later)
       is pushed and pinned in `servers/steamboat/stacks/practice-field-scheduler/pin.json`.

## Findings / gotchas

- stitchd's request parser only strips the query from the path for matching; the query
  itself was never read before. `width=` is matched at the start of the query or after `&`,
  so `?w=…` or `?fullwidth=…` is ignored rather than misread.
- The existing dashboard thumbnail cache keys on path alone; the still path is deliberately
  a separate map so a full-size fetch never lands in (or is served from) the thumbnail cache.
- The CI image build is what proves the C++ end to end on the real toolchain; the sentinel
  dev-container compile is the fastest pre-push check and matched the Dockerfile's
  `compositor-builder` stage (same `/opt/ffmpeg`, same libdatachannel prefix).
- Not exercised at runtime yet: that needs the GPU and the camera config, i.e. a deploy.
- The ops checkout at `C:/Users/camer/git/Personal Projects/ops` is a shared tree: another
  thread's unpushed commit, 22 behind origin, edits in flight. The pin commit is made in a
  separate worktree off `origin/master` and pushed as `HEAD:master` (a fast-forward), so
  nothing in that tree is rebased or touched.
- steamboat resolves `sentinel.tsl` (10.255.0.20) and gets the thumbnail route at 200; its
  containers use Docker's embedded DNS, which forwards to the same UniFi resolvers
  (10.0.100.1, 10.255.0.1, 10.55.0.1), so the scheduler container should reach it too.
  Not proven from inside the container (no docker-group access over ssh); the first filed
  report proves it.

## Progress log

- [x] 2026-10-26: patch written, supervisor typecheck clean, stitchd compiled on sentinel,
      committed on `field-still-export`.
- [x] 2026-10-26 12:28–12:50 PM PDT (19:28–19:50Z): pushed, built, pinned (ops `8536ed7`),
      verified live. Branch `field-still-export` also pushed, for the record.

## Open questions for the user

1. ~~Push `field-still-export` and merge to `master`?~~ Both answered "ok" on 2026-10-26:
   pushed, and the pin is authorized.

## Things not to do

- Don't change the bare `/api/snapshot/<name>` behaviour; the dashboard's prewarm loop calls
  it for every ready path every minute and expects a small picture.
- Don't run the freshly built `stitchd` binary against the live cameras on sentinel to test;
  it would fight the running restitch for its ports and the NVENC sessions.
- Don't touch the main `restitch` checkout's branch (`webrtc-ice-servers`); it isn't ours.
