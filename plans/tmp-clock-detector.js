// tmp-clock-detector.js — detect BACKWARD jumps in a burned-in clock crop.
// Reads gray WxH rawvideo frames on stdin. A backward time jump changes the
// digits (differs from previous frame) AND matches a frame from >0.5s ago
// (the old time recurring). Forward ticks change digits but never match an
// older frame, so they don't fire. Env: W, H (default 250x28).
const W = parseInt(process.env.W || "250", 10);
const H = parseInt(process.env.H || "28", 10);
const N = W * H;
const MINLAG = 15; // 0.5s
const MAXLAG = 90; // 3s
let buf = Buffer.alloc(0);
let idx = 0;
let events = 0;
const ring = [];
function mad(a, b) {
  let s = 0;
  for (let i = 0; i < N; i++) s += Math.abs(a[i] - b[i]);
  return s / N;
}
function analyze(f) {
  if (ring.length > MINLAG) {
    const dPrev = mad(f, ring[ring.length - 1]);
    if (dPrev > 1.0) {
      let best = 1e9,
        bl = 0;
      const ml = Math.min(MAXLAG, ring.length);
      for (let lag = MINLAG; lag <= ml; lag++) {
        const d = mad(f, ring[ring.length - lag]);
        if (d < best) {
          best = d;
          bl = lag;
        }
      }
      if (best < 1.0 && best < 0.5 * dPrev) {
        events++;
        console.log(
          `REWIND frame=${idx} t=${(idx / 30).toFixed(2)}s dPrev=${dPrev.toFixed(
            2
          )} lag=${bl} (${(bl / 30).toFixed(2)}s back) dMatch=${best.toFixed(2)}`
        );
      }
    }
  }
  ring.push(f);
  if (ring.length > MAXLAG + 5) ring.shift();
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
  console.log(`DONE frames=${idx} events=${events}`)
);
