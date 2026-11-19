// enov-dsp.js
class EnovVoiceCore extends AudioWorkletProcessor {
  static get parameterDescriptors() {
    return [
      { name: 'trim',     defaultValue: 1.0, minValue: 0, maxValue: 40 },
      { name: 'depth',    defaultValue: 0.0, minValue: 0, maxValue: 100 },  // "121" = deep voice amount
      { name: 'body',     defaultValue: 0.0, minValue: 0, maxValue: 100 },
      { name: 'air',      defaultValue: 0.0, minValue: 0, maxValue: 100 },
      { name: 'space',    defaultValue: 0.0, minValue: 0, maxValue: 100 },
      { name: 'width',    defaultValue: 1.0, minValue: 0, maxValue: 3 },
      { name: 'mix',      defaultValue: 1.0, minValue: 0, maxValue: 1 },
    ];
  }

  constructor() {
    super();

    // --- Pitch shifter state ---
    // খাঁটি রিয়েল-টাইম granular pitch shift with formant preservation
    this._bufN = 65536;
    this._bufL = new Float32Array(this._bufN);
    this._bufR = new Float32Array(this._bufN);
    this._wIdx = 0;
    this._read = 0;
    this._grain = 1024;
    this._hop = 512;
    this._phase = 0;
    this._pitchRatio = 1.0;
    this._formantRatio = 1.0;

    // --- Formant filter state (parallel bandpass bank) ---
    this._formantBand = [
      { f: 350,  q: 3.5 },   // low body
      { f: 700,  q: 4.0 },
      { f: 1300, q: 4.5 },
      { f: 2600, q: 5.0 },
    ];
    this._bpL = this._formantBand.map(() => ({ z1:0, z2:0, b0:0, b1:0, b2:0, a1:0, a2:0 }));
    this._bpR = this._formantBand.map(() => ({ z1:0, z2:0, b0:0, b1:0, b2:0, a1:0, a2:0 }));

    // --- DC blocker ---
    this._dcX = 0; this._dcY = 0;

    // --- Presence HPF (simple) ---
    this._hpIn = 0; this._hpOut = 0;

    // --- Dynamics leveler ---
    this._env = 0;
    this._att = Math.exp(-1 / (sampleRate * 0.004));
    this._rel = Math.exp(-1 / (sampleRate * 0.12));

    // --- Reverb (Schroeder) ---
    const combLens = [1116, 1188, 1277, 1356];
    this._combL = combLens.map(n => new Float32Array(n));
    this._combR = combLens.map(n => new Float32Array(n));
    this._combIdx = new Int32Array(4);
    this._lpS = [new Float32Array(4), new Float32Array(4)];
    const apLens = [556, 441];
    this._apL = apLens.map(n => new Float32Array(n));
    this._apR = apLens.map(n => new Float32Array(n));
    this._apIdx = new Int32Array(2);

    this.port.onmessage = (e) => {
      if (e.data && e.data.type === 'tune') {
        this._tune = { ...this._tune, ...e.data };
      }
    };
    this._tune = { pitch: 1.0, formant: 1.0 };
  }

  _softClip(x, k = 0.9) {
    const a = Math.abs(x);
    if (a <= k) return x;
    const s = Math.sign(x);
    const over = a - k;
    return s * (k + (1 - k) * (over / (over + 1 - k)));
  }

  // Simple biquad bandpass coefficient calc (transposed direct form I)
  _calcBP(i) {
    const f = this._formantBand[i].f;
    const q = this._formantBand[i].q;
    const w = 2 * Math.PI * f / sampleRate;
    const cos = Math.cos(w), sin = Math.sin(w);
    const alpha = sin / (2 * q);
    const a0 = 1 + alpha;
    const b = this._bpL[i];
    b.b0 = alpha / a0;
    b.b1 = 0;
    b.b2 = -alpha / a0;
    b.a1 = -2 * cos / a0;
    b.a2 = (1 - alpha) / a0;
    // mirror to R
    const r = this._bpR[i];
    r.b0 = b.b0; r.b1 = b.b1; r.b2 = b.b2; r.a1 = b.a1; r.a2 = b.a2;
  }

  _runBP(state, x) {
    const y = state.b0 * x + state.z1;
    state.z1 = state.b1 * x - state.a1 * y + state.z2;
    state.z2 = state.b2 * x - state.a2 * y;
    return y;
  }

