"use strict";
const $app = document.getElementById("app");
const $crumbs = document.getElementById("crumbs");
const $stats = document.getElementById("stats");
const PAGE_CHARS = 1500;

// ---------- storage (per-browser: progress in localStorage, custom books in IndexedDB) ----------
const store = {
  get(k, d) { try { return JSON.parse(localStorage.getItem(k)) ?? d; } catch { return d; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch {} },
};
const progress = () => store.get("progress", {});          // {bookId: {"ch/p": {wpm, acc}}}
// custom books can be whole novels, too big for localStorage's ~5MB, so they live in IndexedDB
const idb = new Promise((ok, fail) => {
  const r = indexedDB.open("typeshelf", 1);
  r.onupgradeneeded = () => r.result.createObjectStore("books", { keyPath: "id" });
  r.onsuccess = () => ok(r.result); r.onerror = () => fail(r.error);
});
async function tx(mode, fn) {
  const t = (await idb).transaction("books", mode), req = fn(t.objectStore("books"));
  return new Promise((ok, fail) => { t.oncomplete = () => ok(req?.result); t.onerror = () => fail(t.error); });
}
const customBooks = () => tx("readonly", (s) => s.getAll());
const saveBook = async (b) => { navigator.storage?.persist?.(); await tx("readwrite", (s) => s.put(b)); sync.pushBook(b); };
const deleteBook = async (id) => { await tx("readwrite", (s) => s.delete(id)); sync.dropBook(id); };
(async () => { // one-time move of books saved by the earlier localStorage version
  const old = store.get("custom", null);
  if (old) { for (const b of old) await saveBook(b); localStorage.removeItem("custom"); }
})();
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

// ---------- data ----------
let indexCache;
async function classics() {
  return (indexCache ??= await fetch("books/index.json").then((r) => r.json()));
}
const bookCache = {};
async function loadBook(id) {
  if (id.startsWith("c-")) return tx("readonly", (s) => s.get(id));
  return (bookCache[id] ??= await fetch(`books/${id}.json`).then((r) => r.json()));
}
function summary(book) { // custom books are stored whole; classics come pre-summarized in index.json
  return book.chapters[0] && Array.isArray(book.chapters[0].pages)
    ? { ...book, pages: book.chapters.reduce((n, c) => n + c.pages.length, 0), chapters: book.chapters.map((c) => ({ title: c.title, pages: c.pages.length })) }
    : book;
}
const splitParas = (text) => text.split(/\n\s*\n/).map((p) => p.replace(/\s+/g, " ").trim()).filter(Boolean);
function paginate(paras) {
  const pages = []; let cur = [], len = 0;
  for (const p of paras) {
    if (cur.length && len + p.length > PAGE_CHARS) { pages.push(cur); cur = []; len = 0; }
    cur.push(p); len += p.length;
  }
  if (cur.length) pages.push(cur);
  return pages;
}
function bookStats(id, sum) {
  const done = progress()[id] || {};
  const vals = Object.values(done);
  const avg = (k) => (vals.length ? Math.round(vals.reduce((a, v) => a + v[k], 0) / vals.length) : null);
  const chaptersDone = sum.chapters.filter((c, i) => [...Array(c.pages).keys()].every((p) => done[`${i}/${p}`])).length;
  return { pagesDone: vals.length, chaptersDone, wpm: avg("wpm"), acc: avg("acc"), done };
}

// ---------- router ----------
let cleanup = () => {};
async function route() {
  cleanup(); cleanup = () => {};
  $stats.innerHTML = ""; $crumbs.innerHTML = "";
  const [, view, id, ch, pg] = location.hash.split("/");
  window.scrollTo(0, 0);
  if (view === "book") return renderBook(decodeURIComponent(id));
  if (view === "type") return renderConsole(decodeURIComponent(id), +ch || 0, +pg || 0);
  return renderHome();
}
addEventListener("hashchange", route);
document.getElementById("theme").onclick = () => {
  const t = document.documentElement.dataset.theme === "dark" ? "light" : "dark";
  document.documentElement.dataset.theme = t;
  try { localStorage.setItem("theme", t); } catch {}
};

// ---------- home ----------
function card(b) {
  const s = bookStats(b.id, b);
  const pct = b.pages ? Math.round((100 * s.pagesDone) / b.pages) : 0;
  const cover = b.id.startsWith("c-") ? `<div class="nocover"></div>` : `<img src="covers/${b.id}.jpg" alt="${esc(b.title)} cover" loading="lazy" onerror="this.replaceWith(Object.assign(document.createElement('div'),{className:'nocover'}))">`;
  return `<a class="card" href="#/book/${encodeURIComponent(b.id)}">${cover}
    <div class="meta"><h3>${esc(b.title)}</h3><h4>${esc(b.author)}</h4>
    <span class="pages">${b.pages} Pages</span>${pct ? `<div class="bar-mini"><i style="width:${pct}%"></i></div>` : ""}</div></a>`;
}
async function renderHome() {
  cleanup();
  const tab = sessionStorage.getItem("tab") || "classics";
  $app.innerHTML = `<div class="wrap">
    <section class="hero">
      <div class="pitch"><h2>Practice typing on great literature. Pick a classic below, or upload your own EPUBs.</h2>
        <ul><li>Build typing speed and accuracy one page at a time</li>
        <li>Your progress, WPM and accuracy are saved in this browser</li>
        <li>Read a book while you practice</li></ul></div>
      <div class="demo" aria-hidden="true"></div>
    </section>
    <div class="tabs" role="tablist">
      ${["classics", "custom", "recent"].map((t) => `<button role="tab" data-tab="${t}" aria-selected="${t === tab}">${t[0].toUpperCase() + t.slice(1)}</button>`).join("")}
    </div>
    <div id="tabbody"></div></div>`;
  $app.querySelectorAll("[data-tab]").forEach((b) => (b.onclick = () => { sessionStorage.setItem("tab", b.dataset.tab); renderHome(); }));
  demo($app.querySelector(".demo"));
  const body = document.getElementById("tabbody");
  if (tab === "classics") {
    body.innerHTML = `<div class="grid">${(await classics()).map(card).join("")}</div>`;
  } else if (tab === "custom") {
    const mine = await customBooks();
    body.innerHTML = `<label class="upload">Upload EPUB files <input type="file" accept=".epub,application/epub+zip" multiple></label>
      <p id="upmsg" class="empty" role="status"></p>
      <form class="custom"><div class="row"><input name="title" placeholder="Title" required maxlength="120"></div>
      <textarea name="text" placeholder="Paste any text. Blank lines separate paragraphs; a line like 'Chapter 2' starts a new chapter." required></textarea>
      <button class="add">Add text</button></form>
      <div class="grid" style="margin-top:20px">${mine.map((b) => card(summary(b))).join("") || `<p class="empty">No custom texts yet.</p>`}</div>`;
    body.querySelector("input[type=file]").onchange = async (e) => {
      const msg = document.getElementById("upmsg");
      for (const file of e.target.files) {
        msg.textContent = `Reading ${file.name}…`;
        try {
          const b = await parseEpub(await file.arrayBuffer());
          await saveBook({ id: "c-" + Date.now() + Math.random().toString(36).slice(2, 6), title: b.title, author: b.author,
            chapters: b.chapters.map((c) => ({ title: c.title, pages: paginate(c.paras) })) });
        } catch (err) { msg.textContent = `${file.name}: ${err.message}`; return; }
      }
      renderHome();
    };
    body.querySelector("form").onsubmit = async (e) => {
      e.preventDefault();
      const f = new FormData(e.target);
      const parts = String(f.get("text")).split(/^\s*(chapter\s+\S+.*)$/im);
      const chapters = [];
      if (parts[0].trim()) chapters.push({ title: "Part 1", pages: paginate(splitParas(parts[0])) });
      for (let i = 1; i < parts.length; i += 2) chapters.push({ title: parts[i].trim(), pages: paginate(splitParas(parts[i + 1] || "")) });
      const book = { id: "c-" + Date.now(), title: String(f.get("title")), author: "Custom", chapters: chapters.filter((c) => c.pages.length) };
      if (!book.chapters.length) return;
      await saveBook(book);
      renderHome();
    };
  } else {
    const all = [...(await classics()), ...(await customBooks()).map(summary)];
    const recent = store.get("recent", []).map((id) => all.find((b) => b.id === id)).filter(Boolean);
    body.innerHTML = recent.length ? `<div class="grid">${recent.map(card).join("")}</div>` : `<p class="empty">Books you type in will show up here.</p>`;
  }
}
function demo(el) {
  const s = "I am by birth a Genevese, and my family is one of the most distinguished of that republic. My ancestors had been for many years counsellors and syndics, and my father had filled several public situations with honour and reputation. He was respected by all who knew him for his integrity and indefatigable attention to public business.";
  el.innerHTML = `<p style="margin:0 0 12px">Chapter 1</p><span class="done"></span><span class="cur"> </span><span class="rest">${s}</span>`;
  const [done, , rest] = el.querySelectorAll("span");
  let i = 0;
  const t = setInterval(() => { i = (i + 1) % (s.length + 40); done.textContent = s.slice(0, i); rest.textContent = s.slice(i); }, 90);
  cleanup = () => clearInterval(t);
}

// ---------- book page ----------
async function renderBook(id) {
  const full = await loadBook(id);
  if (!full) return (location.hash = "#/");
  const b = summary({ ...full, id });
  const s = bookStats(id, b);
  $crumbs.innerHTML = `<a href="#/">Books</a> / <b>Chapters</b>`;
  const cover = id.startsWith("c-") ? "" : `<img src="covers/${id}.jpg" alt="${esc(b.title)} cover" onerror="this.remove()">`;
  $app.innerHTML = `<div class="book">
    <div class="bookhead">${cover}<div class="info">
      <h1>${esc(b.title)}</h1><h2>${esc(b.author)}</h2>
      <div class="figures"><div>${s.wpm ?? "–"} WPM<br>${s.acc ?? "–"} % ACC</div>
        <div>${s.chaptersDone} / ${b.chapters.length} Chapters<br>${s.pagesDone} / ${b.pages} Pages</div></div>
      <div class="progress"><div class="track"><i style="width:${(100 * s.pagesDone) / b.pages}%"></i></div>${Math.round((100 * s.pagesDone) / b.pages)}% Complete</div>
      ${id.startsWith("c-") ? `<p><button class="del">Delete this text</button></p>` : ""}
    </div></div>
    ${b.chapters.map((c, i) => {
      const n = [...Array(c.pages).keys()].filter((p) => s.done[`${i}/${p}`]).length;
      const resume = Math.min(n, c.pages - 1);
      return `<a class="chapter ${n === c.pages ? "done" : ""}" href="#/type/${encodeURIComponent(id)}/${i}/${resume}"><span>${esc(c.title)}</span><small>${n ? `${n} / ` : ""}${c.pages} Pages</small></a>`;
    }).join("")}</div>`;
  const del = $app.querySelector(".del");
  if (del) del.onclick = () => { if (confirm("Delete this text and its progress?")) { deleteBook(id); const p = progress(); delete p[id]; store.set("progress", p); location.hash = "#/"; } };
}

// ---------- typing console ----------
const EQUIV = { "‘": "'", "’": "'", "ʼ": "'", "“": '"', "”": '"', "—": "-", "–": "-", "‐": "-", "…": ".", "\n": " ", " ": " " };
// Typographic punctuation and spaces can't be typed on most keyboards, so these always map to their ASCII look-alike.
const PUNCT = { "\u202f": " ", "\u2009": " " };
// French letters/guillemets: mapped to the nearest English-keyboard key unless "exact characters" is on.
const LATIN = { "«": "<", "»": ">", "œ": "o", "Œ": "O", "æ": "a", "Æ": "A" };
const SETTINGS_DEFAULT = { exact: false, size: 17 };
const settings = () => ({ ...SETTINGS_DEFAULT, ...store.get("settings", {}) });
const applySize = () => document.documentElement.style.setProperty("--text-size", settings().size + "px");
applySize();
function matches(expected, typed) {
  if (expected === typed) return true;
  if (expected === "\n" && typed === "Enter") return true;
  if (EQUIV[expected] !== undefined || PUNCT[expected] !== undefined) return (EQUIV[expected] ?? PUNCT[expected]) === typed;
  if (settings().exact) return expected.normalize("NFC") === typed.normalize("NFC");
  return (LATIN[expected] ?? expected.normalize("NFD").replace(/[\u0300-\u036f]/g, "")) === typed;
}

async function renderConsole(id, ch, pg) {
  const book = await loadBook(id);
  const chapter = book?.chapters[ch];
  const paras = chapter?.pages[pg];
  if (!paras) return (location.hash = `#/book/${encodeURIComponent(id)}`);
  store.set("recent", [id, ...store.get("recent", []).filter((x) => x !== id)].slice(0, 12));

  const text = paras.join("\n");
  const chars = [...text];
  $crumbs.innerHTML = `<a href="#/">Books</a> / <a href="#/book/${encodeURIComponent(id)}">Chapters</a> / <b>Typing</b>`;
  const prevDisabled = ch === 0 && pg === 0 ? "disabled" : "";
  const nextDisabled = ch + 1 >= book.chapters.length && pg + 1 >= chapter.pages.length ? "disabled" : "";
  $stats.innerHTML = `<span class="chtitle">${esc(chapter.title)}</span><span>Page ${pg + 1}/${chapter.pages.length}</span><span id="wpm">— WPM</span><span id="acc">— ACC</span>
    <span class="tools"><button class="icon" id="prev" title="Previous page" aria-label="Previous page" ${prevDisabled}><svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M15 5l-7 7 7 7"/></svg></button>
    <button class="icon" id="skip" title="Next page" aria-label="Next page" ${nextDisabled}><svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M9 5l7 7-7 7"/></svg></button>
    <button class="icon" id="restart" title="Restart page" aria-label="Restart page"><svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M20 12a8 8 0 1 1-2.6-5.9"/><path d="M20 4v5h-5"/></svg></button>
    <button class="icon" id="gear" title="Settings" aria-label="Settings" aria-expanded="false"><svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3h0a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5h0a1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8v0a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z"/></svg></button></span>`;
  $app.innerHTML = `<div class="console" tabindex="0"><p class="hint">Start typing. Enter or space at paragraph ends. Backspace fixes mistakes.</p><div class="text"></div><div id="after"></div>
      <textarea id="ime" class="ime" autocomplete="off" autocapitalize="off" spellcheck="false" aria-label="Typing input"></textarea></div>
    <div class="settings" id="settings" hidden>
      <label class="check"><input type="checkbox" id="exact"> Require exact French characters<small>Off: é types as e, « as &lt;, ç as c, etc.</small></label>
      <label>Text size <output id="sizeout"></output><input type="range" id="size" min="12" max="40" step="1"></label>
    </div>`;
  const $text = $app.querySelector(".text");
  // one span per char, paragraphs as <p>; "\n" spans are invisible paragraph-end markers
  let html = "<p>";
  chars.forEach((c, i) => { html += c === "\n" ? `<span data-i="${i}"> </span></p><p>` : `<span data-i="${i}">${esc(c)}</span>`; });
  $text.innerHTML = html + "</p>";
  const spans = [...$text.querySelectorAll("span")];

  // Active time only: a gap of more than IDLE ms between keystrokes counts for nothing (timer pauses, and the idle wait is dropped).
  const IDLE = 5000;
  let active = 0, last = 0;
  const activeMs = () => active + (last && Date.now() - last <= IDLE ? Date.now() - last : 0);
  const touch = () => { const now = Date.now(); if (last && now - last <= IDLE) active += now - last; last = now; };
  let pos = 0, started = 0, keystrokes = 0, errors = 0, finished = false;
  const typed = []; // what the user typed at each position
  const setCursor = () => {
    $text.querySelector(".cur")?.classList.remove("cur");
    spans[pos]?.classList.add("cur");
    spans[pos]?.scrollIntoView({ block: "center", behavior: "smooth" });
  };
  const correctCount = () => typed.reduce((n, t, i) => n + (matches(chars[i], t) ? 1 : 0), 0);
  const tick = () => {
    if (!started) return;
    const mins = activeMs() / 60000;
    document.getElementById("wpm").textContent = `${Math.round(correctCount() / 5 / Math.max(mins, 1 / 60))} WPM`;
    document.getElementById("acc").textContent = `${Math.round((100 * (keystrokes - errors)) / keystrokes)}% ACC`;
  };
  const timer = setInterval(tick, 1000);
  const base = `#/type/${encodeURIComponent(id)}/`;
  const prevHash = pg > 0 ? `${base}${ch}/${pg - 1}` : ch > 0 ? `${base}${ch - 1}/${book.chapters[ch - 1].pages.length - 1}` : null;
  const nextPage = pg + 1 < chapter.pages.length ? `${base}${ch}/${pg + 1}` : ch + 1 < book.chapters.length ? `${base}${ch + 1}/0` : null;
  document.getElementById("prev").onclick = () => prevHash && (location.hash = prevHash);
  document.getElementById("skip").onclick = () => nextPage && (location.hash = nextPage);

  function finish() {
    finished = true; tick();
    const wpm = parseInt(document.getElementById("wpm").textContent), acc = parseInt(document.getElementById("acc").textContent);
    const p = progress(); (p[id] ||= {})[`${ch}/${pg}`] = { wpm, acc }; store.set("progress", p); sync.pushState();
    const nextHash = pg + 1 < chapter.pages.length ? `#/type/${encodeURIComponent(id)}/${ch}/${pg + 1}`
      : ch + 1 < book.chapters.length ? `#/type/${encodeURIComponent(id)}/${ch + 1}/0` : `#/book/${encodeURIComponent(id)}`;
    document.getElementById("after").innerHTML = `<div class="done-card"><b>${wpm} WPM · ${acc}% ACC</b>
      <p>Page complete.</p><a class="next" href="${nextHash}">${nextHash.includes("/type/") ? "Next Page (Enter)" : "Back to chapters"}</a></div>`;
    document.getElementById("after").scrollIntoView({ block: "center" });
    clearInterval(timer);
    onKey.next = nextHash;
  }

  function onKey(e) {
    if (e.target.closest?.("#settings")) return; // keys inside the settings menu aren't typing
    // Alt is allowed when it yields a character (AltGr / compose layouts); Alt+arrow etc. have multi-char keys and fall through below.
    if (e.ctrlKey || e.metaKey || (e.altKey && e.key.length !== 1)) return;
    if (finished) { if (e.key === "Enter") location.hash = onKey.next; return; }
    if (e.key === "Backspace") {
      e.preventDefault();
      touch();
      if (!pos) return;
      pos--; typed.pop(); spans[pos].className = "";
      spans[pos].textContent = chars[pos] === "\n" ? " " : chars[pos];
      return setCursor();
    }
    if (e.key.length !== 1 && e.key !== "Enter") return; // Dead/Process/Compose: leave to the input method; the text arrives via #ime
    e.preventDefault();
    typeKey(e.key);
  }
  function typeKey(key) {
    if (finished) return;
    started ||= Date.now();
    touch();
    keystrokes++;
    const ok = matches(chars[pos], key);
    if (!ok) errors++;
    typed.push(key);
    const s = spans[pos];
    s.className = ok ? "ok" : chars[pos] === "\n" || chars[pos] === " " ? "bad space" : "bad";
    if (!ok && key !== "Enter" && chars[pos] !== "\n") s.textContent = key; // show what was typed, like the original
    pos++;
    if (pos >= chars.length) { $text.querySelector(".cur")?.classList.remove("cur"); return finish(); }
    setCursor();
  }
  // Compose / dead-key / IME input: those keystrokes don't reach keydown as a character, so catch the result in a hidden field.
  const $ime = document.getElementById("ime");
  let composing = false;
  const flushIme = () => { const v = $ime.value; $ime.value = ""; for (const ch of v) typeKey(ch === "\n" ? "Enter" : ch); };
  $ime.addEventListener("compositionstart", () => (composing = true));
  $ime.addEventListener("compositionend", () => { composing = false; setTimeout(flushIme, 0); });
  $ime.addEventListener("input", (e) => { if (!composing && !e.isComposing) flushIme(); });
  const focusIme = () => $ime.focus({ preventScroll: true });
  $app.querySelector(".console").addEventListener("click", focusIme);
  focusIme();
  document.getElementById("restart").onclick = () => route();
  const $set = document.getElementById("settings"), $gear = document.getElementById("gear");
  const $exact = document.getElementById("exact"), $size = document.getElementById("size");
  const cur = settings();
  $exact.checked = cur.exact; $size.value = cur.size; document.getElementById("sizeout").textContent = cur.size + "px";
  $gear.onclick = (e) => { e.stopPropagation(); $set.hidden = !$set.hidden; $gear.setAttribute("aria-expanded", !$set.hidden); $gear.blur(); focusIme(); };
  $exact.onchange = () => { store.set("settings", { ...settings(), exact: $exact.checked }); focusIme(); };
  $size.oninput = () => { store.set("settings", { ...settings(), size: +$size.value }); document.getElementById("sizeout").textContent = $size.value + "px"; applySize(); };
  $size.onchange = () => focusIme(); // give keys back to the typing console
  const closeSet = (e) => { if (!$set.hidden && !$set.contains(e.target)) { $set.hidden = true; $gear.setAttribute("aria-expanded", "false"); } };
  document.addEventListener("click", closeSet);
  addEventListener("keydown", onKey);
  cleanup = () => { removeEventListener("keydown", onKey); document.removeEventListener("click", closeSet); clearInterval(timer); };
  setCursor();
  window.scrollTo(0, 0);
}

route();
