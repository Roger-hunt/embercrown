// Test-only page instrumentation: tee everything that reaches the AudioContext destination into an analyser,
// and log every oscillator / buffer-source start so tests can see which sounds were produced and how loud.
module.exports = () => {
  const AC0 = window.AudioContext || window.webkitAudioContext;
  window.__audio = { ctxs: [], starts: [], plays: [] };
  const origConnect = AudioNode.prototype.connect;
  AudioNode.prototype.connect = function (dest, ...rest) {
    const r = origConnect.call(this, dest, ...rest);
    try {
      if (dest && dest === this.context.destination) {
        let an = this.context.__an;
        if (!an) { an = this.context.__an = this.context.createAnalyser(); an.fftSize = 2048; window.__audio.ctxs.push(this.context); }
        origConnect.call(this, an);
      }
    } catch (e) {}
    return r;
  };
  const oStart = OscillatorNode.prototype.start;
  OscillatorNode.prototype.start = function (when) { window.__audio.starts.push({ k: 'osc', type: this.type, f: Math.round(this.frequency.value), at: +(when || 0).toFixed(3), now: +this.context.currentTime.toFixed(3) }); return oStart.apply(this, arguments); };
  const bStart = AudioBufferSourceNode.prototype.start;
  AudioBufferSourceNode.prototype.start = function (when) { window.__audio.starts.push({ k: 'buf', dur: this.buffer ? +this.buffer.duration.toFixed(2) : 0, loop: this.loop, at: +(when || 0).toFixed(3), now: +this.context.currentTime.toFixed(3) }); return bStart.apply(this, arguments); };
  const play0 = HTMLMediaElement.prototype.play;
  HTMLMediaElement.prototype.play = function () { const src = (this.currentSrc || this.src || '').split('/').pop(); const p = play0.apply(this, arguments); const rec = { src, ok: null, err: '' }; window.__audio.plays.push(rec); if (p && p.then) p.then(() => { rec.ok = true; }, e => { rec.ok = false; rec.err = e.name; }); return p; };
  // RMS / peak of the summed output over a time window (ms), sampled every animation frame
  window.__measure = ms => new Promise(res => {
    const ctx = window.__audio.ctxs[0]; if (!ctx || !ctx.__an) return res({ rms: 0, peak: 0, state: ctx ? ctx.state : 'none' });
    const an = ctx.__an, buf = new Float32Array(an.fftSize); let sum = 0, n = 0, peak = 0; const t0 = performance.now();
    (function tick() { an.getFloatTimeDomainData(buf); for (let i = 0; i < buf.length; i++) { const v = buf[i]; sum += v * v; n++; if (Math.abs(v) > peak) peak = Math.abs(v); }
      if (performance.now() - t0 >= ms) res({ rms: +Math.sqrt(sum / Math.max(1, n)).toFixed(4), peak: +peak.toFixed(3), state: ctx.state }); else setTimeout(tick, 12); })();
  });
};
