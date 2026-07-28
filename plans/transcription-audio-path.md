# Transcription audio path: fix the reader-too-slow regression, then simplify

## Goal

Stop mediamtx discarding audio frames for the transcription pump ("reader is
too slow"), which jumped ~7× on 2026-07-28, and decide whether the audio path
belongs inside stitchd rather than in a second ffmpeg.

## Environment / context

- restitch repo (this one). Deployed to sentinel; live config is owned by the
  **ops** repo at `servers/sentinel/restitch/config.yaml`.
- Video: `stitchd` (compositor/, C++/CUDA) reads 8 of the 10 `raw/*` paths
  (5 `comp-in` + 3 `aux`).
- Audio: `src/transcribe.ts` launches **one ffmpeg with N RTSP inputs**
  (`-allowed_media_types audio`) → `amerge` → N-channel s16le → piped to a Bun
  consumer doing max-mix + per-channel RMS + silence detection + whisper.
- mediamtx is the fan-out point. **The NVR is read once per camera** — verified:
  exactly 10 TCP connections to `10.255.0.2:7447`, one per camera.

## The regression (2026-07-28)

Adding the `bullet` camera took the audio pump from 9 → 10 inputs. Discards, per
UTC hour, from sentinel's own logs:

```
07-27 13..23  ~1,100/hr    ← chronic baseline (already non-zero!)
07-28 00:32   restitch restart, bullet added (9 → 10)
07-28 01      4,512
07-28 02      7,563
07-28 05      7,110        ← ~7×, sustained
```

## Findings / gotchas

**Ruled out — do not re-investigate:**

- _"bullet has no audio track"_ — false. `raw/bullet` carries the same
  `MPEG-4 Audio + Opus` pair as every other camera (mediamtx `/v3/paths/list`).
- _"bullet's audio lags / different format"_ — false. Identical codecs, sample
  rate, and packet rate (125 packets per 8 s, same as `bay-1` and `blue`).
- _"whisper load / amplified noise is driving it"_ — false, and this was the
  most useful negative. Whisper inference went to **exactly zero** after 03:50
  UTC (quiet shop overnight) while discards **continued at ~7,000/hr**. The two
  are fully decoupled. Silence detection appears to be working correctly:
  ~13 inferences/min during the day, zero overnight.
- _Video is unaffected_ — stitchd logged `0 drops` on all 5,033 heartbeats.
  This is an audio/transcription-only problem.

**Prime suspect — `appendMono()` in `src/transcribe.ts` is O(n) per chunk:**

```js
const merged = new Uint8Array(monoBuffer.length + bytes.length);
merged.set(monoBuffer, 0);        // full copy of the whole rolling buffer
merged.set(bytes, monoBuffer.length);
monoBuffer = merged;
...
monoBuffer = monoBuffer.slice(trim);   // ANOTHER full copy
```

`KEEP_BYTES = (silence_min_seconds + max_segment_seconds + 2) * 16000 * 2`
= `(0.8 + 20 + 2) * 32000` ≈ **730 KB**. So every `appendMono` does ~1.46 MB of
memcpy **and** allocates ~730 KB. It is called at least once per stdout chunk
_and_ once per completed RMS window (every 100 ms → ≥10×/s). That is tens of
MB/s of pure allocation churn feeding the GC — independent of whisper, which
explains why discards continue while whisper is idle.

**Why +1 camera caused a 7× jump (queueing, not linearity):** ~~going 9 → 10 adds
only ~11% input bytes, so an 11% load increase can only cause a 7× effect if the
consumer was already near saturation.~~ **REFUTED 2026-07-27 23:33 PDT — see
below.**

### CORRECTION: it is not a camera-count capacity limit

After sentinel rebooted (the ops timezone change), measured with the **same 10
cameras** still in the pump:

| Measurement | Result |
| --- | --- |
| discards in a 60 s window | **0** (~0/hr, vs ~7,000/hr before) |
| Bun consumer (`src/index.ts`) CPU | **11.4%** of one core |
| stitchd CPU | 9.6% |
| pump input count | still `combined pump for 10 camera(s)` |

So both earlier explanations are wrong:

- **Not a saturation cliff at 10 inputs.** A fresh process handles 10 cameras
  with zero discards. Camera count is not the causal variable.
- **Not `appendMono` throughput.** The consumer sits at ~11% of a single core;
  it is nowhere near CPU-bound. (The O(n) copy is still real and worth fixing on
  its own merits — ~1.46 MB of memcpy and ~730 KB of allocation per call, ≥10×/s
  — but it is not what filled the queues. A GC-pause mechanism is still
  conceivable, since average CPU can be low while individual pauses stall the
  pipe read, but nothing measured yet supports it.)

**What the evidence now says:** the discards came from a *degraded runtime state*
that a restart cleared — not from steady-state capacity. The 00:32 restart
correlation was real but misleading: that restart is when the affected process
began, not proof that the 10th camera caused it.

**Still unexplained (the actual open question):** what accumulates? The old
process ran ~6 days at ~1,100 discards/hr and the post-00:32 process reached
~7,000/hr within an hour, which does not fit simple monotonic degradation.
Candidates not yet tested: mediamtx per-reader queue state, an ffmpeg
`aresample=async=1` drift correction that compounds, or clock/PTS drift between
the 10 inputs pulling `amerge` progressively further out of lockstep.

**This must be watched, not declared fixed.** The box was rebooted ~23:32 PDT
2026-07-27; if discards climb back over the following hours with 10 cameras, the
degradation is real and time/drift-based. If they stay at zero, something about
the pre-reboot environment (older restitch process, pre-timezone-change clock)
was the trigger.

**Architecture note (for step 3):** stitchd already demuxes these exact
containers and **throws the audio away**:

```cpp
stream_ = av_find_best_stream(fmt_, AVMEDIA_TYPE_VIDEO, ...);
if (pkt->stream_index != stream_) { av_packet_unref(pkt); continue; }  // audio dropped
```

So "add audio to stitchd" is mostly _stop discarding what's already in hand_.
Caveat: stitchd opens only 8 of 10 paths; `blue` and `bullet` are read solely by
the audio pump, so they'd need audio-only inputs.

## Decisions already made (don't re-ask)

- The NVR is **not** double-read; only mediamtx is consumed twice, and the audio
  reader gets audio tracks only. Duplication is localhost + audio-only = cheap.
  This is NOT the performance problem.
- Fix in evidence order: relief → measurement → real fix. Do not write the
  stitchd audio feature before the measurement, because the measurement may show
  the bottleneck is the Bun consumer, which moving the merge would not fix.

## Plan / steps

1. [x] Per-camera `transcribe: false` (mirrors existing `composite: false`).
       **Shipped as a capability, deliberately NOT applied to `bullet`** — with
       10 cameras now running at zero discards, excluding one would be treating
       a symptom that currently isn't present, and would destroy the natural A/B
       if the problem returns.
2. [x] Measured. Consumer is **not** CPU-bound (11.4%); discards are **0/hr**
       post-reboot with the same 10 inputs. Both prior hypotheses refuted.
3. [ ] **← current** Watch for recurrence over the next several hours/days.
       This is now the deciding experiment: recurrence ⇒ time/drift-based
       degradation (chase `amerge`/PTS drift); no recurrence ⇒ the trigger was
       something in the pre-reboot process state.
4. [ ] Audio-in-stitchd: **downgrade from "fix" to "architectural cleanup".**
       The measurement removed the performance justification — the audio path is
       not saturated. Still attractive (stitchd already demuxes and discards
       these audio packets; it would delete 10 RTSP sessions and the second
       ffmpeg), but it is no longer urgent and must not be sold as a fix.
5. [ ] Optional, on its own merits: replace `appendMono`'s grow-and-copy with a
       fixed-size ring buffer. Not the bottleneck, but it is a genuine O(n)
       -per-chunk wart with real allocation churn.

## Things not to do

- Don't "fix" this by disabling transcription wholesale — silence detection is
  working; the plumbing is what's broken.
- Don't assume the stitchd audio feature fixes the discards until step 2 says
  the bottleneck is upstream of the Bun consumer.
- Don't tune `silence_threshold_db` for this — discards are decoupled from
  whisper activity (proven above).

## Recurrence watch (step 3, in flight)

A sampler is running on sentinel: `/tmp/discard-watch.sh` → `/tmp/discard-watch.csv`,
one row per 10 min for 24 h (`timestamp, uptime_s, discards_per_10min, bun_cpu`).
Started 2026-07-28 ~06:45 UTC, right after the `aa27470` deploy (restitch
restarted 06:40:49 UTC, pump back to 10 cameras, discards 0/60 s).

Read it with: `ssh sentinel 'column -s, -t /tmp/discard-watch.csv'`

**Interpretation:**

- `discards_per_10min` climbing with `uptime_s` ⇒ time/drift-based degradation.
  Chase `amerge`/PTS drift across the 10 inputs, or mediamtx per-reader queue
  state. Camera count would be an aggravator, not the cause.
- Stays ~0 ⇒ the trigger was specific to the pre-reboot process/environment
  (older restitch build, pre-timezone-change clock). Close it out and leave
  `transcribe: false` as an unused knob.

**Limitation, deliberate:** it lives in `/tmp` and does not survive a reboot —
and unattended-upgrades may now reboot at 02:00 local. That is acceptable for a
24 h diagnostic (a partial series still answers the question), but if it comes
back empty, check for a reboot before concluding anything. Do not promote this
to a service; if a permanent signal is wanted, the right home is the `/health`
probe or the uptime worker, not a `nohup` in `/tmp`.

## Progress log

- [x] Root-caused the regression window to the 9→10 pump change.
- [x] Disproved bullet-specific, whisper-load, and noise hypotheses with data.
- [x] Confirmed NVR is read once per camera (10 connections).
- [x] Identified `appendMono` O(n)-per-chunk copy as prime suspect.
- [x] Step 1: per-camera transcribe opt-out shipped (`aa27470`), deliberately
      not applied to any camera.
- [x] Step 2: measured. Consumer not CPU-bound (11.4%); 0 discards post-reboot
      with the same 10 cameras. Both hypotheses refuted.
- [ ] Step 3: recurrence watch running on sentinel (24 h sampler) — this is the
      deciding experiment.
- [ ] Step 4: stitchd audio — downgraded to architectural cleanup, deferred
      until step 3 reports.
