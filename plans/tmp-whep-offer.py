#!/usr/bin/env python3
"""POST a Chrome-shaped WHEP offer and show how the answer's m-lines compare."""
import sys, urllib.request

stream = sys.argv[1] if len(sys.argv) > 1 else "full-low"
fp = ":".join(f"{b:02X}" for b in bytes(range(32)))

offer = "\r\n".join([
    "v=0",
    "o=- 4611731400430051336 2 IN IP4 127.0.0.1",
    "s=-",
    "t=0 0",
    "a=group:BUNDLE 0",
    "a=extmap-allow-mixed",
    "a=msid-semantic: WMS",
    "m=video 9 UDP/TLS/RTP/SAVPF 96",
    "c=IN IP4 0.0.0.0",
    "a=rtcp:9 IN IP4 0.0.0.0",
    "a=ice-ufrag:Xy4z",
    "a=ice-pwd:abcdefghijklmnopqrstuvwx",
    "a=ice-options:trickle",
    f"a=fingerprint:sha-256 {fp}",
    "a=setup:actpass",
    "a=mid:0",
    "a=recvonly",
    "a=rtcp-mux",
    "a=rtpmap:96 H264/90000",
    "a=fmtp:96 level-asymmetry-allowed=1;packetization-mode=1;profile-level-id=42e01f",
    "",
])

req = urllib.request.Request(
    f"http://127.0.0.1:8889/whep/{stream}",
    data=offer.encode(),
    headers={"Content-Type": "application/sdp"},
    method="POST",
)
try:
    with urllib.request.urlopen(req, timeout=20) as r:
        answer = r.read().decode()
        print("HTTP", r.status)
except Exception as e:
    print("request failed:", e)
    raise SystemExit(1)


def mlines(sdp):
    out, mid = [], None
    for ln in sdp.splitlines():
        if ln.startswith("m="):
            out.append([ln.split()[0][2:], None])
        elif ln.startswith("a=mid:") and out:
            out[-1][1] = ln[6:].strip()
    return out

print("OFFER  m-lines (kind, mid):", mlines(offer))
print("ANSWER m-lines (kind, mid):", mlines(answer))
print()
o, a = mlines(offer), mlines(answer)
if [x[1] for x in o] == [x[1] for x in a]:
    print("MATCH — a browser would accept this answer")
else:
    print("MISMATCH — Chrome rejects: 'order of m-lines in answer doesn't match'")