  process(inputs, outputs, params) {
    const inp = inputs[0], out = outputs[0];
    if (!inp || !inp.length || !inp[0].length) return true;

    const chCount = inp.length;
    const frame = inp[0].length;

    // formant ratio update from depth parameter
    const depth = params.depth[0];   // 0-100
    // "121" = 12.1 → we treat slider value as percent so:
    // depth 121 → strong deep voice
    // pitch down up to ~1 octave, formant down up to ~30%
    const pitchAmt  = Math.min(1.0, depth / 100) * 0.5;   // 0 → 0.5 (12 semitones)
    const formantAmt = Math.min(1.0, depth / 100) * 0.30; // 0 → 30% formant shift down

    this._pitchRatio   = Math.pow(2, -pitchAmt);          // < 1 = পিচ নিচে
    this._formantRatio = 1 - formantAmt;                  // < 1 = formant নিচে

    // update formant filter coefficients each block (cheap 4x)
    for (let i = 0; i < this._formantBand.length; i++) {
      const baseF = this._formantBand[i].f * this._formantRatio;
      // clamp
      const f = Math.max(60, Math.min(8000, baseF));
      // store per block
      this._formantBand[i].fNow = f;
    }
    // rebuild coefficients using fNow
    for (let i = 0; i < this._formantBand.length; i++) {
      const f = this._formantBand[i].fNow;
      const q = this._formantBand[i].q;
      const w = 2 * Math.PI * f / sampleRate;
      const cos = Math.cos(w), sin = Math.sin(w);
      const alpha = sin / (2 * q);
      const a0 = 1 + alpha;
      const b = this._bpL[i];
      b.b0 = alpha / a0; b.b1 = 0; b.b2 = -alpha / a0;
      b.a1 = -2 * cos / a0; b.a2 = (1 - alpha) / a0;
      const r = this._bpR[i];
      r.b0 = b.b0; r.b1 = b.b1; r.b2 = b.b2; r.a1 = b.a1; r.a2 = b.a2;
    }

    for (let i = 0; i < frame; i++) {
      const trim = params.trim[0];
      const body = params.body[0] / 100;
      const air  = params.air[0] / 100;
      const space = params.space[0] / 100;
      const width = params.width[0];
      const mix = params.mix[0];

      let L = inp[0][i];
      let R = chCount > 1 ? inp[1][i] : L;
      const dryL = L, dryR = R;

      // 1) DC block
      let dc = L - this._dcX + 0.995 * this._dcY;
      this._dcX = L; this._dcY = dc;
      L = dc;

      // 2) 입력을 ring buffer-এ লেখো (pitch shift-এর জন্য)
      this._bufL[this._wIdx] = L;
      this._bufR[this._wIdx] = R;

      // 3) Granular pitch shift (simple 2-grain crossfade)
      //    দুইটি grain overlapping, একটির read cursor ধীরে এগোয় (pitch < 1)
      const ratio = this._pitchRatio;
      const g = this._grain;
      const h = this._hop;

      // read positions
      const r0 = (this._wIdx - g) & (this._bufN - 1);  // grain A
      const r1 = (this._wIdx - g - h) & (this._bufN - 1); // grain B

      // grain A phase advance by `ratio`, so pitch shift
      const phaseA = (this._phase) % g;
      const phaseB = (this._phase + g / 2) % g;

      // Hann-ish window
      const wA = 0.5 - 0.5 * Math.cos(2 * Math.PI * phaseA / g);
      const wB = 0.5 - 0.5 * Math.cos(2 * Math.PI * phaseB / g);

      const readA = (this._wIdx - g + phaseA) & (this._bufN - 1);
      const readB = (this._wIdx - g + phaseB) & (this._bufN - 1);

      let pL = this._bufL[readA] * wA + this._bufL[readB] * wB;
      let pR = this._bufR[readA] * wA + this._bufR[readB] * wB;

      this._phase += ratio;
      if (this._phase >= g) this._phase -= g;

      // 4) Formant shift — চারটি bandpass-এর সমষ্টি (parallel)
      //    depth বাড়লে formant নিচে সরবে
      let fL = 0, fR = 0;
      for (let k = 0; k < this._formantBand.length; k++) {
        const gain = (k === 0) ? 1.0 : 0.6;
        fL += this._runBP(this._bpL[k], pL) * gain;
        fR += this._runBP(this._bpR[k], pR) * gain;
      }
      // mix dry + formant-shifted (depth-ভিত্তিক)
      const dNorm = Math.min(1, depth / 100);
      pL = pL * (1 - dNorm * 0.35) + fL * (dNorm * 0.35);
      pR = pR * (1 - dNorm * 0.35) + fR * (dNorm * 0.35);

      // 5) Presence HPF (voice boost) — air parameter drives it
      const hpA = 0.62;
      const hpL = hpA * (this._hpOut + L - this._hpIn);
      this._hpIn = L; this._hpOut = hpL;
      const hpMix = air * 0.35;
      L = pL + hpL * hpMix;
      R = pR + hpL * hpMix;

      // 6) Body (low-mid emphasis)
      if (body > 0.001) {
        // simple one-pole LPF at ~300 Hz for "body"
        this._bodyLpL = (this._bodyLpL || 0) + 0.08 * (L - (this._bodyLpL || 0));
        this._bodyLpR = (this._bodyLpR || 0) + 0.08 * (R - (this._bodyLpR || 0));
        L += this._bodyLpL * body * 1.4;
        R += this._bodyLpR * body * 1.4;
      }

      // 7) Trim / leveler
      L *= trim;
      R *= trim;

      const lev = Math.max(Math.abs(L), Math.abs(R));
      if (lev > this._env) this._env = lev + (this._env - lev) * this._att;
      else                this._env = lev + (this._env - lev) * this._rel;

      const th = 0.18;
      if (this._env > th) {
        const over = this._env / th;
        const comp = th * Math.pow(over, 0.15);
        const sc = (comp / this._env) * 3.5;
        L *= sc; R *= sc;
      } else {
        L *= 8; R *= 8;
      }

      // 8) Stereo width (mid/side)
      const mid = (L + R) * 0.5;
      const side = (L - R) * 0.5 * width;
      L = mid + side; R = mid - side;

      // 9) Space (reverb)
      if (space > 0.001) {
        const fb = 0.72 + space * 0.26;
        const damp = 0.32;
        const inL = L, inR = R;
        let wetL = 0, wetR = 0;
        for (let c = 0; c < 4; c++) {
          const dl = this._combL[c][this._combIdx[c]];
          const dr = this._combR[c][this._combIdx[c]];
          this._lpS[0][c] = dl * (1 - damp) + this._lpS[0][c] * damp;
          this._lpS[1][c] = dr * (1 - damp) + this._lpS[1][c] * damp;
          this._combL[c][this._combIdx[c]] = inL + this._lpS[0][c] * fb;
          this._combR[c][this._combIdx[c]] = inR + this._lpS[1][c] * fb;
          wetL += dl; wetR += dr;
        }
        this._combIdx[0] = (this._combIdx[0] + 1) % 1116;
        this._combIdx[1] = (this._combIdx[1] + 1) % 1188;
        this._combIdx[2] = (this._combIdx[2] + 1) % 1277;
        this._combIdx[3] = (this._combIdx[3] + 1) % 1356;

        wetL *= 0.25; wetR *= 0.25;

        for (let a = 0; a < 2; a++) {
          const dl = this._apL[a][this._apIdx[a]];
          const dr = this._apR[a][this._apIdx[a]];
          const ol = -wetL + dl;
          const or = -wetR + dr;
          this._apL[a][this._apIdx[a]] = wetL + dl * 0.5;
          this._apR[a][this._apIdx[a]] = wetR + dr * 0.5;
          wetL = ol; wetR = or;
        }
        this._apIdx[0] = (this._apIdx[0] + 1) % 556;
        this._apIdx[1] = (this._apIdx[1] + 1) % 441;

        const dg = Math.sqrt(1 - space * 0.7);
        const wg = Math.sqrt(space * 0.7);
        L = L * dg + wetL * wg;
        R = R * dg + wetR * wg;
      }

      // 10) Final protection + dry/wet mix
      L = this._softClip(L, 0.92);
      R = this._softClip(R, 0.92);
      L = L * mix + dryL * (1 - mix);
      R = R * mix + dryR * (1 - mix);

      out[0][i] = L;
      if (out.length > 1) out[1][i] = R;

      // write cursor advance (একবার শেষে)
      this._wIdx = (this._wIdx + 1) & (this._bufN - 1);
    }

    return true;
  }
}
registerProcessor('enov-voice-core', EnovVoiceCore);
