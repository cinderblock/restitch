#!/bin/bash
# Diagnostic: compare vstack input-sync strategies for the doorbell+foyer
# composite. Captures 15s with each filter variant, then counts unique
# frames in the TOP (doorbell) half via mpdecimate. A healthy variant
# keeps the top-half unique count close to the bottom-half count.
#
# Run inside the restitch container:
#   docker cp scripts/test-vstack-sync.sh restitch:/tmp/ && docker exec restitch bash /tmp/test-vstack-sync.sh
set -u

DOORBELL="rtsp://localhost:8554/raw/doorbell"
FOYER="rtsp://localhost:8554/raw/foyer"
DUR=15

count_unique_top() {
	# $1 = file. Top half is 0..676 of the 1200x1352 composite.
	ffmpeg -loglevel info -i "$1" -vf "crop=1200:676:0:0,mpdecimate" -an -f null - 2>&1 \
		| grep -oE 'frame=[ ]*[0-9]+' | tail -1
}
count_unique_bottom() {
	ffmpeg -loglevel info -i "$1" -vf "crop=1200:676:0:676,mpdecimate" -an -f null - 2>&1 \
		| grep -oE 'frame=[ ]*[0-9]+' | tail -1
}
total_frames() {
	ffprobe -v error -count_frames -select_streams v -show_entries stream=nb_read_frames -of csv=p=0 "$1"
}

# --- Variant A: current production chain (wallclock + per-input fps) ---
echo "=== VARIANT A: wallclock + fps=30 per input ==="
ffmpeg -loglevel error -y \
	-use_wallclock_as_timestamps 1 -rtsp_transport tcp -allowed_media_types video -i "$DOORBELL" \
	-use_wallclock_as_timestamps 1 -rtsp_transport tcp -allowed_media_types video -i "$FOYER" \
	-filter_complex "[0:v]fps=30[d];[d]crop=1200:676:0:462[dc];[1:v]fps=30[f];[f]scale=1200:676[fs];[dc][fs]vstack=inputs=2[v]" \
	-map "[v]" -c:v h264_nvenc -t $DUR /tmp/va.mp4 2>/dev/null
echo "  total=$(total_frames /tmp/va.mp4)  top-unique=$(count_unique_top /tmp/va.mp4)  bottom-unique=$(count_unique_bottom /tmp/va.mp4)"

# --- Variant B: no wallclock, source PTS drives fps ---
echo "=== VARIANT B: no wallclock, source PTS + fps=30 ==="
ffmpeg -loglevel error -y \
	-rtsp_transport tcp -allowed_media_types video -i "$DOORBELL" \
	-rtsp_transport tcp -allowed_media_types video -i "$FOYER" \
	-filter_complex "[0:v]fps=30[d];[d]crop=1200:676:0:462[dc];[1:v]fps=30[f];[f]scale=1200:676[fs];[dc][fs]vstack=inputs=2[v]" \
	-map "[v]" -c:v h264_nvenc -t $DUR /tmp/vb.mp4 2>/dev/null
echo "  total=$(total_frames /tmp/vb.mp4)  top-unique=$(count_unique_top /tmp/vb.mp4)  bottom-unique=$(count_unique_bottom /tmp/vb.mp4)"

# --- Variant C: frame-index PTS regen (setpts=N/30/TB) decouples timelines ---
echo "=== VARIANT C: fps=30 + setpts=N/30/TB per input ==="
ffmpeg -loglevel error -y \
	-rtsp_transport tcp -allowed_media_types video -i "$DOORBELL" \
	-rtsp_transport tcp -allowed_media_types video -i "$FOYER" \
	-filter_complex "[0:v]fps=30,setpts=N/30/TB[d];[d]crop=1200:676:0:462[dc];[1:v]fps=30,setpts=N/30/TB[f];[f]scale=1200:676[fs];[dc][fs]vstack=inputs=2[v]" \
	-map "[v]" -c:v h264_nvenc -t $DUR /tmp/vc.mp4 2>/dev/null
echo "  total=$(total_frames /tmp/vc.mp4)  top-unique=$(count_unique_top /tmp/vc.mp4)  bottom-unique=$(count_unique_bottom /tmp/vc.mp4)"
