#!/bin/bash
# Bring up the isolated test rig: two killable relays into production's RTSP,
# and a side stitchd on its own ports. Production is never touched.
set -e
docker rm -f stitchd-side >/dev/null 2>&1 || true
pkill -f relay.py >/dev/null 2>&1 || true
sleep 2

nohup python3 /tmp/relay.py 8600 127.0.0.1 8554 >/tmp/r1.log 2>&1 &
nohup python3 /tmp/relay.py 8601 127.0.0.1 8554 >/tmp/r2.log 2>&1 &
sleep 2

mkdir -p /tmp/test
cat > /tmp/test/stitchd.conf <<'CONF'
fps 15
comp-rot 0
comp-dim 2400 1352
comp-in rtsp://127.0.0.1:8600/entry
comp-in rtsp://127.0.0.1:8601/entry
raw t1 rtsp://127.0.0.1:8600/entry
raw t2 rtsp://127.0.0.1:8601/entry
out test h264_nvenc 2000000
piece composite 0 0 2400 1352 800 450 0
CONF

docker run -d --name stitchd-side --gpus all \
  -e NVIDIA_DRIVER_CAPABILITIES=compute,video --network host \
  -v /tmp/stitchd-src:/src:ro -v /tmp/test:/test \
  stitchd-test:latest /src/build/stitchd --config /test/stitchd.conf \
  --out null --rtsp-port 8556 --webrtc-port 8891 --webrtc-udp 8191 >/dev/null
echo "side instance started"
sleep 30
docker logs stitchd-side 2>&1 | grep -E 'stitchd\]|rtsp\]|MAP_FAILED' | tail -8
