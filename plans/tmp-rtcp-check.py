#!/usr/bin/env python3
"""Do we ever send RTCP on the interleaved RTSP connection?

VLC corrects its playback clock from RTCP Sender Reports (they carry the
NTP<->RTP mapping). With none, a player free-runs on its own jitter buffer and
any latency it accumulates is permanent — which is exactly "lagging reality,
never catches up".

Counts $-framed interleaved data by channel: 0 = RTP, 1 = RTCP.
"""
import socket, sys, time, collections

host, port, path = "127.0.0.1", 8554, sys.argv[1] if len(sys.argv) > 1 else "entry"
url = f"rtsp://{host}:{port}/{path}"
s = socket.create_connection((host, port), timeout=10)
s.settimeout(10)
cseq = 0


def req(verb, extra=""):
    global cseq
    cseq += 1
    m = f"{verb} {url} RTSP/1.0\r\nCSeq: {cseq}\r\n{extra}\r\n"
    s.sendall(m.encode())
    time.sleep(0.4)
    try:
        return s.recv(65536).decode("latin1", "replace")
    except socket.timeout:
        return ""


req("OPTIONS")
req("DESCRIBE", "Accept: application/sdp\r\n")
setup = f"SETUP {url}/trackID=0 RTSP/1.0\r\nCSeq: {cseq+1}\r\nTransport: RTP/AVP/TCP;unicast;interleaved=0-1\r\n\r\n"
s.sendall(setup.encode()); cseq += 1
time.sleep(0.5)
try:
    s.recv(65536)
except socket.timeout:
    pass
play = f"PLAY {url} RTSP/1.0\r\nCSeq: {cseq+1}\r\nSession: 1\r\n\r\n"
s.sendall(play.encode())

buf = b""
counts = collections.Counter()
bytes_by_ch = collections.Counter()
deadline = time.time() + 20
while time.time() < deadline:
    try:
        d = s.recv(65536)
    except socket.timeout:
        break
    if not d:
        break
    buf += d
    # Skip the PLAY response, then parse $-framing.
    while True:
        i = buf.find(b"$")
        if i < 0 or len(buf) < i + 4:
            break
        ch = buf[i + 1]
        ln = int.from_bytes(buf[i + 2:i + 4], "big")
        if len(buf) < i + 4 + ln:
            break
        counts[ch] += 1
        bytes_by_ch[ch] += ln
        buf = buf[i + 4 + ln:]
s.close()

print(f"stream: {path}   (20s capture)")
for ch in sorted(set(list(counts) + [0, 1])):
    label = {0: "RTP ", 1: "RTCP"}.get(ch, f"ch{ch}")
    print(f"  channel {ch} ({label}): {counts[ch]:6d} frames, {bytes_by_ch[ch]:9d} bytes")
print()
print("RTCP sender reports present" if counts[1] else
      "NO RTCP AT ALL -> the client has no NTP/RTP mapping to correct its clock with")
