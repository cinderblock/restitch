import { readFileSync } from "node:fs";
import type { Server } from "bun";
import type { Dashboard } from "./config.ts";
import type { RingBuffer, LiveStats } from "./transcribe.ts";

// The dashboard and the HLS player are real .html files under src/web/.
//
// They used to be template literals in this file — 800 lines of markup, CSS and
// browser JS with no syntax highlighting, no formatting and nothing that would
// catch a typo short of loading the page. `bun run check` validates the
// TypeScript around them and never looked inside. As files they get all of that
// from ordinary tooling, and this file goes back to being server code.
//
// Read once at startup, anchored to this module rather than the process CWD:
// the container runs from /opt/restitch today but nothing guarantees that.
// `COPY src ./src` in the Dockerfile already ships them.
function readWebAsset(name: string): string {
  return readFileSync(`${import.meta.dir}/web/${name}`, "utf8");
}

const HTML = readWebAsset("dashboard.html");

function parseAddress(addr: string): { hostname?: string; port: number } {
  const colon = addr.lastIndexOf(":");
  if (colon === -1) return { port: parseInt(addr, 10) || 9000 };
  const host = addr.slice(0, colon);
  const port = parseInt(addr.slice(colon + 1), 10) || 9000;
  return host ? { hostname: host, port } : { port };
}

async function proxyJson(url: string): Promise<Response> {
  try {
    const r = await fetch(url);
    return new Response(await r.text(), {
      status: r.status,
      headers: { "content-type": "application/json" },
    });
  } catch (e) {
    return Response.json(
      { error: e instanceof Error ? e.message : String(e) },
      { status: 502 }
    );
  }
}

/**
 * Map of "addr:port" -> { command, pid } for every ESTABLISHED TCP socket,
 * keyed by the *local* side of each socket. Used to translate a session's
 * remote address (which from the OS view is some other process's local
 * address) into a human-readable executable name.
 *
 * Runs `ss -tnpH`. In the container we are root so no sudo is needed and
 * all child PIDs (stitchd/whisper/ffmpeg snapshots) are visible in our PID
 * namespace. We try plain `ss` first and fall back to `sudo -n ss` for a
 * non-root host runner. If neither works, returns empty and the dashboard
 * shows raw addresses.
 */
async function runSs(cmd: string[]): Promise<string | null> {
  try {
    const proc = Bun.spawn(cmd, { stdout: "pipe", stderr: "pipe" });
    const out = await new Response(proc.stdout).text();
    if ((await proc.exited) !== 0) return null;
    return out;
  } catch {
    return null;
  }
}

async function readPeers(): Promise<Record<string, { command: string; pid: number }>> {
  const peers: Record<string, { command: string; pid: number }> = {};
  // Root-in-container path first, then sudo fallback for a non-root host.
  const out =
    (await runSs(["ss", "-tnpH"])) ?? (await runSs(["sudo", "-n", "ss", "-tnpH"]));
  if (!out) return peers;
  for (const line of out.split("\n")) {
    // ESTAB 0 0 <local> <peer> users:(("name",pid=NNN,fd=NNN))
    const m = line.match(
      /^\s*ESTAB\s+\d+\s+\d+\s+(\S+)\s+\S+\s+users:\(\("([^"]+)",pid=(\d+)/
    );
    if (!m) continue;
    const [, local, command, pidStr] = m;
    peers[local!] = { command: command!, pid: Number(pidStr) };
  }
  return peers;
}

