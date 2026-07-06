const $ = (s, r = document) => r.querySelector(s);
import WaveSurfer from "/vendor/wavesurfer.esm.js";
let ws = null, stopAt = null;
const state = { project: null, base: null, doc: null, dirty: false };
const thr = { yellow: 0.6, red: 0.4 };

async function loadProjects() {
  const { projects } = await (await fetch("/api/projects")).json();
  const el = $("#projects");
  el.innerHTML = "";
  for (const p of projects) {
    const h = document.createElement("div");
    h.className = "proj";
    const name = document.createElement("span");
    name.className = "grow"; name.textContent = p.name;
    const up = document.createElement("label");
    up.className = "up"; up.textContent = "⬆"; up.title = "Audio hochladen";
    const upInput = document.createElement("input");
    upInput.type = "file"; upInput.accept = "audio/*,.mp3,.wav,.m4a,.aac,.flac,.ogg,.opus,.wma,.mp4";
    upInput.style.display = "none";
    upInput.onchange = () => uploadAudio(p.name, upInput.files[0]);
    up.appendChild(upInput);
    const tr = document.createElement("button");
    tr.textContent = "▶"; tr.title = "Transkribieren";
    tr.onclick = () => startTranscribe(p.name, tr);
    h.append(name, up, tr);
    el.appendChild(h);
    for (const f of p.files) {
      const d = document.createElement("div");
      d.className = "file";
      const badge = f.has_edit ? "✎" : (f.has_md ? "✓" : (f.has_audio ? "●" : ""));
      d.textContent = f.base + " ";
      const b = document.createElement("span");
      b.className = "badge"; b.textContent = badge;
      d.appendChild(b);
      d.onclick = () => openFile(p.name, f.base, d);
      el.appendChild(d);
    }
  }
}

async function openFile(project, base, node) {
  if (state.dirty && !confirm("Ungespeicherte Änderungen verwerfen?")) return;
  document.querySelectorAll(".file.active").forEach(n => n.classList.remove("active"));
  if (node) node.classList.add("active");
  state.project = project; state.base = base;
  const res = await fetch(`/api/projects/${encodeURIComponent(project)}/files/${encodeURIComponent(base)}`);
  if (!res.ok) { $("#status").textContent = "Laden fehlgeschlagen!"; return; }
  state.doc = await res.json();
  state.dirty = false;
  $("#current").textContent = `${project} / ${base}`;
  $("#save").disabled = false; $("#export").disabled = false;
  renderSegments();
  setupPlayer();
}

function fmt(t) {
  t = Math.max(0, t | 0); const m = (t / 60) | 0, s = t % 60;
  return `${m}:${String(s).padStart(2, "0")}`;
}

function renderSegments() {
  const box = $("#segments"); box.innerHTML = "";
  (state.doc.segments || []).forEach((seg, i) => {
    const row = document.createElement("div");
    row.className = "seg"; row.dataset.i = i;
    row.ondblclick = () => window.dispatchEvent(new CustomEvent("play-seg", { detail: i }));
    const spk = document.createElement("input");
    spk.value = seg.speaker || ""; spk.placeholder = "Sprecher…";
    spk.oninput = () => { seg.speaker = spk.value; markDirty(); };
    const time = document.createElement("span");
    time.className = "time"; time.textContent = `[${fmt(seg.start)}]`;
    time.onclick = () => window.dispatchEvent(new CustomEvent("play-seg", { detail: i }));
    const flag = document.createElement("span");
    flag.className = "flag";
    flag.textContent = [seg.flags?.hallucination && "⚠", seg.flags?.silence && "🔇",
                        seg.flags?.low_conf && "~"].filter(Boolean).join(" ");
    const meta = document.createElement("div");
    meta.className = "meta"; meta.append(spk, document.createElement("br"), time, " ", flag);
    const text = document.createElement("div");
    text.className = "text"; text.contentEditable = "true"; text.textContent = seg.text;
    text.oninput = () => { seg.text = text.textContent; markDirty(); };
    row.append(meta, text);
    const toggle = document.createElement("span");
    toggle.className = "toggle"; toggle.textContent = "🔍"; toggle.title = "Roh-Wörter / Unsicherheit";
    flag.after(toggle);
    const raw = document.createElement("div");
    raw.className = "raw-words hidden"; raw.dataset.i = i;
    toggle.onclick = () => {
      raw.classList.toggle("hidden");
      if (!raw.classList.contains("hidden")) paintWords(raw);
    };
    row.append(raw);
    box.appendChild(row);
  });
}

function markDirty() { state.dirty = true; $("#status").textContent = "● ungespeichert"; }

async function save() {
  const res = await fetch(`/api/projects/${encodeURIComponent(state.project)}/files/${encodeURIComponent(state.base)}`,
    { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(state.doc) });
  if (!res.ok) { $("#status").textContent = "Fehler beim Speichern!"; return; }
  state.dirty = false; $("#status").textContent = "gespeichert";
}

