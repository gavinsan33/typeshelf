"use strict";
// Optional cloud sync via Supabase. Fill in both values to turn it on; blank = local-only site.
// The publishable key is meant to be public: row level security (supabase/schema.sql) does the protecting.
const SUPABASE_URL = "https://uzmjptwtunjaqdkqxaie.supabase.co";
const SUPABASE_KEY = "sb_publishable_vgIyj-RJ9Crcsp1LB6gxxQ_UJl3qbDw"; // publishable key (sb_publishable_...)

const sync = (() => {
  const off = { pushState() {}, pushBook() {}, dropBook() {} };
  if (!SUPABASE_URL || !SUPABASE_KEY || !window.supabase) return off;
  const sb = window.supabase.createClient(SUPABASE_URL, SUPABASE_KEY, { auth: { flowType: "pkce" } });
  let user = null;
  const $btn = document.getElementById("account");
  const $dlg = document.getElementById("signin");
  let coverCol = true; // flips to false if supabase/schema.sql's cover column hasn't been added yet
  const missingCover = (e) => /cover/i.test(e.message || "");
  const say = (t) => { $btn.title = t; };
  const fail = (what, error) => { console.error(what, error); say(`Sync error: ${error.message}`); };

  // Per book, the copy that is further ahead wins outright (furthest finished page, then most pages done; local on a tie).
  const furthest = (pages) => Math.max(-1, ...Object.keys(pages).map((k) => { const [c, p] = k.split("/"); return c * 1e6 + +p; }));
  function merge(local, remote) {
    const out = { ...remote };
    for (const [book, pages] of Object.entries(local)) {
      const r = remote[book];
      if (!r) { out[book] = pages; continue; }
      const [lf, rf] = [furthest(pages), furthest(r)];
      out[book] = lf > rf || (lf === rf && Object.keys(pages).length >= Object.keys(r).length) ? pages : r;
    }
    return out;
  }

  // Pull remote progress into local storage. Returns true if it changed anything.
  async function pullState() {
    const { data: st, error } = await sb.from("user_state").select("progress, recent").maybeSingle();
    if (error) { fail("pull state", error); return false; }
    const before = JSON.stringify([progress(), store.get("recent", [])]);
    store.set("progress", merge(progress(), st?.progress || {}));
    store.set("recent", [...new Set([...store.get("recent", []), ...(st?.recent || [])])].slice(0, 12));
    return before !== JSON.stringify([progress(), store.get("recent", [])]);
  }
  async function pushState(pull = true) {
    if (!user) return;
    if (pull) await pullState(); // merge first so a stale tab can't overwrite newer progress from another device
    const { error } = await sb.from("user_state").upsert({ user_id: user.id, progress: progress(), recent: store.get("recent", []), updated_at: new Date().toISOString() });
    if (error) fail("push state", error);
  }
  async function pushBook(b) {
    if (!user) return;
    const row = { user_id: user.id, id: b.id, title: b.title, author: b.author, chapters: b.chapters };
    let { error } = await sb.from("user_books").upsert(coverCol ? { ...row, cover: b.cover ?? null } : row);
    if (error && coverCol && missingCover(error)) { coverCol = false; ({ error } = await sb.from("user_books").upsert(row)); } // table predates the cover column
    if (error) return fail("push book", error);
    store.set("synced", [...new Set([...store.get("synced", []), b.id])]);
  }
  async function dropBook(id) {
    store.set("synced", store.get("synced", []).filter((x) => x !== id));
    if (!user) return;
    const { error } = await sb.from("user_books").delete().eq("id", id);
    if (error) fail("delete book", error);
    pushState(false); // don't merge remote progress back in for the book just deleted
  }

  async function fullSync() {
    say("Syncing…");
    const [{ data: st, error: e1 }, { data: ids, error: e2 }] = await Promise.all([
      sb.from("user_state").select("progress, recent").maybeSingle(),
      sb.from("user_books").select("id"),
    ]);
    if (e1 || e2) return fail("pull", e1 || e2);
    store.set("progress", merge(progress(), st?.progress || {}));
    store.set("recent", [...new Set([...store.get("recent", []), ...(st?.recent || [])])].slice(0, 12));

    const remote = new Set(ids.map((r) => r.id));
    const synced = new Set(store.get("synced", []));
    const local = await customBooks();
    for (const b of local) {
      if (remote.has(b.id)) continue;
      if (synced.has(b.id)) await tx("readwrite", (s) => s.delete(b.id)); // deleted on another device
      else await pushBook(b);                                              // new on this device
    }
    const missing = [...remote].filter((id) => !local.some((b) => b.id === id));
    if (missing.length) {
      let { data, error } = await sb.from("user_books").select(coverCol ? "id, title, author, chapters, cover" : "id, title, author, chapters").in("id", missing);
      if (error && coverCol && missingCover(error)) { coverCol = false; ({ data, error } = await sb.from("user_books").select("id, title, author, chapters").in("id", missing)); }
      if (error) return fail("pull books", error);
      for (const b of data) await tx("readwrite", (s) => s.put(b));
    }
    store.set("synced", [...remote, ...local.filter((b) => !synced.has(b.id) && !remote.has(b.id)).map((b) => b.id)]);
    await pushState();
    say(`Signed in as ${user.email}. Synced.`);
    route();
  }

  // A tab left open goes stale while other devices make progress: re-pull when it becomes visible again and periodically.
  // Don't re-render mid-typing; the next page load or push will pick the merged progress up.
  async function refresh() {
    if (!user || document.hidden) return;
    if (await pullState() && !location.hash.startsWith("#/type/")) route();
  }
  document.addEventListener("visibilitychange", refresh);
  addEventListener("focus", refresh);
  setInterval(refresh, 30000);

  $btn.hidden = false;
  $btn.onclick = async () => {
    if (user) { if (confirm(`Signed in as ${user.email}. Sign out? (Your data stays in this browser.)`)) await sb.auth.signOut(); return; }
    $dlg.showModal();
  };
  $dlg.querySelector("form").onsubmit = async (e) => {
    if (e.submitter?.value === "cancel") return;
    e.preventDefault();
    const email = $dlg.querySelector("input").value.trim();
    const { error } = await sb.auth.signInWithOtp({ email, options: { emailRedirectTo: location.origin + location.pathname } });
    $dlg.querySelector("p").textContent = error ? error.message : "Check your email and open the link in this same browser.";
  };
  sb.auth.onAuthStateChange((event, session) => {
    const was = user?.id;
    user = session?.user ?? null;
    $btn.textContent = user ? "Synced" : "Sign in";
    if (!user) say("Sign in to sync progress and uploaded books across devices");
    // defer: supabase-js warns against awaiting its own calls inside this callback
    if (user && user.id !== was) setTimeout(fullSync, 0);
  });
  // A failed email link (expired, already used, or opened in a different browser) otherwise fails silently.
  sb.auth.initialize().then(async ({ error }) => {
    // supabase-js silently skips a ?code= link when this browser never requested it
    const strayCode = new URLSearchParams(location.search).has("code") && !(await sb.auth.getSession()).data.session;
    if (!error && !strayCode) return;
    const why = strayCode || error.code === "pkce_code_verifier_not_found"
      ? "That link was opened in a different browser from the one that requested it. Request a new link here and open it in this browser."
      : `Sign-in failed: ${error.message}. Request a new link.`;
    history.replaceState(null, "", location.pathname + location.hash); // drop ?code / ?error
    $dlg.querySelector("p").textContent = why;
    $dlg.showModal();
  });
  return { pushState, pushBook, dropBook };
})();
