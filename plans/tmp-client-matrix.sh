#!/bin/bash
# Userspace-queue test matrix against the SIDE instance (port 8556 / 8891).
# The healthy client is present in every case - that is what the earlier
# attempts failed to check, and it is how they shipped broken.
say() { echo; echo "=== $* ==="; }

status() {
  curl -s http://localhost:8891/api/status > /tmp/q.json
  python3 - "$1" <<'PY'
import json, sys
d = json.load(open('/tmp/q.json'))
o = d['items'][0]
ses = [s for s in d['sessions'] if s.get('via','').startswith('rtsp')]
print(f"  [{sys.argv[1]}] out_dropped={o['dropped']} out_frames={o['frames']} "
      f"sessions={[(s['stream'], s.get('dropped'), s.get('queued')) for s in ses]}")
PY
}

say "CASE 1: healthy client alone (must be untouched: 0 client drops, 0 decode errors)"
timeout 40 ffmpeg -nostdin -loglevel error -rtsp_transport tcp \
  -i rtsp://127.0.0.1:8556/test -f null - 2>/tmp/h1.log &
HP=$!
for i in 1 2 3 4; do sleep 8; status "healthy t=$((i*8))s"; done
wait $HP 2>/dev/null
echo "  decode errors: $(grep -c 'error while decoding' /tmp/h1.log)"

say "CASE 2: healthy client + a 40%-speed client on the same stream"
timeout 50 ffmpeg -nostdin -loglevel error -rtsp_transport tcp \
  -i rtsp://127.0.0.1:8556/test -f null - 2>/tmp/h2.log &
HP=$!
sleep 2
timeout 45 ffmpeg -nostdin -loglevel error -readrate 0.4 -rtsp_transport tcp \
  -i rtsp://127.0.0.1:8556/test -f null - 2>/tmp/slow.log &
SP=$!
for i in 1 2 3 4 5; do sleep 8; status "mixed t=$((i*8))s"; done
wait $HP 2>/dev/null; wait $SP 2>/dev/null
echo "  healthy decode errors: $(grep -c 'error while decoding' /tmp/h2.log)"
echo "  slow    decode errors: $(grep -c 'error while decoding' /tmp/slow.log)"

say "queue/flush log"
docker logs stitchd-side 2>&1 | grep -E "behind — flushed|stopped reading" | tail -6
