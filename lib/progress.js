// ─── ANALYZE PROGRESS PUB/SUB (Server-Sent Events) ───────────────────────────
// Lightweight in-memory channel, one per analyze run, keyed by the same runId
// used for cancellation. The /api/analyze handler emits real pipeline events
// as each stage completes; the browser subscribes over SSE so the progress UI
// reflects what's actually happening instead of a fixed timer.
//
// There's an inherent race: the client opens the SSE stream and POSTs /analyze
// as two separate requests, so a few events can be emitted before the stream
// connects. Each channel buffers its events and replays them to a late
// subscriber, so nothing is missed.

const channels = new Map(); // runId -> { clients: Set<res>, buffer: [event], closed: bool }

function getChannel(runId) {
  let ch = channels.get(runId);
  if (!ch) {
    ch = { clients: new Set(), buffer: [], closed: false };
    channels.set(runId, ch);
  }
  return ch;
}

function writeEvent(res, ev) {
  try { res.write(`data: ${JSON.stringify(ev)}\n\n`); } catch (_) { /* socket gone — ignore */ }
}

// Register an SSE response for a run and replay anything already emitted.
// Returns an unsubscribe function.
function subscribe(runId, res) {
  const ch = getChannel(runId);
  ch.clients.add(res);
  for (const ev of ch.buffer) writeEvent(res, ev);
  return () => { ch.clients.delete(res); };
}

// Emit a progress event to every connected client and buffer it for replay.
function emit(runId, ev) {
  if (!runId) return;
  const ch = getChannel(runId);
  if (ch.closed) return;
  ch.buffer.push(ev);
  if (ch.buffer.length > 200) ch.buffer.shift(); // guard against unbounded growth
  for (const res of ch.clients) writeEvent(res, ev);
}

// Terminate a run's stream. Ends every connected client and drops the channel
// after a short grace period so a just-connected subscriber can still replay
// the terminal event.
function close(runId) {
  const ch = channels.get(runId);
  if (!ch) return;
  ch.closed = true;
  for (const res of ch.clients) { try { res.end(); } catch (_) {} }
  ch.clients.clear();
  const t = setTimeout(() => channels.delete(runId), 5000);
  if (t.unref) t.unref();
}

module.exports = { subscribe, emit, close };
