#!/bin/sh
# Max-throughput: how fast can each pump out `full` (7560x2688 HEVC) frames,
# unpaced, from the same 5 local file inputs (decode-once). fps = the metric.
F=/src/bench-src.mp4
FF=/tmp/bench-src.mp4
N=600

echo "=== stitchd unpaced ($N frames) ==="
docker run --rm --gpus all -e NVIDIA_DRIVER_CAPABILITIES=compute,video \
  -v /tmp/stitchd-src:/src stitchd-dev:latest \
  /src/build/stitchd --composite-full --unpaced --codec hevc_nvenc --frames $N \
  --out null --in $F --in $F --in $F --in $F --in $F 2>&1 | grep 'done:'

echo "=== ffmpeg unpaced ($N frames) ==="
FC='[0:v]setparams=range=tv:colorspace=bt709,fps=30,scale_npp=format=nv12[a0];'
FC="$FC"'[1:v]setparams=range=tv:colorspace=bt709,fps=30,scale_npp=format=nv12[a1];'
FC="$FC"'[2:v]setparams=range=tv:colorspace=bt709,fps=30,scale_npp=format=nv12[a2];'
FC="$FC"'[3:v]setparams=range=tv:colorspace=bt709,fps=30,scale_npp=format=nv12[a3];'
FC="$FC"'[4:v]setparams=range=tv:colorspace=bt709,fps=30,scale_npp=format=nv12[a4];'
FC="$FC"'color=black:size=16x16:rate=30,format=nv12,setparams=range=tv:colorspace=bt709,hwupload_cuda,scale_cuda=w=2688:h=7560:format=nv12:interp_algo=nearest,setsar=1[cv];'
FC="$FC"'[cv][a0]overlay_cuda=x=0:y=0[s0];[s0][a1]overlay_cuda=x=0:y=1512[s1];[s1][a2]overlay_cuda=x=0:y=3024[s2];[s2][a3]overlay_cuda=x=0:y=4536[s3];[s3][a4]overlay_cuda=x=0:y=6048[st];'
FC="$FC"'[st]scale_npp=format=yuv420p,transpose_npp=dir=clock,scale_npp=format=nv12[full]'
HW='-hwaccel cuda -hwaccel_device cu -hwaccel_output_format cuda'
docker exec restitch sh -c "
 S=\$(date +%s.%N)
 ffmpeg -y -loglevel error -init_hw_device cuda=cu -filter_hw_device cu \
  $HW -i $FF $HW -i $FF $HW -i $FF $HW -i $FF $HW -i $FF \
  -filter_complex '$FC' -map '[full]' -c:v hevc_nvenc -rc:v vbr -cq 18 -b:v 0 \
  -preset p4 -tune hq -bf 0 -g 60 -color_range tv -frames:v $N -f null -
 E=\$(date +%s.%N)
 T=\$(awk \"BEGIN{print \$E-\$S}\")
 awk \"BEGIN{printf \\\"ffmpeg: $N frames in %.1fs (%.1f fps)\\n\\\", \$T, $N/\$T}\"
"
echo "=== done ==="