async function exportMd() {
  const res = await fetch(
    `/api/projects/${encodeURIComponent(state.project)}/files/${encodeURIComponent(state.base)}/export`, { method: "POST" });
  if (!res.ok) { $("#status").textContent = "Export fehlgeschlagen!"; return; }
  const { md } = await res.json();
  const blob = new Blob([md], { type: "text/markdown" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob); a.download = `${state.base}.md`; a.click();
}

$("#save").onclick = save;
$("#export").onclick = exportMd;

function wireThresholds() {
  const y = $("#thrYellow"), r = $("#thrRed");
  const upd = () => {
    thr.yellow = +y.value; thr.red = +r.value;
    $("#thrYellowV").textContent = thr.yellow.toFixed(2);
    $("#thrRedV").textContent = thr.red.toFixed(2);
    document.querySelectorAll(".raw-words:not(.hidden)").forEach(el => paintWords(el));
  };
  y.oninput = upd; r.oninput = upd; upd();
}

function wordClass(w, isEdge) {
  const p = w.probability ?? 1;
  if (p < thr.red) return "w-red";
  if (!isEdge && p < thr.yellow) return "w-yellow";  // Randwort nur ab roter Schwelle färben
  return "";
}

function paintWords(el) {
  const seg = state.doc.segments[+el.dataset.i];
  el.innerHTML = "";
  const n = seg.words.length;
  seg.words.forEach((w, k) => {
    const span = document.createElement("span");
    const isEdge = (k === 0 || k === n - 1);
    span.className = wordClass(w, isEdge);
    span.textContent = w.word;
    el.appendChild(span);
  });
}

wireThresholds();

window.addEventListener("beforeunload", e => { if (state.dirty) e.preventDefault(); });
loadProjects();

function setupPlayer() {
  if (ws) { ws.destroy(); ws = null; }
  $("#player").innerHTML = "";
  ws = WaveSurfer.create({
    container: "#player", height: 72, waveColor: "#b9c6d6", progressColor: "#4f7fbf",
    url: `/api/projects/${encodeURIComponent(state.project)}/audio/${encodeURIComponent(state.base)}`,
  });
  ws.on("timeupdate", (t) => {
    if (stopAt != null && t >= stopAt) { ws.pause(); stopAt = null; }
    highlightAt(t);
  });
}

function playSeg(i) {
  const seg = state.doc.segments[i];
  if (!ws) return;
  stopAt = seg.end;
  ws.setTime(seg.start);
  ws.play();
}

function highlightAt(t) {
  const segs = state.doc.segments;
  let idx = -1;
  for (let i = 0; i < segs.length; i++) {
    if (t >= segs[i].start && t < segs[i].end) { idx = i; break; }
  }
  document.querySelectorAll(".seg.active").forEach(n => n.classList.remove("active"));
  if (idx >= 0) {
    const row = document.querySelector(`.seg[data-i="${idx}"]`);
    if (row) row.classList.add("active");
  }
}

window.addEventListener("play-seg", (e) => playSeg(e.detail));

async function uploadAudio(project, fileObj) {
  if (!fileObj) return;
  const fd = new FormData();
  fd.append("file", fileObj);
  const res = await fetch(`/api/projects/${encodeURIComponent(project)}/audio`,
    { method: "POST", body: fd });
  if (!res.ok) {
    const msg = await res.json().catch(() => ({}));
    showJob(`Upload fehlgeschlagen: ${msg.detail || res.status}`);
    return;
  }
  showJob(`Hochgeladen: ${(await res.json()).file}`);
  loadProjects();
}

async function startTranscribe(project, btn) {
  btn.disabled = true;
  const res = await fetch(`/api/projects/${encodeURIComponent(project)}/transcribe`, { method: "POST" });
  if (!res.ok) { showJob(`Start fehlgeschlagen: ${res.status}`); btn.disabled = false; return; }
  const { job_id } = await res.json();
  pollJob(job_id, () => { btn.disabled = false; loadProjects(); });
}

function showJob(text) {
  const box = $("#jobstatus");
  box.classList.remove("hidden");
  box.textContent = text;
  box.scrollTop = box.scrollHeight;
}

function pollJob(jobId, onDone) {
  const tick = async () => {
    const res = await fetch(`/api/jobs/${encodeURIComponent(jobId)}`);
    if (!res.ok) { showJob("Job nicht gefunden."); return; }
    const j = await res.json();
    showJob((j.lines || []).slice(-12).join("\n") || `Status: ${j.status}`);
    if (j.status === "running") { setTimeout(tick, 1500); }
    else { showJob(((j.lines || []).slice(-12).join("\n")) + `\n[${j.status}]`); if (onDone) onDone(); }
  };
  tick();
}
