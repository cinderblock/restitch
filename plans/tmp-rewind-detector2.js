// tmp-rewind-detector2.js — content-rewind detector v2.
// Reads gray 128x72 rawvideo frames on stdin. Flags frames closely matching
// an OLD frame (0.33-4s ago) while differing sharply from their predecessor,
// and SAVES specimens (current, previous, matched-old) as PGM for visual
// diagnosis. Wallclock-stamped events for log correlation.
// Usage: ffmpeg ... -vf scale=128:72,format=gray -f rawvideo - | bun this.js <name>
const fs = require("fs");
const W = 128,
  H = 72,
  N = W * H;
const MINLAG = 10,
  MAXLAG = 120,
  LAGSTRIDE = 2;
const SPECDIR = "/tmp/rwspec";
const name = process.argv[2] ?? "stream";
const ring = [];
let idx = 0,
  events = 0,
  saved = 0;
let buf = Buffer.alloc(0);
fs.mkdirSync(SPECDIR, { recursive: true });

function mad(a, b) {
  let s = 0;
  for (let i = 0; i < N; i++) s += Math.abs(a[i] - b[i]);
  return s / N;
}
function savePGM(tag, data) {
  fs.writeFileSync(
    `${SPECDIR}/${name}_${idx}_${tag}.pgm`,
    Buffer.concat([Buffer.from(`P5\n${W} ${H}\n255\n`), data])
  );
}
function analyze(f) {
  if (ring.length > MINLAG) {
    const prev = ring[ring.length - 1];
    const dPrev = mad(f, prev);
    if (dPrev > 3) {
      let best = Infinity,
        bestLag = 0;
      const maxl = Math.min(MAXLAG, ring.length);
      for (let lag = MINLAG; lag <= maxl; lag += LAGSTRIDE) {
        const d = mad(f, ring[ring.length - lag]);
        if (d < best) {
          best = d;
          bestLag = lag;
        }
      }
      const ts = new Date().toISOString();
      if (best < 3 && best < 0.4 * dPrev) {
        events++;
        console.log(
          `${ts} ${name} REWIND frame=${idx} dPrev=${dPrev.toFixed(1)} ` +
            `lag=${bestLag} (${(bestLag / 30).toFixed(2)}s) dMatch=${best.toFixed(2)}`
        );
        if (saved < 20) {
          saved++;
          savePGM("cur", f);
          savePGM("prev", prev);
          savePGM(`old${bestLag}`, ring[ring.length - bestLag]);
        }
      } else if (best < 6 && best < 0.6 * dPrev) {
        console.log(
          `${ts} ${name} NEAR frame=${idx} dPrev=${dPrev.toFixed(1)} ` +
            `lag=${bestLag} dMatch=${best.toFixed(2)}`
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
  console.log(
    `${new Date().toISOString()} ${name} DONE frames=${idx} events=${events}`
  )
);
