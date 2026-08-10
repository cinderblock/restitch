#!/bin/sh
# Does -fflags discardcorrupt drop damaged frames on the NVDEC decode path?
# Capture real camera footage, splice out 64KB mid-GOP (simulating mediamtx
# RTP discards), decode with production CUDA flags with/without the flag.
set -e
cd /tmp
ffmpeg -y -v error -rtsp_transport tcp -allowed_media_types video \
  -i rtsp://localhost:8554/raw/bay-1 -t 15 -c copy -f h264 cap.h264
S=$(stat -c %s cap.h264)
echo "captured $S bytes"
CUT=$((S * 2 / 5))
head -c $CUT cap.h264 > corrupt.h264
tail -c +$((CUT + 65536)) cap.h264 >> corrupt.h264

run() {
  # shellcheck disable=SC2086
  ffmpeg -y -init_hw_device cuda=cu -filter_hw_device cu \
    -hwaccel cuda -hwaccel_device cu -hwaccel_output_format cuda \
    $2 -i "$1" -vf hwdownload,format=nv12 -f null - 2>&1 |
    grep -oE 'frame= *[0-9]+' | tail -n 1
}

echo "pristine, plain:           $(run cap.h264 '')"
echo "corrupt,  plain:           $(run corrupt.h264 '')"
echo "corrupt,  discardcorrupt:  $(run corrupt.h264 '-fflags discardcorrupt')"

echo "--- decoder messages on corrupt+discardcorrupt ---"
ffmpeg -y -init_hw_device cuda=cu -filter_hw_device cu \
  -hwaccel cuda -hwaccel_device cu -hwaccel_output_format cuda \
  -fflags discardcorrupt -i corrupt.h264 -vf hwdownload,format=nv12 \
  -f null - 2>&1 | grep -iE 'corrupt|error|conceal' | sort | uniq -c | head -n 10