async function readSystemInfo(): Promise<unknown> {
  const result: Record<string, unknown> = {
    gpu: null,
    loadavg: null,
    uptime_seconds: null,
  };

  // GPU via nvidia-smi (Linux/Windows)
  try {
    const proc = Bun.spawn(
      [
        "nvidia-smi",
        "--query-gpu=name,utilization.gpu,utilization.memory,memory.used,memory.total,temperature.gpu,utilization.encoder,utilization.decoder",
        "--format=csv,noheader,nounits",
      ],
      { stdout: "pipe", stderr: "pipe" }
    );
    const out = await new Response(proc.stdout).text();
    if ((await proc.exited) === 0 && out.trim()) {
      const firstLine = out.trim().split("\n")[0]!;
      const parts = firstLine.split(",").map((s) => s.trim());
      const [name, gpu, mem, used, total, temp, enc, dec] = parts;
      result.gpu = {
        name,
        utilization: {
          gpu: Number(gpu),
          memory: Number(mem),
          encoder: Number(enc),
          decoder: Number(dec),
        },
        memory: { used_mb: Number(used), total_mb: Number(total) },
        temperature_c: Number(temp),
      };
    }
  } catch {
    // nvidia-smi unavailable (e.g. Windows dev box without drivers); leave null
  }

  // Linux-only /proc files; ignore on other platforms.
  try {
    const loadavg = await Bun.file("/proc/loadavg").text();
    const parts = loadavg.trim().split(/\s+/).slice(0, 3).map(Number);
    result.loadavg = { m1: parts[0], m5: parts[1], m15: parts[2] };
  } catch {}

  try {
    const uptime = await Bun.file("/proc/uptime").text();
    result.uptime_seconds = parseFloat(uptime.trim().split(/\s+/)[0]!);
  } catch {}

  return result;
}

// --- Snapshot cache: one recent JPEG per path, refreshed lazily on hover ---
interface SnapEntry {
  jpeg: Uint8Array;
  ts: number;
}
// Snapshots are pre-warmed every PREWARM_MS in the background so a hover
// serves from cache instantly. TTL is a bit longer than the pre-warm
// interval so on-demand requests between pre-warms still hit the cache.
const SNAP_TTL_MS = 75_000;
const PREWARM_MS = 60_000;
const snapCache = new Map<string, SnapEntry>();
const snapInflight = new Map<string, Promise<Uint8Array | null>>();

async function grabSnapshot(
  snapshotBase: string,
  path: string,
  force = false
): Promise<Uint8Array | null> {
  // Validate path: only word chars, dashes, and single slashes (raw/bay-1).
  if (!/^[\w-]+(\/[\w-]+)*$/.test(path)) return null;

  const cached = snapCache.get(path);
  // Date.now() is fine here — this is a server-side cache, not a workflow.
  const now = Date.now();
  if (!force && cached && now - cached.ts < SNAP_TTL_MS) return cached.jpeg;

  let inflight = snapInflight.get(path);
  if (!inflight) {
    // stitchd renders this from the frame it already holds on the GPU. This
    // used to spawn an ffmpeg per stream, which reconnected over RTSP and
    // decoded a full frame (up to 2688x1512) to produce a 320px thumbnail —
    // 16 processes a minute once the raw cameras were listed.
    inflight = (async () => {
      try {
        const r = await fetch(snapshotBase + path);
        if (!r.ok) return null;
        const buf = new Uint8Array(await r.arrayBuffer());
        if (buf.length === 0) return null;
        snapCache.set(path, { jpeg: buf, ts: Date.now() });
        return buf;
      } catch {
        return null;
      }
    })();
    snapInflight.set(path, inflight);
    inflight.finally(() => snapInflight.delete(path));
  }
  return inflight;
}

/**
 * Player page for an HLS stream, served at /hls/<name> (and, through the public
 * Caddy mount, at /all-field). The pre-stitchd stack served an equivalent page and the
 * scoreboard embed points at that URL, so we owe one.
 *
 * Every URL is derived from location.pathname at runtime rather than baked in,
 * so the same page works mounted at /hls/<name> on the LAN or at /<name>
 * behind the reverse proxy. That is also why hls.js is injected by script
 * rather than a static <script src>: a relative src resolves differently under
 * the two mounts, and an absolute one would be wrong under at least one.
 */
const hlsPlayerHtml = readWebAsset("player.html");

