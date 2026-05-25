import type { Server } from "bun";
import type { Dashboard } from "./config.ts";

const HTML = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>restitch</title>
<style>
  :root {
    --bg: #0e0f12;
    --panel: #15171c;
    --border: #2a2d35;
    --text: #d8dce4;
    --muted: #777e8a;
    --accent: #6cb8ff;
    --good: #5dd590;
    --bad: #e07a7a;
    --warn: #e5c67a;
  }
  * { box-sizing: border-box; }
  body { font: 14px/1.4 -apple-system, "Segoe UI", system-ui, sans-serif; background: var(--bg); color: var(--text); margin: 0; padding: 16px; }
  h2 { font-size: 12px; text-transform: uppercase; letter-spacing: 1px; color: var(--muted); margin: 0 0 10px; font-weight: 600; }
  .panel { background: var(--panel); border: 1px solid var(--border); border-radius: 6px; padding: 12px 14px; margin-bottom: 16px; }
  .row { display: flex; gap: 16px; flex-wrap: wrap; }
  .stat { flex: 1 1 140px; min-width: 140px; }
  .stat .label { color: var(--muted); font-size: 11px; text-transform: uppercase; letter-spacing: 0.5px; }
  .stat .value { font-size: 17px; font-weight: 600; margin-top: 2px; font-variant-numeric: tabular-nums; }
  .bar { height: 3px; background: #1f2128; border-radius: 2px; margin-top: 6px; overflow: hidden; }
  .bar > div { height: 100%; background: var(--accent); transition: width 0.3s; }
  table { width: 100%; border-collapse: collapse; }
  th, td { text-align: left; padding: 6px 10px; border-bottom: 1px solid var(--border); }
  tr:last-child td { border-bottom: none; }
  th { color: var(--muted); font-size: 11px; text-transform: uppercase; letter-spacing: 0.5px; font-weight: 600; }
  td.num { text-align: right; font-variant-numeric: tabular-nums; }
  .pill { display: inline-block; font-size: 10px; padding: 2px 8px; border-radius: 10px; font-weight: 600; text-transform: uppercase; letter-spacing: 0.5px; }
  .pill.good { color: var(--good); background: rgba(93,213,144,0.12); }
  .pill.bad { color: var(--bad); background: rgba(224,122,122,0.12); }
  .pill.warn { color: var(--warn); background: rgba(229,198,122,0.12); }
  .pill.muted { color: var(--muted); background: rgba(119,126,138,0.12); }
  header { display: flex; justify-content: space-between; align-items: baseline; margin-bottom: 14px; }
  header h1 { font-size: 17px; font-weight: 600; margin: 0; }
  header h1 .sub { color: var(--muted); font-weight: 400; margin-left: 6px; }
  header .updated { color: var(--muted); font-size: 12px; }
  code { font: 13px/1 "JetBrains Mono", Consolas, "Courier New", monospace; color: var(--accent); }
  .empty { color: var(--muted); text-align: center; padding: 12px; font-style: italic; }
</style>
</head>
<body>
<header>
  <h1>restitch <span class="sub">— sentinel</span></h1>
  <div class="updated" id="updated">connecting…</div>
</header>

<div class="panel">
  <h2>System</h2>
  <div class="row" id="system"></div>
</div>

<div class="panel">
  <h2>Streams</h2>
  <table>
    <thead><tr><th>Name</th><th>State</th><th>Source</th><th>Tracks</th><th class="num">RX</th><th class="num">TX</th><th class="num">Bitrate</th><th class="num">Readers</th></tr></thead>
    <tbody id="paths"></tbody>
  </table>
</div>

<div class="panel">
  <h2>Active sessions</h2>
  <table>
    <thead><tr><th>Protocol</th><th>Path</th><th>Direction</th><th>Peer</th><th class="num">Bytes</th></tr></thead>
    <tbody id="sessions"></tbody>
  </table>
</div>

<script>
const fmtBytes = b => {
  if (!b) return '0';
  const u = ['B', 'KB', 'MB', 'GB', 'TB'];
  let i = 0; let v = b;
  while (v >= 1024 && i < u.length - 1) { v /= 1024; i++; }
  return v.toFixed(v < 10 ? 1 : 0) + ' ' + u[i];
};
const fmtBps = bytesPerSec => {
  const bits = bytesPerSec * 8;
  if (bits < 1000) return bits.toFixed(0) + ' bps';
  if (bits < 1e6) return (bits / 1e3).toFixed(1) + ' Kbps';
  if (bits < 1e9) return (bits / 1e6).toFixed(1) + ' Mbps';
  return (bits / 1e9).toFixed(2) + ' Gbps';
};
const fmtUptime = s => {
  if (s == null) return '—';
  const d = Math.floor(s / 86400);
  const h = Math.floor(s / 3600) % 24;
  const m = Math.floor(s / 60) % 60;
  if (d > 0) return d + 'd ' + h + 'h ' + m + 'm';
  if (h > 0) return h + 'h ' + m + 'm';
  return m + 'm';
};

function stat(label, value, percent) {
  const bar = percent != null ? '<div class="bar"><div style="width: ' + Math.min(100, percent) + '%"></div></div>' : '';
  return '<div class="stat"><div class="label">' + label + '</div><div class="value">' + value + '</div>' + bar + '</div>';
}

let prev = new Map();
let prevTs = 0;

async function tick() {
  try {
    const [paths, rtsp, webrtc, hls, sys, peers] = await Promise.all([
      fetch('api/paths').then(r => r.json()),
      fetch('api/rtsp').then(r => r.json()),
      fetch('api/webrtc').then(r => r.json()),
      fetch('api/hls').then(r => r.json()),
      fetch('api/system').then(r => r.json()),
      fetch('api/peers').then(r => r.json()),
    ]);
    const now = Date.now();
    const dt = prevTs ? (now - prevTs) / 1000 : 1;

    // System
    const g = sys.gpu;
    let html = '';
    if (g) {
      html += stat('GPU', g.utilization.gpu + '%', g.utilization.gpu);
      html += stat('NVENC', g.utilization.encoder + '%', g.utilization.encoder);
      html += stat('NVDEC', g.utilization.decoder + '%', g.utilization.decoder);
      const vramPct = g.memory.used_mb / g.memory.total_mb * 100;
      html += stat('VRAM', (g.memory.used_mb/1024).toFixed(1) + ' / ' + (g.memory.total_mb/1024).toFixed(0) + ' GB', vramPct);
      html += stat('GPU temp', g.temperature_c + '°C', null);
    } else {
      html += stat('GPU', 'N/A', null);
    }
    if (sys.loadavg) {
      html += stat('Load 1m / 5m / 15m', sys.loadavg.m1.toFixed(2) + '  ' + sys.loadavg.m5.toFixed(2) + '  ' + sys.loadavg.m15.toFixed(2), null);
    }
    if (sys.uptime_seconds != null) {
      html += stat('Host uptime', fmtUptime(sys.uptime_seconds), null);
    }
    document.getElementById('system').innerHTML = html;

    // Paths
    const pathRows = (paths.items || []).map(p => {
      const prevP = prev.get(p.name);
      const bps = prevP && dt > 0 ? Math.max(0, (p.bytesSent - prevP.bytesSent) / dt) : 0;
      const readerCount = (p.readers || []).length;
      const ready = p.ready
        ? '<span class="pill good">ready</span>'
        : '<span class="pill bad">down</span>';
      const sourceLabel = p.source
        ? '<span class="pill warn">' + p.source.type + '</span>'
        : '<span class="pill muted">publisher</span>';
      const tracks = (p.tracks || []).join(', ') || '—';
      return '<tr>'
        + '<td><code>' + p.name + '</code></td>'
        + '<td>' + ready + '</td>'
        + '<td>' + sourceLabel + '</td>'
        + '<td style="color: var(--muted); font-size: 12px;">' + tracks + '</td>'
        + '<td class="num">' + fmtBytes(p.bytesReceived) + '</td>'
        + '<td class="num">' + fmtBytes(p.bytesSent) + '</td>'
        + '<td class="num">' + fmtBps(bps) + '</td>'
        + '<td class="num">' + readerCount + '</td>'
        + '</tr>';
    });
    document.getElementById('paths').innerHTML = pathRows.join('')
      || '<tr><td colspan="8" class="empty">no paths configured</td></tr>';

    // Sessions
    const all = [];
    for (const s of rtsp.items || []) all.push({ proto: 'RTSP', ...s });
    for (const s of webrtc.items || []) all.push({ proto: 'WebRTC', ...s });
    for (const s of hls.items || []) all.push({ proto: 'HLS', ...s, state: 'reading' });
    const peerLabel = remote => {
      if (!remote) return '—';
      const isLocal = remote.startsWith('127.') || remote.startsWith('[::1]') || remote.startsWith('::1');
      if (isLocal && peers[remote]) {
        return '<span style="color: var(--accent);">' + peers[remote].command + '</span>'
          + ' <span style="color: var(--muted); font-size: 11px;">pid ' + peers[remote].pid + '</span>';
      }
      return '<code>' + remote + '</code>';
    };
    const sessRows = all.map(s => '<tr>'
      + '<td><span class="pill warn">' + s.proto + '</span></td>'
      + '<td><code>' + (s.path || '—') + '</code></td>'
      + '<td style="color: var(--muted); font-size: 12px;">' + (s.state || '—') + '</td>'
      + '<td style="font-size: 12px;">' + peerLabel(s.remoteAddr) + '</td>'
      + '<td class="num">' + fmtBytes((s.bytesSent || 0) + (s.bytesReceived || 0)) + '</td>'
      + '</tr>');
    document.getElementById('sessions').innerHTML = sessRows.join('')
      || '<tr><td colspan="5" class="empty">no active sessions</td></tr>';

    prev = new Map((paths.items || []).map(p => [p.name, p]));
    prevTs = now;
    document.getElementById('updated').textContent = 'updated ' + new Date(now).toLocaleTimeString();
  } catch (e) {
    document.getElementById('updated').textContent = 'error: ' + (e && e.message ? e.message : String(e));
  }
}

tick();
setInterval(tick, 2000);
</script>
</body>
</html>
`;

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
 * Calls `sudo ss` non-interactively. cameron has NOPASSWD on sentinel, so
 * this never blocks; on a host without that, the call fails silently and
 * the dashboard falls back to showing the raw address.
 */
async function readPeers(): Promise<Record<string, { command: string; pid: number }>> {
  const peers: Record<string, { command: string; pid: number }> = {};
  try {
    const proc = Bun.spawn(["sudo", "-n", "ss", "-tnpH"], {
      stdout: "pipe",
      stderr: "pipe",
    });
    const out = await new Response(proc.stdout).text();
    if ((await proc.exited) !== 0) return peers;
    for (const line of out.split("\n")) {
      // ESTAB 0 0 <local> <peer> users:(("name",pid=NNN,fd=NNN))
      const m = line.match(
        /^\s*ESTAB\s+\d+\s+\d+\s+(\S+)\s+\S+\s+users:\(\("([^"]+)",pid=(\d+)/
      );
      if (!m) continue;
      const [, local, command, pidStr] = m;
      peers[local!] = { command: command!, pid: Number(pidStr) };
    }
  } catch {
    // sudo / ss unavailable — return what we have (empty).
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

export function startDashboard(dashboard: Dashboard): Server {
  const apiBase = dashboard.mediamtx_api_url.replace(/\/$/, "");
  const { hostname, port } = parseAddress(dashboard.address);

  const server = Bun.serve({
    hostname,
    port,
    async fetch(req) {
      const url = new URL(req.url);
      switch (url.pathname) {
        case "/":
        case "/index.html":
          return new Response(HTML, {
            headers: { "content-type": "text/html; charset=utf-8" },
          });
        case "/api/paths":
          return proxyJson(`${apiBase}/v3/paths/list`);
        case "/api/rtsp":
          return proxyJson(`${apiBase}/v3/rtspsessions/list`);
        case "/api/webrtc":
          return proxyJson(`${apiBase}/v3/webrtcsessions/list`);
        case "/api/hls":
          return proxyJson(`${apiBase}/v3/hlsmuxers/list`);
        case "/api/system":
          return Response.json(await readSystemInfo());
        case "/api/peers":
          return Response.json(await readPeers());
        default:
          return new Response("Not found", { status: 404 });
      }
    },
  });

  return server;
}
