"use strict";
// EPUB → {title, author, chapters: [{title, paras: [string]}]} using only browser built-ins.

async function unzip(buf) { // returns {path: async () => Uint8Array}
  const v = new DataView(buf), u8 = new Uint8Array(buf);
  let eocd = buf.byteLength - 22;
  while (eocd >= 0 && v.getUint32(eocd, true) !== 0x06054b50) eocd--;
  if (eocd < 0) throw new Error("Not a zip/EPUB file");
  const files = {};
  let p = v.getUint32(eocd + 16, true);
  for (let n = v.getUint16(eocd + 10, true); n--; ) {
    const method = v.getUint16(p + 10, true), size = v.getUint32(p + 20, true);
    const nameLen = v.getUint16(p + 28, true), local = v.getUint32(p + 42, true);
    const name = new TextDecoder().decode(u8.subarray(p + 46, p + 46 + nameLen));
    p += 46 + nameLen + v.getUint16(p + 30, true) + v.getUint16(p + 32, true);
    const start = local + 30 + v.getUint16(local + 26, true) + v.getUint16(local + 28, true);
    const raw = u8.subarray(start, start + size);
    files[name] = method === 0 ? async () => raw
      : async () => new Uint8Array(await new Response(new Blob([raw]).stream().pipeThrough(new DecompressionStream("deflate-raw"))).arrayBuffer());
  }
  return files;
}

const BLOCKS = "p,h1,h2,h3,h4,h5,h6,li,pre,blockquote,dd,dt,td";
function xml(text, type = "application/xhtml+xml") {
  const d = new DOMParser().parseFromString(text, type);
  return d.querySelector("parsererror") ? new DOMParser().parseFromString(text, "text/html") : d;
}

async function parseEpub(buf) {
  const files = await unzip(buf);
  const read = async (path) => {
    const f = files[path] ?? files[decodeURIComponent(path)];
    if (!f) throw new Error(`Missing ${path} in EPUB`);
    return new TextDecoder().decode(await f());
  };
  const opfPath = xml(await read("META-INF/container.xml"), "application/xml").querySelector("rootfile").getAttribute("full-path");
  const opf = xml(await read(opfPath), "application/xml");
  const meta = (tag) => opf.getElementsByTagName(tag)[0]?.textContent.trim();
  const resolve = (href) => decodeURIComponent(new URL(href, "http://x/" + opfPath).pathname.slice(1));
  const hrefs = {};
  for (const it of opf.getElementsByTagName("item")) hrefs[it.getAttribute("id")] = it.getAttribute("href");

  const cover = await coverImage(files, opf, resolve);
  const chapters = [];
  for (const ref of opf.getElementsByTagName("itemref")) {
    const href = hrefs[ref.getAttribute("idref")];
    if (!href || ref.getAttribute("linear") === "no") continue;
    const doc = xml(await read(resolve(href.split("#")[0])));
    const body = doc.body || doc.documentElement;
    // innermost blocks only, so <blockquote><p> isn't counted twice
    const blocks = [...body.querySelectorAll(BLOCKS)].filter((el) => !el.querySelector(BLOCKS));
    const paras = (blocks.length ? blocks : [body]).map((el) => el.textContent.replace(/\s+/g, " ").trim()).filter(Boolean);
    const heading = body.querySelector("h1,h2,h3")?.textContent.replace(/\s+/g, " ").trim();
    if (heading && paras[0] === heading) paras.shift();
    if (paras.join("").length < 200) continue; // cover, title page, nav
    chapters.push({ title: (heading || `Section ${chapters.length + 1}`).slice(0, 80), paras });
  }
  if (!chapters.length) throw new Error("No readable text found in EPUB");
  return { title: meta("dc:title") || "Untitled", author: meta("dc:creator") || "Unknown", chapters, cover };
}

// The cover is declared in the OPF: EPUB3 marks the manifest item properties="cover-image";
// EPUB2 uses <meta name="cover" content="item-id">. Returns a small JPEG data URL (or null) so it stays cheap to store and sync.
async function coverImage(files, opf, resolve) {
  try {
    const items = [...opf.getElementsByTagName("item")];
    const isImg = (i) => /^image\//.test(i.getAttribute("media-type") || "");
    const metaId = [...opf.getElementsByTagName("meta")].find((m) => m.getAttribute("name") === "cover")?.getAttribute("content");
    const item = items.find((i) => (i.getAttribute("properties") || "").split(/\s+/).includes("cover-image"))
      || items.find((i) => metaId && i.getAttribute("id") === metaId && isImg(i))
      || items.find((i) => isImg(i) && /cover/i.test(i.getAttribute("id") + " " + i.getAttribute("href")));
    if (!item) return null;
    const path = resolve(item.getAttribute("href"));
    const f = files[path] ?? files[decodeURIComponent(path)];
    if (!f) return null;
    const bmp = await createImageBitmap(new Blob([await f()], { type: item.getAttribute("media-type") || "image/jpeg" }));
    const w = Math.min(200, bmp.width), h = Math.round((bmp.height * w) / bmp.width);
    const c = document.createElement("canvas"); c.width = w; c.height = h;
    const g = c.getContext("2d"); g.fillStyle = "#fff"; g.fillRect(0, 0, w, h); g.drawImage(bmp, 0, 0, w, h);
    return c.toDataURL("image/jpeg", 0.8);
  } catch { return null; } // unsupported format (e.g. SVG cover): fall back to the placeholder
}
