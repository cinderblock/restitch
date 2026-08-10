#!/bin/sh
# pts-scan.sh <stream> [seconds] — report PTS anomalies on a live mediamtx path.
# Reads packets via ffprobe inside the restitch container; prints negative
# deltas (rubber-band candidates), exact duplicates, and gaps >100ms.
S=$1
DUR=${2:-45}
docker exec restitch ffprobe -v error -rtsp_transport tcp \
  -select_streams v:0 \
  -show_entries packet=pts_time -of csv=p=0 \
  -read_intervals "%+${DUR}" \
  "rtsp://localhost:8554/${S}" 2>/dev/null |
awk -v s="$S" '
  /^[0-9]/ {
    n++
    if (n > 1) {
      d = ($1 - prev) * 1000
      if (d < 0)        { neg++;  printf "%s NEG  #%d  %.3f -> %.3f  (%.0fms)\n", s, n, prev, $1, d }
      else if (d == 0)  { dup++;  printf "%s DUP  #%d  %.3f\n", s, n, $1 }
      else if (d > 100) { gap++;  printf "%s GAP  #%d  %.3f -> %.3f  (+%.0fms)\n", s, n, prev, $1, d }
    }
    prev = $1
  }
  END { printf "%s SUMMARY: %d pkts, %d neg, %d dup, %d gap>100ms\n", s, n, neg, dup, gap }
'
