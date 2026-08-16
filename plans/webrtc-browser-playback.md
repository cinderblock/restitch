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
