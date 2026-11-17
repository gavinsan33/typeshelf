"use strict";
// Optional cloud sync via Supabase. Fill in both values to turn it on; blank = local-only site.
// The publishable key is meant to be public: row level security (supabase/schema.sql) does the protecting.
const SUPABASE_URL = "";
const SUPABASE_KEY = ""; // publishable key (sb_publishable_...)

const sync = (() => {
  const off = { pushState() {}, pushBook() {}, dropBook() {} };
  if (!SUPABASE_URL || !SUPABASE_KEY || !window.supabase) return off;
  const sb = window.supabase.createClient(SUPABASE_URL, SUPABASE_KEY, { auth: { flowType: "pkce" } });
  let user = null;
  const $btn = document.getElementById("account");
  const $dlg = document.getElementById("signin");
  const say = (t) => { $btn.title = t; };
  const fail = (what, error) => { console.error(what, error); say(`Sync error: ${error.message}`); };

  function merge(local, remote) { // union of finished pages; local wins on conflict
    const out = { ...remote };
    for (const [book, pages] of Object.entries(local)) out[book] = { ...(remote[book] || {}), ...pages };
    return out;
  }

  async function pushState() {
    if (!user) return;
    const { error } = await sb.from("user_state").upsert({ user_id: user.id, progress: progress(), recent: store.get("recent", []), updated_at: new Date().toISOString() });
    if (error) fail("push state", error);
  }
  async function pushBook(b) {
    if (!user) return;
    const { error } = await sb.from("user_books").upsert({ user_id: user.id, id: b.id, title: b.title, author: b.author, chapters: b.chapters });
    if (error) return fail("push book", error);
    store.set("synced", [...new Set([...store.get("synced", []), b.id])]);
  }
  async function dropBook(id) {
    store.set("synced", store.get("synced", []).filter((x) => x !== id));
    if (!user) return;
    const { error } = await sb.from("user_books").delete().eq("id", id);
    if (error) fail("delete book", error);
    pushState();
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
      const { data, error } = await sb.from("user_books").select("id, title, author, chapters").in("id", missing);
      if (error) return fail("pull books", error);
      for (const b of data) await tx("readwrite", (s) => s.put(b));
    }
    store.set("synced", [...remote, ...local.filter((b) => !synced.has(b.id) && !remote.has(b.id)).map((b) => b.id)]);
    await pushState();
    say(`Signed in as ${user.email}. Synced.`);
    route();
  }

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
  return { pushState, pushBook, dropBook };
})();
