# sentinel: restitch OOM-killed, then crash-looping (2026-10-02)

## Goal

restitch on sentinel went down at 02:02 PDT on 2026-10-02 and never came back.
Find out why, get it running again, and fix the causes so neither half of the
failure can recur.

## Environment / context

- Host: `sentinel` (ssh alias works from Noook), Ubuntu, kernel 7.0.0-34, 122 GiB
  RAM, RTX 4090, driver 595.91.07 (healthy — this was NOT the NVIDIA mismatch).
- Container `restitch`, `restart: unless-stopped`, host networking. Image pinned
  by ops: `servers/sentinel/stacks/restitch/pin.json` in `cinderblock/ops`
  (checkout: `~/git/Personal Projects/ops`). Pin at the time of the incident:
  `sha256:692c37de…` = restitch commit `1e43792`.
- restitch CI (`.github/workflows/build.yml`) only BUILDS an image. What runs is
  decided by the ops pin + config (`servers/sentinel/stacks/restitch/config.yaml`),
  applied by the ops "Server Deploys" workflow on push to ops `master`.
- Bun in the image: 1.3.0 (`ARG BUN_VERSION` in `containers/restitch/Dockerfile`).
- Host keeps `sar` history in `/var/log/sysstat/` (about 9 days) — this is what
  dated the leak.

## What happened (timeline, PDT)

1. **Sep 29 11:02** — the supervisor (bun) silently stopped consuming stitchd's
   PCM stdout. Last `[combined]` transcript 11:02:12; the 5-minutely
   `[combined] pump:` line never printed again. No error in the log.
   stitchd kept writing (its `mixer:` line continued), and bun kept buffering
   what nothing was reading: host memory rose ~1.13 GB/h from that minute
   (`sar -r`), which is the PCM rate (16 kHz x 2 bytes x 10 channels = 320 KB/s).
2. **Sep 30 14:19** — unrelated: the `bullet` camera started timing out, and by
   14:21 the NVR stopped serving its RTSP path at all. stitchd handled that
   correctly at runtime (retry every 30–40 s, everything else kept streaming).
3. **Oct 2 02:02:04** — global OOM. Kernel killed `bun` at 122.6 GB anon RSS
   (container peak 117.5 G + 7.7 G swap). Docker restarted the container.
4. **Oct 2 02:02:30 onward** — every start died in `probeAllCameras`:
   `could not probe camera "bullet" — no video stream at its URL`. ~23 s per
   attempt, 1,895 restarts by 13:00. Nothing was serving for ~11 hours.

The same leak happened in the previous run too: pump lines stop Sep 24 09:31 at
uptime 6730 min and `sar` shows the same climb; the 02:00 reboot on Sep 25
cleared it before it reached OOM. This run stopped at uptime 6300 min. So it is
roughly every 4.5 days of uptime, not a one-off.

## Root causes

- **A. Unbounded buffering of stitchd stdout in bun** once the JS read loop in
  `src/process.ts` stops. The loop's `catch {}` swallows whatever ended it, so
  the cause of the stop itself is not in the log. See "Open questions".
- **B. Startup probe is fatal for a camera whose geometry nobody needs.**
  `bullet` is `composite: false` and not in any extra composite; its probe
  result is never read by `buildStitchdConfig`. An offline restream-only camera
  should cost a warning, not the whole service.
- **C. (latent) An audio-only/raw input that fails its FIRST open is deleted**
  (`main.cpp`, "audio-only input … open failed — channel silent") and never
  retried, so even with B fixed, `raw/bullet` would not come back when the
  camera does until stitchd is next restarted.
- **D. (ops) The container has no memory limit**, so a leak in restitch becomes
  a global OOM on a box shared with another tenant (`ball-counter`).

## Decisions already made (don't re-ask)

- **"Cameras being down shouldn't bring down the whole thing, nor should we run
  out of memory. Fix it."** (user, 2026-10-02). This is the bar: no camera, of
  any role, may be a startup dependency of the service.
- Ops change approved and applied: pin `e736da4` + `mem_limit: 8g` /
  `memswap_limit: 8g` on the restitch stack (ops `f508de7`).
- Standing rules that apply: ops changes need a per-change yes; no dead
  fallback paths; GPU-or-error stays.

## Plan / steps

1. [x] Diagnose (above).
2. [x] Fix A (leak): `ba9e7e1`. Read loop logs and survives consumer errors; a
       stream that ends while the child lives is cancelled and the child
       replaced; watchdog restarts stitchd when its stdout goes unread for 60 s;
       whisper requests time out (120 s) and are capped (8 in flight).
