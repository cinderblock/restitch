# stitchd never reconnects a dead input — 2026-08-10

## Goal

An input that drops is dead until the process is restarted, and the composite
silently keeps painting its last frame. Make a dropped input reconnect, and
make a stale input visible instead of silent.

## The incident

User reported "the top half of /entry looks wedged". `entry` is a vertical
stack of **Doorbell** (top, cropped) over **Foyer** (bottom).

Attribution, in order:

1. `entry` composite: bottom half's OSD read 14:24:08 at a 14:24:10 capture —
   live. The Doorbell's own OSD is cropped away by
   `crop: {x:0, y:462, w:1200, h:676}`, so it can't be read from the composite.
2. Comparing two grabs 6 s apart was **inconclusive** — a frozen source that is
   re-encoded still yields different pixels (different QP per frame), so md5
   inequality does not prove liveness. Don't use that test.
3. `rtsp://localhost:8554/raw/doorbell` (stitchd's verbatim republish):
   **30 s timeout, "Output file does not contain any stream"** — stitchd was
   serving no doorbell video at all.
4. `rtsp://10.255.0.2:7447/GLb91oJSNXjzpOcF` (same camera, direct from the
   NVR): grabbed a valid frame in ~1 s. **The camera was fine the whole time.**
5. The audio mixer had been saying so for a while:
   `underruns: ... raw/doorbell=919300ms` against <2000 ms for every other
   input — ~15 min of starvation on a 175 min uptime.

## Root cause

`Decoder::loop()` in `compositor/src/main.cpp`:

```cpp
while (running_ && !g_stop) {
  int err = av_read_frame(fmt_, pkt);
  if (err < 0) break;      // <-- thread exits, permanently
  ...
}
```

`grep -ci 'reconnect|reopen|retry' compositor/src/main.cpp` → **0**. There is no
reconnection anywhere.

The 10 s socket timeout set in `Decoder::open()` is deliberate — it exists so a
wedged input errors out of `av_read_frame` instead of hanging the thread. But
nothing acts on that error: the thread just ends. `latest()` keeps handing the
compositor the last decoded frame forever, so the output looks *healthy* while
one region is frozen. Any transient (camera reboot, NVR hiccup, brief network
loss) kills that input for the lifetime of the process.

Pre-existing; unrelated to the reverted RTSP latency work
(`plans/stream-latency-2026-08.md`).

## Immediate action taken

`docker restart restitch` — 6 outputs ready, 0 drops, `raw/doorbell` returns a
valid frame again, and `entry`'s top half is live (parking lot contents visibly
changed from the frozen capture).

## Proposed fix

1. **Reconnect with backoff.** On `av_read_frame` error, tear down the input's
   format/codec context and reopen the URL, with capped exponential backoff
   (~1 s → ~30 s). Log every disconnect and every recovery — never silent.
2. **Track frame age per input.** Record when each Decoder last published. This
   is what makes a stale input detectable at all.
3. **Surface it.** Add per-input `lastFrameAge` to `/api/status` so the
   dashboard and the watchdog can see a frozen region, rather than a human
   noticing a wedged half hours later.

Deliberately NOT in scope: changing what the compositor paints for a stale
input (black? last frame?). Freezing is arguably right; being unable to *tell*
is the actual bug.

## Validation plan

Learned from the latency work (`plans/stream-latency-2026-08.md`): test on a
side instance, and make the healthy case part of every test.

- Run a second stitchd on its own ports; production untouched.
- Point one input at a **local synthetic RTSP source we can kill**, not a real
  camera, so disconnects are reproducible on demand.
- Cases: kill the source and confirm reconnect on restore; kill it for minutes
  and confirm backoff doesn't spin; confirm the other inputs and all outputs
  keep running with 0 encoder drops throughout; confirm no reconnect churn
  during a fully healthy run.
- Soak before deploying.

## Progress log

- [x] Attributed the freeze to a dead stitchd input, camera proven healthy.
- [x] Found the root cause and confirmed no reconnect logic exists.
- [x] Restored service by restarting the container.
- [x] Implemented reconnect + frame-age tracking + status exposure (`67875de`).
      Capped backoff 1 s → 30 s, sliced so `stop()` still joins promptly.
      `Tap::rebind()` avoids leaking the audio decoder on every retry.
- [x] Validated on the side instance (`plans/tmp-side-instance.sh`): input
      killed → logged, siblings kept running at 0 drops, output kept encoding;
      source restored → age 62695 ms → 15 ms, reconnects 0 → 1; 5 retries over
      ~50 s of downtime; clean stop in 305 ms while parked in backoff.
- [x] Deployed. Production reports all 10 inputs healthy with ages in ms.
- [x] Flagged audio-only inputs `"video": false` — `raw/blue` and `raw/bullet`
      never publish a video frame, so they read as permanently stale otherwise
      and would poison any staleness alert with false positives.
- [ ] Optional follow-up: have the supervisor's watchdog alert on a video
      input whose `ageMs` exceeds a threshold. The data is now exposed; nothing
      consumes it yet, so a freeze is *visible* but still not *announced*.

## Things not to do

- Don't use "md5 of two grabs differs" as a liveness test on a re-encoded
  stream — it proves nothing. Compare `raw/<input>` against the NVR instead.
- Don't assume a healthy-looking composite means healthy inputs; a dead input
  is invisible in the output.
