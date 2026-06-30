#!/bin/bash
# Isolate the composite corruption: encode a full-low-equivalent stream
# (5 bays → vstack → transpose → scale 3600x1280 → h264_nvenc) two ways —
# with the current aggressive low-latency flags (-delay 0 -rc-lookahead 0)
# and without — then count decode errors in each output. Runs alongside the
# live compositor so the concurrent GPU load is realistic.
#
# Run inside the container:
#   docker cp scripts/test-nvenc-corruption.sh restitch:/tmp/ && docker exec restitch bash /tmp/test-nvenc-corruption.sh
set -u

inputs=""
for b in bay-1 bay-2 bay-3 bay-4 bay-5; do
	inputs="$inputs -hwaccel cuda -hwaccel_output_format nv12 -fflags nobuffer -flags low_delay -rtsp_transport tcp -allowed_media_types video -i rtsp://localhost:8554/raw/$b"
done
# fps+setpts per input, vstack, rotate, scale to the full-low size
fc="[0:v]fps=30,setpts=(RTCTIME-RTCSTART)/(TB*1000000)[a0];[1:v]fps=30,setpts=(RTCTIME-RTCSTART)/(TB*1000000)[a1];[2:v]fps=30,setpts=(RTCTIME-RTCSTART)/(TB*1000000)[a2];[3:v]fps=30,setpts=(RTCTIME-RTCSTART)/(TB*1000000)[a3];[4:v]fps=30,setpts=(RTCTIME-RTCSTART)/(TB*1000000)[a4];[a0][a1][a2][a3][a4]vstack=inputs=5[s];[s]transpose=1,scale=3600:1280:flags=lanczos[v]"

common="-rc:v vbr -cq 18 -b:v 0 -preset p4 -tune ll -bf 0 -g 30 -keyint_min 30 -pix_fmt yuv420p -color_range tv"

echo "=== WITH -delay 0 -rc-lookahead 0 (current production) ==="
# shellcheck disable=SC2086
ffmpeg -loglevel error -y $inputs -filter_complex "$fc" -map "[v]" -c:v h264_nvenc $common -rc-lookahead 0 -delay 0 -t 8 /tmp/with.mp4 2>/dev/null
echo "  decode errors: $(ffmpeg -hide_banner -loglevel error -i /tmp/with.mp4 -f null - 2>&1 | grep -cE 'error|bytestream|unavailable')"

echo "=== WITHOUT those flags (plain -tune ll -bf 0) ==="
# shellcheck disable=SC2086
ffmpeg -loglevel error -y $inputs -filter_complex "$fc" -map "[v]" -c:v h264_nvenc $common -t 8 /tmp/without.mp4 2>/dev/null
echo "  decode errors: $(ffmpeg -hide_banner -loglevel error -i /tmp/without.mp4 -f null - 2>&1 | grep -cE 'error|bytestream|unavailable')"
