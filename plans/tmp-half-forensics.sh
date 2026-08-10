#!/bin/sh
# half-forensics.sh — do the two halves of all-field advance together?
# Decodes 60s, computes per-frame Y temporal diff (signalstats YDIF) for the
# top (the-field) and bottom (Field Centered) halves, then counts frames
# where one half holds (YDIF~0) while the other moves. A top-only-hold
# excess = stale-frame pairing on the re-ingested the-field branch.
docker exec restitch sh -c '
  rm -f /tmp/half-top.txt /tmp/half-bot.txt
  ffmpeg -hide_banner -loglevel error -rtsp_transport tcp \
    -i rtsp://localhost:8554/all-field -t 60 -filter_complex "
      [0:v]split=2[a][b];
      [a]crop=iw:ih/2:0:0,signalstats,metadata=print:key=lavfi.signalstats.YDIF:file=/tmp/half-top.txt[oa];
      [b]crop=iw:ih/2:0:ih/2,signalstats,metadata=print:key=lavfi.signalstats.YDIF:file=/tmp/half-bot.txt[ob]" \
    -map "[oa]" -f null - -map "[ob]" -f null -
'
docker exec restitch sh -c '
  grep -o "YDIF=[0-9.]*" /tmp/half-top.txt | cut -d= -f2 > /tmp/half-top.vals
  grep -o "YDIF=[0-9.]*" /tmp/half-bot.txt | cut -d= -f2 > /tmp/half-bot.vals
  paste /tmp/half-top.vals /tmp/half-bot.vals
' |
awk '
  { n++; t=$1; b=$2
    tsum+=t; bsum+=b
    # "hold": essentially no change vs previous frame; "moving": clear change
    th=(t<0.05); bh=(b<0.05)
    if (th && !bh && b>0.2) toponly++
    if (bh && !th && t>0.2) botonly++
    if (th && bh) bothhold++
  }
  END {
    printf "frames=%d  mean YDIF top=%.2f bot=%.2f\n", n, tsum/n, bsum/n
    printf "TOP holds while bottom moves: %d\n", toponly
    printf "BOTTOM holds while top moves: %d\n", botonly
    printf "both still: %d\n", bothhold
  }'
