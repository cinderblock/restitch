#!/bin/sh
# pacing2.sh <stream> [dur] — wallclock arrival pacing of RTSP packets.
# Timestamps each packet line with bun (container has no Time::HiRes).
S=$1
DUR=${2:-60}
docker exec restitch sh -c "stdbuf -oL ffprobe -v error -rtsp_transport tcp \
  -select_streams v:0 -show_entries packet=pts_time -of csv=p=0 \
  -read_intervals '%+$DUR' 'rtsp://localhost:8554/$S' | \
  bun -e 'const rl = require(\"readline\").createInterface({ input: process.stdin });
          rl.on(\"line\", () => console.log((performance.timeOrigin + performance.now()) / 1000));'" |
awk -v s="$S" '
  { n++
    if (n>1) {
      d=($1-prev)*1000
      sum+=d; sumsq+=d*d
      if (d>maxg) maxg=d
      if (d>150) { big++; if (big<=10) printf "%s burst-gap #%d at +%.1fs: %.0fms\n", s, big, ($1-t0), d }
      if (d<5) fast++
    } else t0=$1
    prev=$1 }
  END { m=sum/(n-1); v=sumsq/(n-1)-m*m; if (v<0) v=0
        printf "%s ARRIVAL: %d pkts mean=%.1fms sd=%.1fms max=%.0fms gaps>150ms=%d back-to-back(<5ms)=%d\n", \
               s, n, m, sqrt(v), maxg, big, fast }'