export function startDashboard(
  dashboard: Dashboard,
  /** stitchd's status endpoint — the only source of stream state. */
  statusUrl: string,
  transcription?: { ring: RingBuffer; stats: LiveStats },
  /** Directory stitchd writes HLS segments into; served at /hls/<name>/... */
  hlsDir?: string
): Server<undefined> {
  const stitchdApi = statusUrl;
  // Same server, different route.
  const snapshotBase = statusUrl.replace(/\/api\/status$/, "") + "/api/snapshot/";
  // Cache of the last status payload so the sessions endpoint can serve from
  // the same fetch the paths table already makes, instead of hitting stitchd
  // twice per poll.
  let lastSessions: { peer: string; stream: string; via: string }[] = [];

  const fetchPaths = async (): Promise<Response> => {
    const r = await fetch(stitchdApi);
    if (!r.ok) return r;
    const j = (await r.json()) as {
      items?: { name: string; ready?: boolean; codec?: string; width?: number; height?: number; dropped?: number; kind?: string }[];
      sessions?: { peer: string; stream: string; via: string }[];
      rtspClients?: number;
      webrtcViewers?: number;
    };
    lastSessions = j.sessions ?? [];
    const items = (j.items ?? []).map((it) => ({
      name: it.name,
      ready: it.ready ?? true,
      // stitchd is the only publisher now, and it never leaves a path
      // sourceless while running.
      source: { type: "stitchd" },
      tracks: [it.codec === "hevc" ? "H265" : "H264"],
      readers: [] as unknown[],
      bytesReceived: 0,
      bytesSent: 0,
      width: it.width,
      height: it.height,
      dropped: it.dropped ?? 0,
      // "raw" = a camera republished verbatim; "output" = a composite stitchd
      // encodes. Raw paths exist on RTSP only — stitchd registers WebRTC and
      // writes HLS for the encoded outputs, so offering those links on a raw
      // row would just hand the user two dead ends.
      kind: it.kind ?? "output",
    }));
    return new Response(
      JSON.stringify({ items, rtspClients: j.rtspClients ?? 0, webrtcViewers: j.webrtcViewers ?? 0 }),
      { headers: { "content-type": "application/json" } }
    );
  };
  const { hostname, port } = parseAddress(dashboard.address);

  // Background snapshot pre-warm: every PREWARM_MS, refresh a cached frame
  // for each ready path so hovers in the dashboard load instantly. Serial
  // Best-effort — failures are ignored. Now that stitchd renders these from
  // memory a cold hover would be fast anyway, but keeping the cache warm means
  // the hover is instant and costs one small GET per stream per minute.
  {
    const prewarm = async () => {
      try {
        const r = await fetchPaths();
        if (!r.ok) return;
        const j = (await r.json()) as { items?: { name: string; ready?: boolean }[] };
        for (const p of j.items ?? []) {
          if (!p.ready) continue;
          await grabSnapshot(snapshotBase, p.name, true);
        }
      } catch {
        // ignore
      }
    };
    setTimeout(prewarm, 5000);
    setInterval(prewarm, PREWARM_MS);
  }

  const server = Bun.serve({
    hostname,
    port,
    async fetch(req) {
      const url = new URL(req.url);

      // HLS: /hls/<output>/<file>. stitchd writes fMP4 segments to disk and
      // we serve them from the HTTP server we already run — no second server,
      // and no extra copy of the media (the files ARE the stream).
      if (hlsDir && url.pathname.startsWith("/hls/")) {
        const rel = decodeURIComponent(url.pathname.slice("/hls/".length));
        // Path traversal guard: reject anything that escapes hlsDir. These
        // segments are reachable from the LAN, so ".." must not become a
        // file-read primitive over the whole container.
        if (rel.includes("..") || rel.startsWith("/")) {
          return new Response("bad path", { status: 400 });
        }

        // The hls.js bundle, requested by the player page below as
        // <base>/hls.js so it resolves under whatever prefix we're mounted at
        // (/hls/<name>/ on the LAN, /all-field/ through the public Caddy
        // mount). Served from node_modules rather than vendored into the repo
        // or pulled from a CDN — the public scoreboard should not depend on a
        // third party being reachable.
        if (rel === "hls.js" || rel.endsWith("/hls.js")) {
          // Anchored to this module, not the process CWD: the container runs
          // from /opt/restitch today but nothing guarantees that.
          const lib = Bun.file(
            `${import.meta.dir}/../node_modules/hls.js/dist/hls.min.js`
          );
          if (!(await lib.exists())) {
            return new Response("hls.js not installed", { status: 500 });
          }
          return new Response(lib, {
            headers: {
              "content-type": "text/javascript",
              "cache-control": "max-age=86400",
              "access-control-allow-origin": "*",
            },
          });
        }

        // A bare stream name (no file component) is a browser asking to watch,
        // not to fetch a segment. The pre-stitchd stack served a player page here and the
        // public mount still points at it; without this the URL 404s because
        // Bun.file() on a directory is not a readable file.
        const bare = rel.replace(/\/+$/, "");
        if (bare && !bare.includes("/")) {
          return new Response(hlsPlayerHtml, {
            headers: {
              "content-type": "text/html; charset=utf-8",
              "cache-control": "no-cache",
            },
          });
        }

        const file = Bun.file(`${hlsDir}/${rel}`);
        if (!(await file.exists())) return new Response("not found", { status: 404 });
        const type = rel.endsWith(".m3u8")
          ? "application/vnd.apple.mpegurl"
          : rel.endsWith(".mp4") || rel.endsWith(".m4s")
            ? "video/mp4"
            : "application/octet-stream";
        return new Response(file, {
          headers: {
            "content-type": type,
            // Playlists change every segment; segments are immutable once
            // written, but the rolling window deletes them, so keep it short.
            "cache-control": rel.endsWith(".m3u8") ? "no-cache" : "max-age=10",
            "access-control-allow-origin": "*",
          },
        });
      }

      // Snapshot: /api/snapshot/<path> (path may contain a slash)
      if (url.pathname.startsWith("/api/snapshot/")) {

        const path = decodeURIComponent(
          url.pathname.slice("/api/snapshot/".length)
        );
        const jpeg = await grabSnapshot(snapshotBase, path);
        if (!jpeg) return new Response("no frame", { status: 502 });
        return new Response(jpeg, {
          headers: {
            "content-type": "image/jpeg",
            "cache-control": "no-cache",
          },
        });
      }

      switch (url.pathname) {
        case "/":
        case "/index.html":
          return new Response(HTML, {
            headers: { "content-type": "text/html; charset=utf-8" },
          });
        case "/api/paths":
          return fetchPaths();
        case "/api/rtsp": {
          // Served from the status payload the paths table already fetched.
          await fetchPaths();
            return new Response(
              JSON.stringify({
                items: lastSessions
                  .filter((x) => x.via.startsWith("rtsp"))
                  .map((x) => ({
                  remoteAddr: x.peer,
                  state: "read",
                  path: x.stream,
                  transport: x.via,
                  bytesReceived: 0,
                  bytesSent: 0,
                })),
              }),
              { headers: { "content-type": "application/json" } }
            );
        }
        case "/api/webrtc": {
          await fetchPaths();
            return new Response(
              JSON.stringify({
                items: lastSessions
                  .filter((x) => x.via.startsWith("webrtc"))
                  .map((x) => ({
                    remoteAddr: x.peer,
                    state: x.via.split("/")[1] ?? "unknown",
                    path: x.stream,
                    bytesReceived: 0,
                    bytesSent: 0,
                  })),
              }),
              { headers: { "content-type": "application/json" } }
            );
        }
        case "/api/hls":
          // stitchd exposes aggregate counts via /api/status; per-session HLS
          // detail is not tracked, so return an empty list.
          return new Response('{"items":[]}', { headers: { "content-type": "application/json" } });
        case "/api/system":
          return Response.json(await readSystemInfo());
        case "/api/peers":
          return Response.json(await readPeers());
        case "/api/transcriptions": {
          if (!transcription) return Response.json({ items: [], counts: {}, contributor_counts: {} });
          const limit = Math.max(
            1,
            Math.min(500, parseInt(url.searchParams.get("limit") ?? "100", 10))
          );
          return Response.json({
            items: transcription.ring.recent(limit),
            counts: transcription.ring.countByCamera(),
            contributor_counts: transcription.ring.contributorCountByCamera(),
          });
        }
        case "/api/transcription-stats":
          return transcription
            ? Response.json(transcription.stats)
            : new Response("disabled", { status: 503 });
        default:
          return new Response("Not found", { status: 404 });
      }
    },
  });

  return server;
}
