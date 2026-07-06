const $ = (s, r = document) => r.querySelector(s);
const state = { project: null, base: null, doc: null, dirty: false };

async function loadProjects() {
  const { projects } = await (await fetch("/api/projects")).json();
  const el = $("#projects");
  el.innerHTML = "";
  for (const p of projects) {
    const h = document.createElement("div");
    h.className = "proj"; h.textContent = p.name; el.appendChild(h);
    for (const f of p.files) {
      const d = document.createElement("div");
      d.className = "file";
      const badge = f.has_edit ? "✎" : (f.has_md ? "✓" : (f.has_audio ? "●" : ""));
      d.innerHTML = `${f.base} <span class="badge">${badge}</span>`;
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
  state.doc = await (await fetch(`/api/projects/${project}/files/${base}`)).json();
  state.dirty = false;
  $("#current").textContent = `${project} / ${base}`;
  $("#save").disabled = false; $("#export").disabled = false;
  renderSegments();
  window.dispatchEvent(new CustomEvent("file-loaded"));  // Tasks 7/8 hängen sich hier ein
}

function fmt(t) {
  t = Math.max(0, t | 0); const m = (t / 60) | 0, s = t % 60;
  return `${m}:${String(s).padStart(2, "0")}`;
}

function renderSegments() {
  const box = $("#segments"); box.innerHTML = "";
  state.doc.segments.forEach((seg, i) => {
    const row = document.createElement("div");
    row.className = "seg"; row.dataset.i = i;
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
    row.append(meta, text); box.appendChild(row);
  });
}

function markDirty() { state.dirty = true; $("#status").textContent = "● ungespeichert"; }

async function save() {
  await fetch(`/api/projects/${state.project}/files/${state.base}`,
    { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(state.doc) });
  state.dirty = false; $("#status").textContent = "gespeichert";
}

async function exportMd() {
  const { md } = await (await fetch(
    `/api/projects/${state.project}/files/${state.base}/export`, { method: "POST" })).json();
  const blob = new Blob([md], { type: "text/markdown" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob); a.download = `${state.base}.md`; a.click();
}

$("#save").onclick = save;
$("#export").onclick = exportMd;
window.addEventListener("beforeunload", e => { if (state.dirty) e.preventDefault(); });
loadProjects();
