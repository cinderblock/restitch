#!/bin/bash
# Diagnostic: compare vstack input-sync strategies for the doorbell+foyer
# composite. Captures 15s with each filter variant and counts unique frames
# in the TOP (doorbell) half via mpdecimate — a healthy variant keeps the
# top-half count high (live), a collapsed one drops near 1fps.
#
# Smoothness is what this measures. Internal cross-input SYNC is reasoned
# about separately (needs visual verification), but the goal is a variant
# that is BOTH smooth here AND uses a common real-time clock so vstack pairs
# regions by the same wall-clock moment.
#
# Run inside the restitch container:
#   docker cp scripts/test-vstack-sync.sh restitch:/tmp/ && docker exec restitch bash /tmp/test-vstack-sync.sh
set -u

DOORBELL="rtsp://localhost:8554/raw/doorbell"
FOYER="rtsp://localhost:8554/raw/foyer"
DUR=15
HW="-hwaccel cuda -hwaccel_output_format nv12"

uniq_top() { ffmpeg -loglevel info -i "$1" -vf "crop=1200:676:0:0,mpdecimate" -an -f null - 2>&1 | grep -oE 'frame=[ ]*[0-9]+' | tail -1; }
total()    { ffprobe -v error -count_frames -select_streams v -show_entries stream=nb_read_frames -of csv=p=0 "$1"; }

run() {
	local label="$1" extra_in="$2" vf="$3" out="$4"
	echo "=== ${label} ==="
	# shellcheck disable=SC2086
	ffmpeg -loglevel error -y \
		${HW} ${extra_in} -rtsp_transport tcp -allowed_media_types video -i "$DOORBELL" \
		${HW} ${extra_in} -rtsp_transport tcp -allowed_media_types video -i "$FOYER" \
		-filter_complex "[0:v]${vf}[d];[d]crop=1200:676:0:462[dc];[1:v]${vf}[f];[f]scale=1200:676[fs];[dc][fs]vstack=inputs=2[v]" \
		-map "[v]" -c:v h264_nvenc -t $DUR "$out" 2>/dev/null
	echo "  total=$(total "$out")  top-unique=$(uniq_top "$out")"
}

# C = current production: frame-index PTS (smooth, but internally skews)
run "C: fps + setpts=N/30/TB (current)" "" "fps=30,setpts=N/30/TB" /tmp/vc.mp4

# D1 = real-time PTS, per-input epoch (RTCSTART). Common-ish clock; small
#      startup offset possible if inputs start at different times.
run "D1: fps + setpts=(RTCTIME-RTCSTART)/(TB*1000000)" "" "fps=30,setpts=(RTCTIME-RTCSTART)/(TB*1000000)" /tmp/vd1.mp4

# D2 = real-time PTS, absolute wall clock (no per-input epoch). Truly common
#      clock across inputs → vstack pairs by the same real moment regardless
#      of when each input started.
run "D2: fps + setpts=RTCTIME/(TB*1000000)" "" "fps=30,setpts=RTCTIME/(TB*1000000)" /tmp/vd2.mp4
