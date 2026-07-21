#!/bin/sh
# Benchmark stitchd vs ffmpeg producing the SAME `full` (7560x2688 HEVC, 30fps
# real-time). Measures GPU engine load (sm/enc/dec) as a delta over the live
# baseline, plus process CPU. Runs each briefly and sequentially so the extra
# load on the live box is short.
set -e
RTSP=rtsp://localhost:8554/raw
SAMPLES=12

avg_dmon() { # $1 label -> prints "label sm=.. enc=.. dec=.."
  nvidia-smi dmon -s u -c "$SAMPLES" 2>/dev/null | awk -v L="$1" '
    NR>2 {sm+=$2; en+=$4; de+=$5; n++}
    END {printf "%-16s sm=%2.0f%% enc=%2.0f%% dec=%2.0f%%\n", L, sm/n, en/n, de/n}'
}

echo "=== baseline (production only) ==="
avg_dmon baseline

echo "=== stitchd full (30s real-time) ==="
docker rm -f stitchd_bench 2>/dev/null >/dev/null || true
docker run -d --name stitchd_bench --gpus all --network container:restitch \
  -e NVIDIA_DRIVER_CAPABILITIES=compute,video -v /tmp/stitchd-src:/src \
  stitchd-dev:latest /src/build/stitchd --composite-full --codec hevc_nvenc \
  --frames 900 --out /src/build/bench.mp4 \
  --in $RTSP/bay-1 --in $RTSP/bay-2 --in $RTSP/bay-3 --in $RTSP/bay-4 --in $RTSP/bay-5 \
  >/dev/null
sleep 8
avg_dmon stitchd
STITCHD_CPU=$(docker stats --no-stream --format '{{.CPUPerc}}' stitchd_bench)
echo "stitchd container CPU: $STITCHD_CPU"
docker rm -f stitchd_bench >/dev/null 2>&1 || true
sleep 3

echo "=== ffmpeg full-only -> null (30s real-time) ==="
# 5 NVDEC inputs -> vstack -> transpose90 -> hevc_nvenc -> null. Same recipe as
# production `full`, isolated. Runs inside the restitch container (production
# ffmpeg w/ NPP).
FC='[0:v]setparams=range=tv:colorspace=bt709,fps=30,scale_npp=format=nv12[a0];'
FC="$FC"'[1:v]setparams=range=tv:colorspace=bt709,fps=30,scale_npp=format=nv12[a1];'
FC="$FC"'[2:v]setparams=range=tv:colorspace=bt709,fps=30,scale_npp=format=nv12[a2];'
FC="$FC"'[3:v]setparams=range=tv:colorspace=bt709,fps=30,scale_npp=format=nv12[a3];'
FC="$FC"'[4:v]setparams=range=tv:colorspace=bt709,fps=30,scale_npp=format=nv12[a4];'
FC="$FC"'color=black:size=16x16:rate=30,format=nv12,setparams=range=tv:colorspace=bt709,hwupload_cuda,scale_cuda=w=2688:h=7560:format=nv12:interp_algo=nearest,setsar=1[cv];'
FC="$FC"'[cv][a0]overlay_cuda=x=0:y=0[s0];[s0][a1]overlay_cuda=x=0:y=1512[s1];[s1][a2]overlay_cuda=x=0:y=3024[s2];[s2][a3]overlay_cuda=x=0:y=4536[s3];[s3][a4]overlay_cuda=x=0:y=6048[st];'
FC="$FC"'[st]scale_npp=format=yuv420p,transpose_npp=dir=clock,scale_npp=format=nv12[full]'
IN=""
for n in 1 2 3 4 5; do
  IN="$IN -hwaccel cuda -hwaccel_device cu -hwaccel_output_format cuda -fflags nobuffer -rtsp_transport tcp -i $RTSP/bay-$n"
done
docker exec -d restitch sh -c "ffmpeg -y -loglevel error -init_hw_device cuda=cu -filter_hw_device cu $IN -filter_complex '$FC' -map '[full]' -c:v hevc_nvenc -rc:v vbr -cq 18 -b:v 0 -preset p4 -tune hq -bf 0 -g 60 -color_range tv -t 30 -f null - ; echo done > /tmp/bench-ff-done"
sleep 8
avg_dmon ffmpeg
# isolate OUR benchmark ffmpeg (the only one writing to null; production writes rtsp)
FF_CPU=$(docker exec restitch sh -c "ps -o pcpu,args -ax | grep '[f] null' | awk '{print \$1}' | head -1" 2>/dev/null | tr -d ' ')
echo "ffmpeg (full-only, null out) CPU: ${FF_CPU}% of one core"
# let it finish/expire
docker exec restitch sh -c 'rm -f /tmp/bench-ff-done' 2>/dev/null || true
echo "=== done ==="
