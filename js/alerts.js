/**
 * VigilXplr Alert Engine
 * Web Audio API tones inspired by operational / EOC dashboards (Montco-style).
 * Distinct tones for fatal / serious / update events.
 */
(function () {
  const AudioCtx = window.AudioContext || window.webkitAudioContext;
  let ctx = null;
  let enabled = true;

  function ensureCtx() {
    if (!ctx) ctx = new AudioCtx();
    if (ctx.state === 'suspended') ctx.resume();
    return ctx;
  }

  function tone(freq, type, duration, gainValue = 0.15, ramp = 0.02) {
    const ac = ensureCtx();
    const osc = ac.createOscillator();
    const gain = ac.createGain();
    osc.type = type;
    osc.frequency.value = freq;
    gain.gain.setValueAtTime(0, ac.currentTime);
    gain.gain.linearRampToValueAtTime(gainValue, ac.currentTime + ramp);
    gain.gain.exponentialRampToValueAtTime(0.001, ac.currentTime + duration);
    osc.connect(gain);
    gain.connect(ac.destination);
    osc.start();
    osc.stop(ac.currentTime + duration + 0.05);
  }

  function whoop(startFreq, endFreq, duration, steps = 8) {
    const ac = ensureCtx();
    const osc = ac.createOscillator();
    const gain = ac.createGain();
    osc.type = 'sawtooth';
    gain.gain.value = 0.12;
    osc.connect(gain);
    gain.connect(ac.destination);
    const now = ac.currentTime;
    osc.frequency.setValueAtTime(startFreq, now);
    for (let i = 1; i <= steps; i++) {
      const t = now + (duration * i) / steps;
      const f = startFreq + ((endFreq - startFreq) * i) / steps;
      osc.frequency.linearRampToValueAtTime(f, t);
    }
    gain.gain.setValueAtTime(0.12, now);
    gain.gain.exponentialRampToValueAtTime(0.001, now + duration);
    osc.start(now);
    osc.stop(now + duration + 0.05);
  }

  const Alerts = {
    setEnabled(v) {
      enabled = !!v;
      try { localStorage.setItem('vigil_alerts', enabled ? '1' : '0'); } catch (_) {}
    },
    isEnabled() {
      try {
        const s = localStorage.getItem('vigil_alerts');
        if (s !== null) enabled = s === '1';
      } catch (_) {}
      return enabled;
    },
    playFatal() {
      if (!enabled) return;
      whoop(400, 900, 0.6);
      setTimeout(() => whoop(400, 900, 0.6), 700);
      setTimeout(() => tone(880, 'square', 0.25, 0.1), 1400);
    },
    playSerious() {
      if (!enabled) return;
      tone(660, 'triangle', 0.2, 0.14);
      setTimeout(() => tone(520, 'triangle', 0.25, 0.12), 220);
    },
    playUpdate() {
      if (!enabled) return;
      tone(880, 'sine', 0.12, 0.1);
      setTimeout(() => tone(1100, 'sine', 0.15, 0.08), 130);
    },
    playNewEvent(severity) {
      if (!enabled) return;
      if (severity === 'Fatal') this.playFatal();
      else if (severity === 'Serious') this.playSerious();
      else this.playUpdate();
    }
  };

  Alerts.isEnabled(); // hydrate from storage
  window.VigilAlerts = Alerts;
})();
