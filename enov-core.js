// enov-core.js — ENOV core. Creator: Thalvrix
// Runs in MAIN world on Discord. Hooks getUserMedia + applies DSP chain.
(() => {
  if (window.__enov) return;
  window.__enov = true;

  const tag = '[ENOV]';
  const say = (...a) => console.log(tag, ...a);

  // ============ Config ============
  const DEF = {
    trim:   2.2,
    depth:  121,
    body:   35,
    air:    25,
    space:  12,
    width:  1.15,
    mix:    1.0,
  };
  const CFG = { ...DEF };
  let active = true;

  // ============ Audio context ============
  let Ctx = null, modReady = null;
  function getCtx() {
    if (!Ctx || Ctx.state === 'closed') {
      const AC = window.AudioContext || window.webkitAudioContext;
      Ctx = new AC({ latencyHint: 'interactive' });
      modReady = Ctx.audioWorklet.addModule(chrome.runtime.getURL('enov-dsp.js'));
    }
    return Ctx;
  }
  ['click','touchstart','keydown'].forEach(e =>
    window.addEventListener(e, () => {
      if (Ctx && Ctx.state === 'suspended') Ctx.resume().catch(()=>{});
    }, { passive: true })
  );

  // ============ Nodes ============
  let node = null, srcNode = null, dest = null;

  async function hookStream(stream) {
    if (!active) return stream;
    if (!stream.getAudioTracks().length) return stream;
    try {
      const c = getCtx();
      if (c.state === 'suspended') await c.resume().catch(()=>{});
      await modReady;

      try { srcNode && srcNode.disconnect(); } catch {}
      try { node && node.disconnect(); } catch {}
      try { dest && dest.stream.getTracks().forEach(t => t.stop()); } catch {}

      srcNode = c.createMediaStreamSource(stream);
      node = new AudioWorkletNode(c, 'enov-voice-core', {
        numberOfInputs: 1,
        numberOfOutputs: 1,
        outputChannelCount: [2],
        parameterData: {
          trim: CFG.trim,
          depth: CFG.depth,
          body: CFG.body,
          air: CFG.air,
          space: CFG.space,
          width: CFG.width,
          mix: CFG.mix,
        },
      });
      dest = c.createMediaStreamDestination();
      dest.channelCount = 2;
      srcNode.connect(node);
      node.connect(dest);

      const out = new MediaStream();
      out.addTrack(dest.stream.getAudioTracks()[0]);
      stream.getVideoTracks().forEach(t => out.addTrack(t));

      stream.getAudioTracks()[0].addEventListener('ended', () => {
        try { srcNode.disconnect(); node.disconnect(); } catch {}
      });

      say('stream attached. rate =', c.sampleRate);
      return out;
    } catch (err) {
      console.warn(tag, 'attach failed, using raw mic', err);
      return stream;
    }
  }

  // ============ getUserMedia hook ============
  if (navigator.mediaDevices && navigator.mediaDevices.getUserMedia) {
    const orig = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);
    navigator.mediaDevices.getUserMedia = async (constraints) => {
      if (!constraints || !constraints.audio) return orig(constraints);
      const audio = typeof constraints.audio === 'object'
        ? { ...constraints.audio,
            echoCancellation: false,
            noiseSuppression: false,
            autoGainControl: false }
        : { echoCancellation: false, noiseSuppression: false, autoGainControl: false };
      const raw = await orig({ ...constraints, audio });
      return hookStream(raw);
    };
    say('capture hook installed');
  }

  // ============ SDP patch ============
  const OPC = window.RTCPeerConnection;
  if (OPC) {
    const patch = (sdp) => {
      if (!sdp) return sdp;
      const m = sdp.match(/a=rtpmap:(\d+) opus\/48000/);
      if (!m) return sdp;
      const pt = m[1];
      const fmtp = `a=fmtp:${pt} minptime=10;useinbandfec=1;usedtx=0;stereo=1;maxaveragebitrate=510000`;
      const re = new RegExp(`a=fmtp:${pt} [^\\r\\n]+`);
      if (re.test(sdp)) return sdp.replace(re, fmtp);
      return sdp.replace(new RegExp(`(a=rtpmap:${pt} opus\\/48000\\/2)`), `$1\r\n${fmtp}`);
    };
    window.RTCPeerConnection = class extends OPC {
      async createOffer(o){ const d = await super.createOffer(o); d.sdp = patch(d.sdp); return d; }
      async createAnswer(o){ const d = await super.createAnswer(o); d.sdp = patch(d.sdp); return d; }
    };
    Object.defineProperty(window.RTCPeerConnection, 'name', { value: 'RTCPeerConnection' });
  }

  // ============ UI ============
  function mountUI() {
    if (document.getElementById('enov-ui')) return;
    const root = document.createElement('div');
    root.id = 'enov-ui';
    root.innerHTML = `
      <style>
        #enov-ui {
          position: fixed; right: 20px; bottom: 90px; z-index: 2147483647;
          font-family: ui-monospace, 'JetBrains Mono', Menlo, monospace;
          color: #d8ffe4; width: 280px; user-select: none;
          transition: transform .25s ease, opacity .25s ease;
        }
        #enov-ui.collapsed { transform: translateY(calc(100% - 42px)); }
        #enov-ui .panel {
          background: linear-gradient(160deg, #0b1410 0%, #06100c 100%);
          border: 1px solid #1e5c3a; border-radius: 10px;
          box-shadow: 0 12px 40px rgba(0,0,0,0.55),
                      inset 0 0 22px rgba(40,220,140,0.05);
          overflow: hidden; backdrop-filter: blur(10px);
        }
        #enov-ui .hd {
          display: flex; align-items: center; justify-content: space-between;
          padding: 10px 12px; border-bottom: 1px solid #12442a;
          background: linear-gradient(90deg, rgba(40,200,140,0.06), transparent);
          cursor: move;
        }
        #enov-ui .brand {
          font-weight: 700; letter-spacing: 3px; font-size: 13px;
          color: #6dffb0; text-shadow: 0 0 12px rgba(80,255,170,0.55);
        }
        #enov-ui .sub { font-size: 9px; color: #3f7a5c; letter-spacing: 1.5px; }
        #enov-ui .hd-r { display: flex; gap: 8px; align-items: center; }
        #enov-ui .live {
          font-size: 9px; padding: 2px 6px; border-radius: 3px;
          background: #0a2218; color: #3f7a5c;
          border: 1px solid #12442a; letter-spacing: 1px;
        }
        #enov-ui .live.on {
          color: #6dffb0; border-color: #2ea56f;
          box-shadow: 0 0 8px rgba(80,255,170,0.3);
        }
        #enov-ui .min {
          background: transparent; border: 1px solid #12442a; color: #6b9d84;
          width: 22px; height: 22px; border-radius: 4px; cursor: pointer;
          font-size: 11px; line-height: 1; padding: 0;
        }
        #enov-ui .min:hover { color: #6dffb0; border-color: #2ea56f; }
        #enov-ui .body { padding: 12px; }
        #enov-ui .row { margin-bottom: 10px; }
        #enov-ui .row:last-child { margin-bottom: 0; }
        #enov-ui .lbl {
          display: flex; justify-content: space-between;
          font-size: 10px; letter-spacing: 1.5px; color: #6b9d84;
          margin-bottom: 4px;
        }
        #enov-ui .lbl .v { color: #b8ffd6; font-weight: 600; }
        #enov-ui input[type=range] {
          -webkit-appearance: none; width: 100%; height: 3px;
          background: #10241a; border-radius: 2px; outline: none;
        }
        #enov-ui input[type=range]::-webkit-slider-thumb {
          -webkit-appearance: none; width: 14px; height: 14px;
          background: #6dffb0; border-radius: 50%; cursor: pointer;
          box-shadow: 0 0 10px rgba(109,255,176,0.7);
        }
        #enov-ui .ft {
          padding: 8px 12px; border-top: 1px solid #12442a;
          font-size: 9px; color: #2f6148; letter-spacing: 1.5px;
          display: flex; justify-content: space-between;
        }
        #enov-ui .ft b { color: #6dffb0; font-weight: 600; }
        #enov-ui .power {
          width: 100%; margin-top: 10px; padding: 8px;
          background: transparent; color: #6dffb0;
          border: 1px solid #1e5c3a; border-radius: 6px;
          font-family: inherit; font-size: 10px; letter-spacing: 2px;
          cursor: pointer; transition: 0.15s;
        }
        #enov-ui .power:hover { background: rgba(109,255,176,0.08); }
        #enov-ui .power.off { color: #ff6d6d; border-color: #5c1e1e; }
      </style>
      <div class="panel">
        <div class="hd">
          <div>
            <div class="brand">ENOV</div>
            <div class="sub">by Thalvrix</div>
          </div>
          <div class="hd-r">
            <div class="live" id="enov-live">IDLE</div>
            <button class="min" id="enov-min" title="Minimize">—</button>
          </div>
        </div>
        <div class="body" id="enov-body"></div>
        <div class="ft"><span>SIGNAL</span><b>v2.1</b></div>
      </div>
    `;
    document.body.appendChild(root);

    const body  = root.querySelector('#enov-body');
    const live  = root.querySelector('#enov-live');
    const minB  = root.querySelector('#enov-min');

    // Collapse toggle
    minB.onclick = (e) => {
      e.stopPropagation();
      root.classList.toggle('collapsed');
      minB.textContent = root.classList.contains('collapsed') ? '+' : '—';
    };

    // Drag (header)
    const hd = root.querySelector('.hd');
    let drag = false, dx = 0, dy = 0;
    hd.addEventListener('pointerdown', (e) => {
      if (e.target.closest('button')) return;
      drag = true;
      const r = root.getBoundingClientRect();
      dx = e.clientX - r.left;
      dy = e.clientY - r.top;
      root.style.left = r.left + 'px';
      root.style.top  = r.top  + 'px';
      root.style.right = 'auto';
      root.style.bottom = 'auto';
      try { hd.setPointerCapture(e.pointerId); } catch {}
    });
    hd.addEventListener('pointermove', (e) => {
      if (!drag) return;
      const w = root.offsetWidth, h = root.offsetHeight;
      root.style.left = Math.max(4, Math.min(innerWidth  - w - 4, e.clientX - dx)) + 'px';
      root.style.top  = Math.max(4, Math.min(innerHeight - h - 4, e.clientY - dy)) + 'px';
    });
    hd.addEventListener('pointerup', () => drag = false);
    hd.addEventListener('pointercancel', () => drag = false);

    // Sliders
    const sliders = [
      { k:'trim',  name:'TRIM',  min:0.1, max:20,  step:0.1,  fmt:v=>Number(v).toFixed(1)+'x' },
      { k:'depth', name:'DEPTH', min:0,   max:200, step:1,    fmt:v=>Math.round(v) },
      { k:'body',  name:'BODY',  min:0,   max:100, step:1,    fmt:v=>Math.round(v)+'%' },
      { k:'air',   name:'AIR',   min:0,   max:100, step:1,    fmt:v=>Math.round(v)+'%' },
      { k:'space', name:'SPACE', min:0,   max:100, step:1,    fmt:v=>Math.round(v)+'%' },
      { k:'width', name:'WIDTH', min:0,   max:2.5, step:0.05, fmt:v=>Number(v).toFixed(2) },
    ];
    function setParam(k, v) {
      CFG[k] = v;
      if (node) {
        const p = node.parameters.get(k);
        if (p) p.setTargetAtTime(v, Ctx.currentTime, 0.01);
      }
    }
    sliders.forEach(s => {
      const row = document.createElement('div');
      row.className = 'row';
      row.innerHTML = `
        <div class="lbl"><span>${s.name}</span><span class="v"></span></div>
        <input type="range" min="${s.min}" max="${s.max}" step="${s.step}" value="${CFG[s.k]}">
      `;
      const inp = row.querySelector('input');
      const val = row.querySelector('.v');
      val.textContent = s.fmt(CFG[s.k]);
      inp.addEventListener('input', () => {
        setParam(s.k, Number(inp.value));
        val.textContent = s.fmt(CFG[s.k]);
      });
      body.appendChild(row);
    });

    const power = document.createElement('button');
    power.className = 'power';
    power.textContent = 'ENGINE ON';
    power.onclick = () => {
      active = !active;
      power.textContent = active ? 'ENGINE ON' : 'ENGINE OFF';
      power.classList.toggle('off', !active);
      if (!active && node) {
        try { srcNode.disconnect(); node.disconnect(); } catch {}
      }
    };
    body.appendChild(power);

    setInterval(() => {
      const on = active && node && Ctx && Ctx.state === 'running';
      live.textContent = on ? 'LIVE' : (active ? 'IDLE' : 'OFF');
      live.classList.toggle('on', on);
    }, 500);
  }

  if (document.body) mountUI();
  else document.addEventListener('DOMContentLoaded', mountUI, { once: true });

  // SPA route-change guard
  setInterval(() => {
    if (!document.getElementById('enov-ui') && document.body) mountUI();
  }, 2000);

  say('ENOV online on Discord. Creator: Thalvrix');
})();
