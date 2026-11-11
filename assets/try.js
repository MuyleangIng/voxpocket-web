// "Try it" box: type Khmer (or Sing Khmer in Latin letters), pick a voice and a style, listen.
//  - VoxPocket     -> the VoxPocket demo Space on Hugging Face (free GPU time of the visitor)
//  - VoxPocket HD  -> our small API, which uses VoxCPM2 by ModelBest (key stays on the server)
//  - Sing Khmer    -> the Akkhara demo Space (Latin letters -> Khmer, top 5)
(() => {
  const POCKET = "https://ingmuyleang-voxpocket-v4-demo.hf.space/gradio_api";
  const AKKHARA = "https://muyleanging-akkhara-demo.hf.space/gradio_api";
  // address of the VoxPocket HD API (empty = HD shows "coming soon"); ?api=http://localhost:8080 for a local test
  let HD = "https://voxpocket-hd-715345118114.asia-southeast1.run.app";
  const q = new URLSearchParams(location.search).get("api");
  if (q && /^http:\/\/(localhost|127\.0\.0\.1):\d+$/.test(q)) HD = q;

  const STYLES = [ // [label shown, VoxPocket Space style name, words sent to HD]
    ["Plain", "None (plain)", ""],
    ["Happy", "Happy", "happy, smiling tone"],
    ["Sad", "Sad", "sad, low and slow tone"],
    ["Calm", "Calm", "calm, slow and steady"],
    ["Whisper", "Whisper", "whispering quietly"],
    ["Friendly", "Friendly", "warm and friendly tone"],
    ["Soft", "Soft", "soft and gentle tone"],
    ["News", "News reader", "serious and clear news-reader tone"],
    ["Excited", "Excited (English: soon)", "excited and energetic"],
    ["Angry", "Angry / upset (English: soon)", "angry and upset tone"],
    ["Surprised", "Surprised (English: soon)", "surprised and amazed tone"],
  ];
  const VOICES = [["woman-1", "Woman 1"], ["woman-2", "Woman 2"], ["man-1", "Man 1"], ["own", "My voice"]];

  const $ = (s) => document.querySelector(s);
  const box = $("#try-box");
  if (!box) return;
  const st = { engine: "hd", voice: "woman-1", style: 0, clip: null, mode: "km", busy: false, url: "" };

  // ---------- small helpers
  const el = (tag, attrs = {}, ...kids) => { const e = document.createElement(tag); Object.assign(e, attrs); e.append(...kids); return e; };
  const chips = (host, items, isOn, onPick) => {
    host.replaceChildren(...items.map(([k, label], i) => {
      const b = el("button", { type: "button", className: "tchip" + (isOn(k, i) ? " on" : ""), textContent: label });
      b.onclick = () => onPick(k, i);
      return b;
    }));
  };
  const say = (msg, bad) => { const n = $("#try-note"); n.textContent = msg; n.className = "tnote" + (bad ? " bad" : ""); };

  // gradio HTTP API: POST /call/<name> -> event id -> GET it as a stream until "complete"
  async function gradio(base, name, data) {
    const r = await fetch(`${base}/call/${name}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ data }) });
    if (!r.ok) throw new Error(`busy (${r.status}), please try again`);
    const { event_id } = await r.json();
    const s = await fetch(`${base}/call/${name}/${event_id}`);
    const text = await s.text();
    const ev = [...text.matchAll(/event: (\w+)\ndata: (.*)/g)];
    const done = ev.find((m) => m[1] === "complete");
    if (!done) {
      const err = ev.find((m) => m[1] === "error");
      let msg = null; try { msg = err ? JSON.parse(err[2] || "null") : null; } catch { /* not JSON */ }
      const m = typeof msg === "string" ? msg : msg?.error ?? "";
      if (/quota/i.test(m)) throw new Error("your free VoxPocket time for today is used up. Try VoxPocket HD, or come back tomorrow");
      throw new Error(m || "the free GPU is busy; please try again in a minute or use VoxPocket HD");
    }
    return JSON.parse(done[2]);
  }
  async function upload(base, blob, name) {
    const f = new FormData(); f.append("files", blob, name);
    const r = await fetch(`${base}/upload`, { method: "POST", body: f });
    if (!r.ok) throw new Error("could not upload the voice clip");
    return (await r.json())[0];
  }

  // any audio file -> mono 24 kHz 16-bit WAV, at most 9 s (what both engines like)
  async function toWav(file) {
    const raw = await new (window.AudioContext || window.webkitAudioContext)().decodeAudioData(await file.arrayBuffer());
    const sr = 24000, len = Math.min(raw.duration, 9);
    const off = new OfflineAudioContext(1, Math.ceil(len * sr), sr);
    const src = off.createBufferSource(); src.buffer = raw; src.connect(off.destination); src.start();
    const pcm = (await off.startRendering()).getChannelData(0);
    const buf = new ArrayBuffer(44 + pcm.length * 2), v = new DataView(buf);
    const w = (o, s) => [...s].forEach((c, i) => v.setUint8(o + i, c.charCodeAt(0)));
    w(0, "RIFF"); v.setUint32(4, 36 + pcm.length * 2, true); w(8, "WAVE"); w(12, "fmt "); v.setUint32(16, 16, true); v.setUint16(20, 1, true);
    v.setUint16(22, 1, true); v.setUint32(24, sr, true); v.setUint32(28, sr * 2, true); v.setUint16(32, 2, true); v.setUint16(34, 16, true);
    w(36, "data"); v.setUint32(40, pcm.length * 2, true);
    pcm.forEach((x, i) => v.setInt16(44 + i * 2, Math.max(-1, Math.min(1, x)) * 0x7fff, true));
    return { blob: new Blob([buf], { type: "audio/wav" }), seconds: len, cut: raw.duration > 9 };
  }
  const dataUrl = (blob) => new Promise((ok) => { const r = new FileReader(); r.onload = () => ok(r.result); r.readAsDataURL(blob); });

  // ---------- engine / voice / style
  function drawEngine() {
    chips($("#try-engine"), [["hd", "VoxPocket HD"]], (k) => k === st.engine, (k) => { st.engine = k; drawEngine(); });
    const hn = $("#try-hdnote"); if (hn) hn.hidden = st.engine !== "hd";
    const pn = $("#try-pocketnote"); if (pn) pn.hidden = st.engine === "hd";
    if (st.engine === "hd" && !HD) say("VoxPocket HD is coming soon. Use VoxPocket for now.", true); else say("");
  }
  function drawVoice() {
    chips($("#try-voice"), VOICES, (k) => k === st.voice, (k) => { st.voice = k; drawVoice(); });
    $("#try-own").hidden = st.voice !== "own";
  }
  const drawStyle = () => chips($("#try-style"), STYLES.map((s, i) => [i, s[0]]), (k) => k === st.style, (k) => { st.style = k; drawStyle(); });

  const showClip = () => { const pv = $("#try-preview"); pv.src = URL.createObjectURL(st.clip.blob); pv.hidden = false; };
  $("#try-file").onchange = async (e) => {
    const f = e.target.files?.[0]; if (!f) return;
    $("#try-read").hidden = true;
    try { st.clip = await toWav(f); showClip(); say(st.clip.cut ? "Your clip was cut to the first 9 s. Type only the words in that part." : `Clip ready (${st.clip.seconds.toFixed(1)} s). Now type its exact words.`); }
    catch { st.clip = null; say("Could not read that file. Please use a clear WAV, MP3 or M4A clip.", true); }
  };

  // record with the microphone: read a given sentence aloud, so the words are known (max 9 s)
  const READ = [
    "សួស្តី ខ្ញុំកំពុងសាកល្បងសំឡេងរបស់ខ្ញុំ ដើម្បីឱ្យវាអាននូវអត្ថបទជាភាសាខ្មែរ។",
    "ថ្ងៃនេះអាកាសធាតុល្អណាស់ ខ្ញុំចង់ទៅដើរលេងជាមួយមិត្តភក្តិនៅមាត់ទន្លេ។",
    "អរគុណច្រើនសម្រាប់ការគាំទ្រ សូមជួយចែករំលែកដល់អ្នកដទៃផងណា។",
  ];
  let rec = null, recTimer = 0;
  $("#try-rec").onclick = async () => {
    const btn = $("#try-rec");
    if (rec) { rec.stop(); return; }
    if (!navigator.mediaDevices?.getUserMedia) return say("This browser cannot record. Please upload a clip instead.", true);
    let stream;
    try { stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true } }); }
    catch { return say("Microphone blocked. Please allow the microphone, or upload a clip.", true); }
    const line = READ[Math.floor(Math.random() * READ.length)];
    const r = $("#try-read"); r.textContent = "Read this aloud: " + line; r.hidden = false;
    $("#try-words").value = line;
    const parts = []; rec = new MediaRecorder(stream);
    rec.ondataavailable = (e) => e.data.size && parts.push(e.data);
    rec.onstop = async () => {
      clearInterval(recTimer); stream.getTracks().forEach((t) => t.stop()); rec = null;
      btn.classList.remove("rec"); btn.innerHTML = '<svg class="ic" aria-hidden="true"><use href="#i-mic"/></svg> Record again';
      try { st.clip = await toWav(new Blob(parts, { type: parts[0]?.type || "audio/webm" })); showClip(); say(st.clip.seconds < 3 ? `Only ${st.clip.seconds.toFixed(1)} s: please record again and read the whole sentence (4–9 s).` : `Recorded ${st.clip.seconds.toFixed(1)} s. Listen to it, then press Speak.`, st.clip.seconds < 3); }
      catch { st.clip = null; say("Could not use that recording. Please try again.", true); }
    };
    rec.start(); btn.classList.add("rec");
    let left = 9; btn.textContent = `■ Stop (${left})`;
    recTimer = setInterval(() => { left--; btn.textContent = `■ Stop (${left})`; if (left <= 0) rec?.stop(); }, 1000);
    say("Recording… read the sentence, then press Stop.");
  };

  // ---------- Khmer / Sing Khmer
  const text = $("#try-text"), latin = $("#try-latin"), cands = $("#try-cands");
  function drawMode() {
    chips($("#try-mode"), [["km", "ខ្មែរ / English"], ["sing", "Sing Khmer (Latin)"]], (k) => k === st.mode, (k) => { st.mode = k; drawMode(); });
    $("#try-sing").hidden = st.mode !== "sing";
    if (st.mode === "sing") latin.focus();
  }
  let timer, seq = 0;
  latin.oninput = () => {
    clearTimeout(timer);
    const s = latin.value.trim(), my = ++seq;
    if (!s) { cands.replaceChildren(); return; }
    cands.replaceChildren(el("span", { className: "tmuted", textContent: "…" }));
    timer = setTimeout(async () => {
      try {
        const out = await gradio(AKKHARA, "transliterate", [s, false, "hub: INGMUYLEANG/Akkhara-Mini-Khmer-ONNX"]);
        if (my !== seq) return;
        const list = (out[1]?.choices ?? []).map((c) => String(c[0]).replace(/^\d+\.\s*/, ""));
        cands.replaceChildren(...list.map((k) => {
          const b = el("button", { type: "button", className: "tchip km", textContent: k });
          b.onclick = () => { text.value = (text.value.trim() ? text.value.trim() + " " : "") + k; latin.value = ""; cands.replaceChildren(); latin.focus(); };
          return b;
        }));
      } catch { if (my === seq) cands.replaceChildren(el("span", { className: "tmuted", textContent: "Sing Khmer is busy, try again." })); }
    }, 350);
  };

  // ---------- speak
  async function speak() {
    if (st.busy) return;
    const t = text.value.trim();
    if (!t) return say("Please type some text.", true);
    if (t.length > 500) return say("Please keep the text under 500 letters.", true);
    const own = st.voice === "own";
    if (own) {
      if (!st.clip) return say("Please record or upload a voice clip (4–9 s, one speaker).", true);
      if (st.clip.seconds < 2) return say("The voice clip is too short. Please record at least 4 s.", true);
      if (!$("#try-ok").checked) return say("Please confirm you have permission to use this voice.", true);
    }
    const words = own ? $("#try-words").value.trim() : "";
    st.busy = true; loading(true); say(st.engine === "hd" ? "Making speech…" : "Making speech… (the free GPU can take up to a minute to wake up)");
    try {
      let url;
      if (st.engine === "hd") {
        if (!HD) throw new Error("VoxPocket HD is coming soon");
        const body = { text: t, style: STYLES[st.style][2] };
        if (own) Object.assign(body, { clip: await dataUrl(st.clip.blob), clipText: words, consent: true }); else body.voice = st.voice;
        const r = await fetch(HD + "/api/tts", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
        if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error ?? "please try again");
        const ahead = Number(r.headers.get("x-ahead") || 0);
        url = URL.createObjectURL(await r.blob());
        say(ahead ? `Done (waited behind ${ahead} other request${ahead > 1 ? "s" : ""}).` : "Done.");
      } else {
        if (own && !words) throw new Error("for VoxPocket, please type exactly the words spoken in your clip");
        let blob = own ? st.clip.blob : await (await fetch(`assets/voices/${st.voice}.wav`)).blob();
        const said = own ? words : (await (await fetch(`assets/voices/${st.voice}.txt`)).text()).trim();
        const fp = await upload(POCKET, blob, "voice.wav");
        const out = await gradio(POCKET, "clone", [t, STYLES[st.style][1], { path: fp, meta: { _type: "gradio.FileData" } }, said, 2.0, 10, 0]);
        if (!out[0]?.url) throw new Error("no audio came back");
        url = URL.createObjectURL(await (await fetch(out[0].url)).blob()); // a local copy, so Download works
        say(String(out[1] ?? "Done.").replace(/\*\*/g, ""));
      }
      addClip(url, t);
    } catch (e) { say("Sorry: " + e.message + ".", true); }
    st.busy = false; loading(false);
  }
  $("#try-go").onclick = speak;

  // Speak button while working: spinner, moving bar and seconds
  let tick = 0;
  function loading(on) {
    const b = $("#try-go"), label = $("#try-go-label");
    b.disabled = on; b.classList.toggle("loading", on);
    clearInterval(tick);
    if (!on) { label.textContent = "Speak"; return; }
    const t0 = Date.now();
    label.textContent = "Making speech… 0 s";
    tick = setInterval(() => { label.textContent = `Making speech… ${Math.round((Date.now() - t0) / 1000)} s`; }, 1000);
  }

  // ---------- results: every clip made, newest first, each with a player and a Download button
  let nClip = 0;
  function addClip(url, t) {
    nClip++;
    const voice = st.voice === "own" ? "My voice" : VOICES.find((v) => v[0] === st.voice)[1];
    const meta = `${st.engine === "hd" ? "VoxPocket HD" : "VoxPocket"} · ${voice} · ${STYLES[st.style][0]}`;
    const file = `voxpocket-${String(nClip).padStart(2, "0")}-${voice.replace(/\s+/g, "").toLowerCase()}.wav`;
    const audio = el("audio", { src: url, preload: "auto" });
    const play = el("button", { type: "button", className: "tplay", ariaLabel: "Play" });
    const wave = el("div", { className: "twave" });
    const time = el("span", { className: "ttime", textContent: "0:00" });
    const dl = el("a", { className: "tdlicon", href: url, download: file, title: "Download", ariaLabel: "Download" });
    dl.innerHTML = '<svg class="ic" aria-hidden="true"><use href="#i-download"/></svg>';
    const ICON_PLAY = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M7 4.5v15l13-7.5z" fill="currentColor"/></svg>';
    const ICON_PAUSE = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 4h4v16H6zM14 4h4v16h-4z" fill="currentColor"/></svg>';
    play.innerHTML = ICON_PLAY;
    const BARS = 32;
    const bars = Array.from({ length: BARS }, () => el("i"));
    wave.append(...bars);
    const fmt = (x) => `${Math.floor(x / 60)}:${String(Math.floor(x % 60)).padStart(2, "0")}`;
    // bar heights from the real sound
    fetch(url).then((r) => r.arrayBuffer()).then((b) => new (window.AudioContext || window.webkitAudioContext)().decodeAudioData(b)).then((buf) => {
      const d = buf.getChannelData(0), step = Math.floor(d.length / BARS), peaks = [];
      for (let i = 0; i < BARS; i++) { let m = 0; for (let j = i * step; j < (i + 1) * step; j += 16) m = Math.max(m, Math.abs(d[j])); peaks.push(m); }
      const top = Math.max(...peaks) || 1;
      peaks.forEach((v, i) => { bars[i].style.height = `${Math.max(12, (v / top) * 100)}%`; });
      time.textContent = fmt(buf.duration);
    }).catch(() => bars.forEach((b, i) => { b.style.height = `${30 + 50 * Math.abs(Math.sin(i * 1.7))}%`; }));
    const paint = () => { const k = audio.duration ? audio.currentTime / audio.duration : 0; bars.forEach((b, i) => b.classList.toggle("on", i / BARS < k)); };
    play.onclick = () => (audio.paused ? audio.play() : audio.pause());
    audio.onplay = () => { document.querySelectorAll(".tclip audio").forEach((x) => x !== audio && x.pause()); play.innerHTML = ICON_PAUSE; };
    audio.onpause = () => { play.innerHTML = ICON_PLAY; };
    audio.ontimeupdate = () => { paint(); time.textContent = fmt(audio.currentTime || 0); };
    audio.onended = () => { audio.currentTime = 0; paint(); time.textContent = fmt(audio.duration || 0); };
    wave.onclick = (e) => { const r = wave.getBoundingClientRect(); if (audio.duration) { audio.currentTime = ((e.clientX - r.left) / r.width) * audio.duration; paint(); if (audio.paused) audio.play(); } };
    const item = el("div", { className: "tclip" },
      el("div", { className: "tclip-head" }, el("span", { className: "chip", textContent: "#" + nClip }), el("span", { className: "tsmall", textContent: meta })),
      el("p", { className: "km tclip-text", textContent: t.length > 120 ? t.slice(0, 120) + "…" : t }),
      el("div", { className: "tplayer" }, play, wave, time, dl), audio);
    const list = $("#try-clips");
    list.prepend(item); list.hidden = false; $("#try-clips-title").hidden = false;
    audio.play().catch(() => {});
    item.scrollIntoView({ behavior: "smooth", block: "nearest" });
  }

  drawEngine(); drawVoice(); drawStyle(); drawMode();
})();
