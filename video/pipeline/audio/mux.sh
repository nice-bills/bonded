#!/usr/bin/env bash
# mux.sh video.mp4 audio.wav out.mp4 — copy video, loudnorm audio (2-pass) to -16 LUFS / -1.5 dBTP, trim/pad to video length.
set -euo pipefail
V="$1"; A="$2"; O="$3"
D=$(ffprobe -v error -show_entries format=duration -of csv=p=0 "$V")
FO=$(python3 -c "print(max(0,$D-0.3))")
PRE="apad,atrim=0:$D,afade=t=out:st=$FO:d=0.3"
J=$(ffmpeg -hide_banner -nostats -i "$A" -af "$PRE,loudnorm=I=-16:TP=-1.5:LRA=11:print_format=json" -f null - 2>&1 | sed -n '/^{/,/^}/p')
g(){ echo "$J" | python3 -c "import json,sys;print(json.load(sys.stdin)['$1'])"; }
LN="loudnorm=I=-16:TP=-1.5:LRA=11:measured_I=$(g input_i):measured_TP=$(g input_tp):measured_LRA=$(g input_lra):measured_thresh=$(g input_thresh):offset=$(g target_offset):linear=true"
ffmpeg -y -v error -i "$V" -i "$A" -map 0:v:0 -map 1:a:0 -c:v copy -af "$PRE,$LN,aresample=48000" -ac 2 -c:a aac -b:a 192k -ar 48000 -shortest -movflags +faststart "$O"
ffprobe -v error -show_entries stream=codec_name,width,height,sample_rate,channels:format=duration -of compact "$O"
