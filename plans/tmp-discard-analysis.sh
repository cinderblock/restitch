#!/bin/sh
# discard-analysis.sh — map mediamtx slow-reader discards to sessions/paths.
# Log line shape:
#   2026/07/19 21:20:10 WAR [RTSP] [session ed5c1cb5] reader is too slow, discarding 66 frames
docker logs restitch --since 24h 2>&1 |
  grep -oE '2026/[0-9/]+ [0-9:]+ WAR \[RTSP\] \[session [0-9a-f]+\] reader is too slow, discarding [0-9]+ frames' \
  > /tmp/discards.txt

echo "total discard lines: $(wc -l < /tmp/discards.txt)"

echo "--- per session: lines, frames, first, last ---"
awk '{
  id=$6; sub(/\]$/,"",id)
  c[id]++; sum[id]+=$12
  if (!(id in first)) first[id]=$1" "$2
  last[id]=$1" "$2
}
END { for (i in c) printf "%6d  %-10s frames=%-8d first=%s last=%s\n", c[i], i, sum[i], first[i], last[i] }' \
  /tmp/discards.txt | sort -rn

echo "--- per hour ---"
cut -c1-13 /tmp/discards.txt | sort | uniq -c

echo "--- current sessions (id path remote state) ---"
curl -s http://localhost:9997/v3/rtspsessions/list |
  jq -r '.items[] | "\(.id[0:8]) \(.path) \(.remoteAddr) \(.state)"'
