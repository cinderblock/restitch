// WHEP player page.
//
// mediamtx served an HTML player at the same URL that took the WHEP POST, and
// the public mount depends on that: the pFMS scoreboard embeds
// stream.tomsawyerlabs.com/webrtc/all-field?token=... in a cross-origin iframe
// and expects a page, not a 404. Serving our own keeps that URL contract
// unchanged so the Caddy front end stays a pure path rewrite.
//
// It is a string constant rather than a file on disk because stitchd is
// deployed as a single static binary — a sibling asset would be one more thing
// to install and one more way for the endpoint to half-work.

#pragma once

namespace webrtc {

// Derives the stream from location.pathname, so one page serves every mount
// (/whep/<name> directly, /webrtc/<name> through Caddy) with no substitution.
inline constexpr const char *kPlayerHtml = R"PLAYER(<!doctype html>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>stitchd</title>
<style>
  html, body { margin: 0; height: 100%; background: #000; overflow: hidden; }
  video { width: 100%; height: 100%; object-fit: contain; display: block; }
  #msg {
    position: absolute; left: 0; right: 0; top: 50%; transform: translateY(-50%);
    text-align: center; pointer-events: none; color: #999;
    font: 13px system-ui, sans-serif;
  }
</style>
<video id="v" autoplay muted playsinline controls></video>
<div id="msg">connecting…</div>
<script>
const v = document.getElementById('v');
const msg = document.getElementById('msg');
let pc = null, attempts = 0, timer = null;

const say = t => { msg.textContent = t || ''; };

function teardown() {
  if (timer) { clearTimeout(timer); timer = null; }
  if (pc) { try { pc.close(); } catch (e) {} pc = null; }
}

// The stream is expected to outlive any single viewer, so a dropped session is
// a transient to ride out, not an error to surface and stop at. Backoff caps at
// 30s: this page sits unattended on a scoreboard for hours.
function retry(why) {
  teardown();
  attempts++;
  const wait = Math.min(30000, 500 * 2 ** Math.min(attempts, 6));
  say(why + ' — retrying in ' + Math.round(wait / 1000) + 's');
  timer = setTimeout(connect, wait);
}

async function connect() {
  teardown();
  say('connecting…');
  try {
    pc = new RTCPeerConnection({
      iceServers: [{ urls: 'stun:stun.l.google.com:19302' }],
    });
    const self = pc;
    pc.addTransceiver('video', { direction: 'recvonly' });
    pc.ontrack = e => { v.srcObject = e.streams[0]; };
    pc.onconnectionstatechange = () => {
      if (pc !== self) return;
      if (pc.connectionState === 'connected') { attempts = 0; say(''); }
      else if (['failed', 'disconnected', 'closed'].includes(pc.connectionState))
        retry(pc.connectionState);
    };

    await pc.setLocalDescription(await pc.createOffer());

    // stitchd answers once, fully gathered, and implements no PATCH — so there
    // is nowhere to trickle candidates to. Send a complete offer instead of a
    // stub, and give up waiting after 3s rather than stalling on a network
    // where some candidate type never resolves.
    await new Promise(done => {
      if (self.iceGatheringState === 'complete') return done();
      const t = setTimeout(done, 3000);
      self.onicegatheringstatechange = () => {
        if (self.iceGatheringState === 'complete') { clearTimeout(t); done(); }
      };
    });
    if (pc !== self) return;

    // Keep the query string: the public mount is gated on ?token=, and this
    // POST goes back through the same gate. (mediamtx's player did the same,
    // which is why one token in the iframe URL covers the whole exchange.)
    const r = await fetch(location.pathname + location.search, {
      method: 'POST',
      headers: { 'Content-Type': 'application/sdp' },
      body: self.localDescription.sdp,
    });
    if (pc !== self) return;
    if (!r.ok) return retry('server said ' + r.status);
    await self.setRemoteDescription({ type: 'answer', sdp: await r.text() });
  } catch (e) {
    retry(String((e && e.message) || e));
  }
}

connect();
</script>
)PLAYER";

} // namespace webrtc
