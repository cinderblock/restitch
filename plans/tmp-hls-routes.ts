// Throwaway: exercise the dashboard's /hls/* routing against a real server.
// Reading the handler is not proof it routes; this hits it.
//   bun run plans/tmp-hls-routes.ts
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startDashboard } from "../src/dashboard.ts";

const hlsDir = mkdtempSync(join(tmpdir(), "hlstest-"));
mkdirSync(join(hlsDir, "all-field"));
writeFileSync(join(hlsDir, "all-field", "index.m3u8"), "#EXTM3U\n#EXT-X-VERSION:7\nseg1.m4s\n");
writeFileSync(join(hlsDir, "all-field", "seg1.m4s"), "notreallymp4");

const PORT = 9411;
const server = startDashboard(
  { enabled: true, address: `:${PORT}`, mediamtx_api_url: "http://localhost:1" },
  undefined,
  undefined,
  hlsDir,
  "http://localhost:1/api/status"
);

const base = `http://localhost:${PORT}`;
let failures = 0;

async function check(path: string, want: number, assert?: (body: string, r: Response) => string | null) {
  const r = await fetch(base + path);
  const body = r.headers.get("content-type")?.includes("javascript")
    ? `<${(await r.arrayBuffer()).byteLength} bytes>`
    : await r.text();
  let note = "";
  let ok = r.status === want;
  if (ok && assert) {
    const err = assert(body, r);
    if (err) { ok = false; note = " — " + err; }
  }
  if (!ok) failures++;
  console.log(
    `${ok ? "ok  " : "FAIL"} ${path.padEnd(38)} ${r.status} (want ${want}) ` +
    `${(r.headers.get("content-type") ?? "-").split(";")[0]}${note}`
  );
}

// Player page: both with and without the trailing slash, since the public
// mount is hit as /all-field and the LAN one as /hls/all-field/.
await check("/hls/all-field", 200, b =>
  b.includes("index.m3u8") && b.includes("<video") ? null : "not the player page");
await check("/hls/all-field/", 200, b =>
  b.includes("<video") ? null : "not the player page");

// The library, at both the paths the page can ask for it from.
await check("/hls/all-field/hls.js", 200, (b, r) =>
  r.headers.get("content-type")?.includes("javascript") ? null : "wrong type");
await check("/hls/hls.js", 200, (b, r) =>
  r.headers.get("content-type")?.includes("javascript") ? null : "wrong type");

// Real media still served.
await check("/hls/all-field/index.m3u8", 200, b =>
  b.startsWith("#EXTM3U") ? null : "not the playlist");
await check("/hls/all-field/seg1.m4s", 200);

// Traversal guard. Must be percent-encoded: fetch (and every browser)
// resolves a literal ".." client-side, so the literal form never reaches the
// server and testing it proves nothing. The encoded form is what actually
// exercises the guard, and it matters that the handler decodes BEFORE it
// checks — otherwise this reads a file outside hlsDir.
// %2e%2e as a whole segment is resolved as a dot-segment by URL
// normalization, so it never reaches the /hls/ handler at all — 404 from
// normal routing, which is safe. Keeping it as a regression guard: if this
// ever returns 200, normalization changed underneath us.
await check("/hls/%2e%2e/package.json", 404);
// %2f keeps it in one segment, so this one survives normalization and is the
// case the guard actually has to catch.
await check("/hls/all-field/%2e%2e%2f%2e%2e%2fpackage.json", 400);
await check("/hls/%2Fetc%2Fpasswd", 400);
await check("/hls/nope/index.m3u8", 404);

server.stop(true);
console.log(failures ? `\n${failures} FAILED` : "\nall passed");
process.exit(failures ? 1 : 0);
