"""Fetch public-domain books from Project Gutenberg and split into chapters/pages.
Run: python3 tools/build_books.py   (writes books/*.json and covers/*.jpg)"""
import json, re, urllib.request, pathlib

BOOKS = [  # (gutenberg id, slug, title, author)
    (84, "frankenstein", "Frankenstein", "Mary Shelley"),
    (1342, "pride-and-prejudice", "Pride and Prejudice", "Jane Austen"),
    (11, "alice-in-wonderland", "Alice in Wonderland", "Lewis Carroll"),
    (345, "dracula", "Dracula", "Bram Stoker"),
    (1661, "sherlock-holmes", "The Adventures of Sherlock Holmes", "Arthur Conan Doyle", r"^\s*[IVX]+\. [A-Z][A-Z \-'’]+$"),
    (5200, "metamorphosis", "Metamorphosis", "Franz Kafka"),
    (64317, "the-great-gatsby", "The Great Gatsby", "F. Scott Fitzgerald", r"^\s*[IVXL]+\.?\s*$"),
    (43, "jekyll-and-hyde", "Dr. Jekyll and Mr. Hyde", "Robert Louis Stevenson"),
    (46, "a-christmas-carol", "A Christmas Carol", "Charles Dickens"),
    (215, "call-of-the-wild", "The Call of the Wild", "Jack London"),
    (174, "dorian-gray", "The Picture of Dorian Gray", "Oscar Wilde"),
    (16, "peter-pan", "Peter Pan", "J. M. Barrie"),
    (132, "the-art-of-war", "The Art of War", "Sun Tzu"),
    (120, "treasure-island", "Treasure Island", "Robert Louis Stevenson", r"^\s*[IVXL]+\.?\s*$"),
    (2701, "moby-dick", "Moby-Dick", "Herman Melville"),
    (2680, "meditations", "Meditations", "Marcus Aurelius", r"^THE \w+ BOOK\s*$"),
]
PAGE_CHARS = 1500
HEAD = re.compile(r"^\s*(chapter|letter|stave|book|part|adventure|story)\b[\s.]*([0-9ivxlc]+|the\s+\w+|one|two|three|four|five|six|seven|eight|nine|ten)\b.*$|^\s*[IVXLC]+\.\s*$|^\s*[IVXLC]+\.\s+[A-Z][A-Z ,'’\-]+$", re.I)
ROOT = pathlib.Path(__file__).resolve().parent.parent

def get(url):
    req = urllib.request.Request(url, headers={"User-Agent": "typeshelf-build"})
    return urllib.request.urlopen(req, timeout=60).read()

def strip_gutenberg(t):
    t = t.replace("\r\n", "\n")
    s = re.search(r"\*\*\* ?START OF.*?\*\*\*", t); e = re.search(r"\*\*\* ?END OF", t)
    return t[s.end() if s else 0 : e.start() if e else len(t)]

def clean(p):
    p = re.sub(r"\[(Illustration|Footnote)[^\]]*\]", "", p)  # Gutenberg markup
    return re.sub(r"\s+", " ", p.replace("_", "")).strip()  # _italics_ markers

def paragraphs(block):
    return [c for c in map(clean, re.split(r"\n\s*\n", block)) if c]

def paginate(paras):
    pages, cur = [], []
    for p in paras:
        if cur and sum(map(len, cur)) + len(p) > PAGE_CHARS:
            pages.append(cur); cur = []
        cur.append(p)
    return pages + ([cur] if cur else [])

def chapters(text, pat=None):
    head = re.compile(pat) if pat else HEAD
    lines = text.split("\n")
    idx = [i for i, l in enumerate(lines) if head.match(l) and len(l.strip()) < 80]
    secs = []
    for a, b in zip(idx, idx[1:] + [len(lines)]):
        body = "\n".join(lines[a + 1 : b])
        if len(body.strip()) > 800:  # skips table-of-contents hits
            secs.append((lines[a].strip().rstrip("."), paragraphs(body)))
    # a repeated heading means the earlier hit was a table of contents: keep the later one
    seen = {}
    for i, (t, _) in enumerate(secs):
        seen[t.lower()] = i
    secs = [s for i, s in enumerate(secs) if seen[s[0].lower()] == i]
    if len(secs) < 2:  # ponytail: no headings found → fixed-size sections
        ps = paragraphs(text)
        secs = [(f"Part {i // 40 + 1}", ps[i : i + 40]) for i in range(0, len(ps), 40)]
    return [{"title": t, "pages": paginate(ps)} for t, ps in secs]

def main():
    (ROOT / "books").mkdir(exist_ok=True); (ROOT / "covers").mkdir(exist_ok=True)
    index = []
    for gid, slug, title, author, *pat in BOOKS:
        raw = get(f"https://gutenberg.pglaf.org/cache/epub/{gid}/pg{gid}.txt").decode("utf-8", "replace")
        chs = chapters(strip_gutenberg(raw), *pat)
        (ROOT / "books" / f"{slug}.json").write_text(json.dumps({"title": title, "author": author, "chapters": chs}, ensure_ascii=False))
        try:
            (ROOT / "covers" / f"{slug}.jpg").write_bytes(get(f"https://gutenberg.pglaf.org/cache/epub/{gid}/pg{gid}.cover.medium.jpg"))
        except Exception as e:
            print("  no cover:", e)
        pages = sum(len(c["pages"]) for c in chs)
        index.append({"id": slug, "title": title, "author": author, "chapters": [{"title": c["title"], "pages": len(c["pages"])} for c in chs], "pages": pages})
        print(f"{title}: {len(chs)} chapters, {pages} pages")
    (ROOT / "books" / "index.json").write_text(json.dumps(index, ensure_ascii=False, indent=1))

if __name__ == "__main__":
    main()
