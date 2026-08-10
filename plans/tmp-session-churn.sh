#!/bin/sh
# session-churn.sh — RTSP session churn per client/path over 24h.
# Line shapes:
#   ... INF [RTSP] [session e2e7e111] created by 10.255.0.77:42967
#   ... INF [RTSP] [session e2e7e111] is reading from path 'all-field', with TCP, ...
#   ... INF [RTSP] [session e2e7e111] destroyed: torn down by client
docker logs restitch --since 24h 2>&1 | grep '\[RTSP\] \[session ' > /tmp/rtsp-lines.txt
echo "total RTSP session log lines: $(wc -l < /tmp/rtsp-lines.txt)"

echo "--- reader sessions per (creator, path) ---"
awk '/created by/ {id=$6; sub(/\]$/,"",id); addr=$9; sub(/:[0-9]+$/,"",addr); creator[id]=addr}
     / is reading from path / {
       id=$6; sub(/\]$/,"",id)
       match($0, /path [^,]+, with/)
       p=substr($0, RSTART+5, RLENGTH-11)
       key=(creator[id] ? creator[id] : "?")" "p
       c[key]++
     }
     END {for (k in c) printf "%7d  %s\n", c[k], k}' /tmp/rtsp-lines.txt | sort -rn | head -25

echo "--- 10.255.0.77 sessions created per hour ---"
grep 'created by 10.255.0.77' /tmp/rtsp-lines.txt | cut -c1-13 | sort | uniq -c

echo "--- destroy reasons for 10.255.0.77 sessions ---"
awk '/created by 10.255.0.77/ {id=$6; sub(/\]$/,"",id); mine[id]=1}
     /destroyed/ {id=$6; sub(/\]$/,"",id); if (mine[id]) {s=$0; sub(/^.*destroyed/, "destroyed", s); r[s]++}}
     END {for (k in r) printf "%6d  %s\n", r[k], k}' /tmp/rtsp-lines.txt | sort -rn | head -10

echo "--- destroy reasons for 127.0.0.1 sessions ---"
awk '/created by 127.0.0.1/ {id=$6; sub(/\]$/,"",id); mine[id]=1}
     /destroyed/ {id=$6; sub(/\]$/,"",id); if (mine[id]) {s=$0; sub(/^.*destroyed/, "destroyed", s); r[s]++}}
     END {for (k in r) printf "%6d  %s\n", r[k], k}' /tmp/rtsp-lines.txt | sort -rn | head -10
