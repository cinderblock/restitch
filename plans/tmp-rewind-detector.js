// tmp-rewind-detector.js — content-rewind detector.
// Reads gray 64x36 rawvideo frames on stdin. Flags frames that closely match
// an OLD frame (MINLAG..MAXLAG ago) while differing sharply from the previous
// frame — the signature of a stale frame spliced into forward playback.
// Usage: ffmpeg ... -vf scale=64:36,format=gray -f rawvideo - | bun this.js <name>
const W = 64,
  H = 36,
  N = W * H;
const MINLAG = 10; // 0.33s — ignore trivial near-duplicates
const MAXLAG = 120; // 4s window
const name = process.argv[2] ?? "stream";
const ring = [];
let idx = 0;
let events = 0;
let buf = Buffer.alloc(0);

function mad(a, b) {
  let s = 0;
  for (let i = 0; i < N; i++) s += Math.abs(a[i] - b[i]);
  return s / N;
}

function analyze(f) {
  if (ring.length > MINLAG) {
    const dPrev = mad(f, ring[ring.length - 1]);
    // Only frames that visibly CHANGED vs their neighbor can be rewinds;
    // static scenes (dPrev~0) are skipped, which also gates out the OSD
    // clock's once-per-second digit repaint (tiny area at this scale).
    if (dPrev > 3) {
      let best = Infinity,
        bestLag = 0;
      const maxl = Math.min(MAXLAG, ring.length);
      for (let lag = MINLAG; lag <= maxl; lag++) {
        const d = mad(f, ring[ring.length - lag]);
        if (d < best) {
          best = d;
          bestLag = lag;
        }
      }
      if (best < 3 && best < 0.4 * dPrev) {
        events++;
        console.log(
          `${name} REWIND frame=${idx} t=${(idx / 30).toFixed(1)}s ` +
            `dPrev=${dPrev.toFixed(1)} matchLag=${bestLag} ` +
            `(${(bestLag / 30).toFixed(2)}s ago) dMatch=${best.toFixed(2)}`
        );
      }
    }
  }
  ring.push(f);
  if (ring.length > MAXLAG + 2) ring.shift();
  idx++;
}

process.stdin.on("data", (d) => {
  buf = buf.length ? Buffer.concat([buf, d]) : d;
  while (buf.length >= N) {
    analyze(Buffer.from(buf.subarray(0, N)));
    buf = buf.subarray(N);
  }
});
process.stdin.on("end", () =>
  console.log(`${name} DONE frames=${idx} events=${events}`)
);
