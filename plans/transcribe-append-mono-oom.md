# Transcription consumer OOM loop filled sentinel's disk (2026-11)

## Goal

Stop the PCM consumer's `RangeError: Out of memory` loop, make the mono buffer
fixed-size, and make a repeat consumer failure log once and recover (or exit)
instead of logging a stack trace per chunk forever.

## What happened

- Image `sha256:c18b33c5…` (restitch `7b11638`, Bun 1.3.0) on sentinel.
- From 2026-11-18 2:05 PM PST (22:05Z) to a manual restart on 2026-11-26
  2:01 AM PST (10:01Z), every PCM chunk threw `RangeError: Out of memory` at
  `appendMono` (transcribe.ts:349, `new Uint8Array(monoBuffer.length +
  bytes.length)`). `process.ts` caught it per chunk and logged the full trace:
  a 79 GB json-file log and 97% disk. Restart count 0, so the process never
  died. The original log lines are gone (truncated).

## Findings

- **`monoBuffer` did not grow without bound.** `appendMono` trimmed it to
  `KEEP_BYTES` (`(silence_min + max_segment + 2) s`, 730 KB at sentinel's
  defaults; sentinel's config sets no transcription keys) once it passed
  `KEEP_BYTES + 16000`. So the failing allocation was always about 730 KB.
- **What it did was churn.** Each call allocated and copied the whole 730 KB
  buffer, plus a second 730 KB `slice` on each trim. It was called once per
  100 ms RMS window and once per chunk: roughly 47 GB of large-ArrayBuffer
  allocation per hour of 10-channel audio (64 KB pipe reads), for the life of the process. Measured locally
  on 1 h of 10-channel audio (Bun 1.4.4, Windows): old consumer 16.5 s,
  new 2.9 s; peak RSS 95 MiB vs 58 MiB over the short run.
- Why Bun 1.3.0 eventually refused a 730 KB allocation after days of this
  (heap or allocator exhaustion versus fragmentation) could not be
  reproduced: the failure took days of uptime and the logs are gone. Since
  every failed chunk retried the same 730 KB allocation against the same
  state, nothing could recover in-process. The fix removes the allocation
  rather than tuning around it.
- `plans/transcription-audio-path.md` had already flagged this O(n)-per-append
  copy (step 5) as "not the bottleneck". It was not the cause of that
  regression, but it was what failed here.

## Decisions

- Fixed ring (`MonoRing`) sized to the longest segment the state machine can
  request: `MAX_SEG + SILENCE_MIN + 2·PAD + 2·window + 1 s` (22.4 s,
  700 KiB). Overwriting the oldest audio is the policy. A segment that reaches
  past the ring anyway is dropped with a `console.error` giving the numbers
  (this cannot happen with the sizing above).
- No per-chunk large allocations: mixed samples go through a reused scratch
  array, and a partial timestep is carried in a `GROUP_SIZE` byte array, not
  re-concatenated with the next chunk.
- Supervision, OTP-style (`superviseConsumer`): the first throw detaches the
  consumer, logs once, and rebuilds it after 10 s. A 4th failure within 1 h
  calls `onFatal`, so index.ts stops children and exits 1, and
  `unless-stopped` restarts the container clean.
- `process.ts`: a consumer throw that still gets through is logged at most once
  a minute, with a count of dropped chunks.
- CI: a `test` job (typecheck + `bun test` on the image's Bun version) gates
  `build-and-push`.

## Progress

- [x] Ring buffer + allocation-free mixing (`src/transcribe.ts`).
- [x] Consumer supervision + exit escalation (`src/transcribe.ts`, `src/index.ts`).
- [x] Rate-limited consumer-throw logging (`src/process.ts`).
- [x] Tests: `src/transcribe.test.ts` (8 pass on Bun 1.3.0 and 1.4.4).
- [ ] PR merged to master and the image built: report the digest to the
      requesting thread. The ops pin and deploy are owned there, not here.

## Not done here

- Docker log-size caps are being added in ops by the sentinel disk-usage
  thread. They limit the damage but do not fix this.