3. [x] Fix B (probe): `e736da4`. Only layout cameras are probed.
4. [x] Restore service: ops `f508de7`, deployed 13:23 PDT. Verified: 6 outputs +
       9 raw streams advancing, bullet "channel silent"/"skipped", 549 MiB of
       8 GiB, pump attached.
5. [ ] **(current)** Tier 2 — layout cameras may be down at startup too:
   - stitchd: every input opens on its own thread and retries forever; nothing
     about an input is fatal. Composite members that have no frame paint black
     (the vstack kernel already does this for a null plane); aux pieces need the
     same in the crop/scale kernel. Cold start waits a bounded 10 s, not forever.
     `raw/<name>` registers with the RTSP server on the input's first successful
     open instead of only at startup (this is fix C).
   - supervisor: a composite member that will not probe takes a sibling's
     geometry (the kernel requires identical inputs, so this is the invariant,
     not a guess). An extra-composite camera that will not probe has no
     geometry to borrow: its outputs are left out, it is re-probed every 30 s,
     and stitchd is restarted with the full config once it answers.
6. [ ] Test Tier 2 on a GPU before pinning (side instance on sentinel, own
       ports, one dead input that later comes alive).
7. [ ] Ops pin for Tier 2 — needs the user's yes.
8. [ ] Watch the next ~week of uptime for the read-loop log line that names the
       original trigger (see open question 1).

## Findings / gotchas

- `docker events` was useless (the restart loop flushed its buffer); the kernel
  journal had the OOM record: `journalctl -k | grep -E "Out of memory|oom-kill"`.
- UniFi answers a DESCRIBE for a healthy path (Doorbell) and returns nothing at
  all for bullet's path — the NVR is not serving that stream; this is camera /
  Protect side, not restitch.
- **Leak mechanism, measured** in a throwaway container from the deployed image
  (Bun 1.3.0): once the JS loop stops calling `read()`, RSS grows at exactly the
  writer's rate. `reader.cancel()` stops it (the writer gets ECONNRESET);
  dropping references and forcing GC does not shrink RSS but does stop growth
  once the child is dead.
- **What stopped the loop is still unknown.** The old `catch {}` ate it. Both
  occurrences were at 4.4-4.7 days of uptime, mid-morning, seconds to minutes
  after a transcript. Nothing in `onStdout` can obviously throw. Candidates: a
  Bun stream bug (read() never resolving), or an exception we have not spotted.
  The new code logs either case and recovers from both.
- sentinel cannot `docker pull ghcr.io/cinderblock/restitch` as `cameron`
  ("denied") — only the ops deploy can. So a new image cannot be smoke-tested
  on the box before it is pinned; test stitchd by building from source in the
  old `stitchd-build:test` image there instead (see `plans/tmp-side-instance.sh`).
- The ops working tree is shared and had a deletion ALREADY STAGED by another
  thread; a plain `git commit` after `git add <my files>` swept it into
  `f508de7`. Restored in ops `cc67b44` and the deletion re-staged as it was.
  In a shared tree commit with an explicit pathspec: `git commit -- <paths>`.
- `raw/field-centered` drops with EOF and reconnects about every 90 s, all day.
  Separate issue, not part of this incident.
- Container log lines sometimes carry fragments of whisper-server's stdout
  ("Succ[combined] pump: ...") — it inherits stdout and writes without newlines.
- stitchd prints full camera URLs (bearer tokens) in a few log lines
  ("raw/x: no open input for <url>", "open <url>: ..."). Fixed as part of Tier 2
  where those lines are rewritten.

## Progress log

- [x] Root-caused the outage (OOM from a stalled stdout reader + fatal probe).
- [x] Leak fix + probe fix shipped and deployed; service verified up.
- [x] Container memory cap in ops.
- [ ] Tier 2 (layout cameras offline at startup; raw streams return unaided).
- [ ] Tier 2 pinned in ops.

## Open questions for the user

1. The original trigger of the read-loop stop is unidentified. Fine to leave it
   to the new logging (it recovers in <= 60 s either way), or do you want the
   image's Bun bumped from 1.3.0 as well? Recommendation: leave Bun alone until
   the log names the cause.
2. Is `bullet` physically unplugged / removed in Protect? Gone since Sep 30 14:19.

## Things not to do

- Don't blame the NVIDIA driver for this one; `nvidia-smi` was fine throughout.
- Don't "fix" B by defaulting a missing probe to 2560x1440 — a silent default
  for a camera that DOES size a layout is exactly what the fatal error exists
  to prevent. Only cameras with no layout role may be skipped.
- Don't hand-edit anything on sentinel; restore goes through the ops repo.
