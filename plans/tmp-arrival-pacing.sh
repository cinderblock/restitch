#!/bin/sh
# arrival-pacing.sh <stream> [dur] — three checks on a live mediamtx path:
#  1) wallclock ARRIVAL pacing of packets (burstiness a PTS scan can't see)
#  2) stream-level reorder signaling (has_b_frames — should be 0 with -bf 0)
#  3) DECODED frame order (post-reorder presentation timestamps monotonic?)
S=$1
DUR=${2:-60}

echo "=== $S: stream reorder signaling ==="
docker exec restitch ffprobe -v error -rtsp_transport tcp \
  -select_streams v:0 \
  -show_entries stream=codec_name,profile,level,has_b_frames \
  -of default=noprint_wrappers=1 "rtsp://localhost:8554/$S"

echo "=== $S: arrival pacing (${DUR}s) ==="
docker exec restitch sh -c "stdbuf -oL ffprobe -v error -rtsp_transport tcp \
  -select_streams v:0 -show_entries packet=pts_time -of csv=p=0 \
  -read_intervals '%+$DUR' 'rtsp://localhost:8554/$S' | \
  perl -MTime::HiRes=time -ne 'printf \"%.4f\n\", time'" |
awk -v s="$S" '
  { n++
    if (n>1) {
      d=($1-prev)*1000
      sum+=d; sumsq+=d*d
      if (d>maxg) maxg=d
      if (d>150) { big++; if (big<=8) printf "  burst-gap #%d: %.0fms\n", big, d }
      if (d<5) fast++
    }
    prev=$1 }
  END { m=sum/(n-1); v=sumsq/(n-1)-m*m; if (v<0) v=0
        printf "%s ARRIVAL: %d pkts mean=%.1fms sd=%.1fms max=%.0fms gaps>150ms=%d back-to-back(<5ms)=%d\n", \
               s, n, m, sqrt(v), maxg, big, fast }'

echo "=== $S: decoded frame order (30s) ==="
docker exec restitch ffprobe -v error -rtsp_transport tcp \
  -select_streams v:0 -show_entries frame=pts_time -of csv=p=0 \
  -read_intervals '%+30' "rtsp://localhost:8554/$S" |
awk -v s="$S" '
  /^[0-9]/ { n++
    if (n>1) { d=($1-prev)*1000
      if (d<0)  { neg++; printf "  DECODED-REGRESS #%d: %.3f -> %.3f (%.0fms)\n", n, prev, $1, d }
      if (d==0) dup++
    }
    prev=$1 }
  END { printf "%s DECODED: %d frames, %d regressions, %d dups\n", s, n, neg, dup }'
