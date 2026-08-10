#!/bin/bash
# CASE 3: a client that stops reading entirely - last night's wedge.
# CASE 4: connect/disconnect churn - one writer thread per session now, so a
#         leak here would be a slow death.
cat > /tmp/frozen.py <<'PY'
import socket, time, sys
s = socket.create_connection(('127.0.0.1', 8556))
def rq(r):
    s.sendall(r.encode()); time.sleep(0.4); s.settimeout(5)
    try: return s.recv(65536).decode('latin1')
    except Exception: return ''
u = 'rtsp://127.0.0.1:8556/test'
rq(f'OPTIONS {u} RTSP/1.0\r\nCSeq: 1\r\n\r\n')
rq(f'DESCRIBE {u} RTSP/1.0\r\nCSeq: 2\r\nAccept: application/sdp\r\n\r\n')
rq(f'SETUP {u}/trackID=0 RTSP/1.0\r\nCSeq: 3\r\nTransport: RTP/AVP/TCP;unicast;interleaved=0-1\r\n\r\n')
r = rq(f'PLAY {u} RTSP/1.0\r\nCSeq: 4\r\nSession: 1\r\n\r\n')
print('  PLAY ok:', 'RTSP/1.0 200' in r, flush=True)
time.sleep(int(sys.argv[1]))   # read NOTHING
PY

echo "=== CASE 3: frozen client (reads nothing) + healthy client ==="
timeout 70 ffmpeg -nostdin -loglevel error -rtsp_transport tcp \
  -i rtsp://127.0.0.1:8556/test -f null - 2>/tmp/h3.log &
HP=$!
sleep 2
python3 /tmp/frozen.py 60 &
FP=$!
for i in 1 2 3 4 5 6 7; do
  sleep 8
  curl -s http://localhost:8891/api/status > /tmp/q.json
  python3 - "$((i*8))" <<'PY'
import json, sys
d = json.load(open('/tmp/q.json'))
o = d['items'][0]
ses = [(s['stream'], s.get('dropped'), s.get('queued')) for s in d['sessions']]
print(f"  t={sys.argv[1]}s out_dropped={o['dropped']} out_frames={o['frames']} rtspClients={d['rtspClients']} sessions={ses}")
PY
done
wait $HP 2>/dev/null; wait $FP 2>/dev/null
echo "  healthy decode errors during the freeze: $(grep -c 'error while decoding' /tmp/h3.log)"
echo "--- reap log ---"
docker logs stitchd-side 2>&1 | grep -E "stopped reading|behind — flushed" | tail -4

echo
echo "=== CASE 4: 25 connect/disconnect cycles (thread leak check) ==="
BEFORE=$(ps -o nlwp= -p "$(docker inspect -f '{{.State.Pid}}' stitchd-side)" | tr -d ' ')
for i in $(seq 1 25); do
  timeout 3 ffmpeg -nostdin -loglevel error -rtsp_transport tcp \
    -i rtsp://127.0.0.1:8556/test -frames:v 1 -f null - >/dev/null 2>&1
done
sleep 5
AFTER=$(ps -o nlwp= -p "$(docker inspect -f '{{.State.Pid}}' stitchd-side)" | tr -d ' ')
echo "  threads before=$BEFORE after=$AFTER (a leak would grow by ~25)"
curl -s http://localhost:8891/api/status > /tmp/q.json
python3 -c "
import json; d=json.load(open('/tmp/q.json'))
print('  rtspClients now:', d['rtspClients'], ' out_dropped:', d['items'][0]['dropped'])"
