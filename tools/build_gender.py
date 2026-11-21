"""Build fr-gender.json (French noun -> gender).

Gender comes from Wiktionary (kaikki.org extract); Lexique 3.83 (CC BY-SA 4.0, lexique.org) decides whether a
form is mostly used as a noun, so verb forms like "voiture" or adjectives like "grand" are not colored.

  curl -sL https://kaikki.org/dictionary/French/kaikki.org-dictionary-French.jsonl | python3 tools/build_gender.py Lexique383.tsv
"""
import csv, json, sys
from collections import defaultdict

tot, nom = defaultdict(float), defaultdict(float)   # frequency of a form: over every part of speech / as a noun
with open(sys.argv[1], encoding="utf-8") as f:
    for r in csv.DictReader(f, delimiter="\t"):
        w, freq = r["ortho"].lower(), float(r["freqfilms2"] or 0) + float(r["freqlivres"] or 0) + 0.001
        tot[w] += freq
        if r["cgram"] == "NOM": nom[w] += freq

def mostly_noun(w): return w not in tot or nom[w] / tot[w] >= 0.5

seen = defaultdict(set)                              # word -> genders claimed by Wiktionary entries
for line in sys.stdin:
    try: e = json.loads(line)
    except ValueError: continue
    if e.get("pos") != "noun": continue
    for t in e.get("head_templates", []):
        if t.get("name") != "fr-noun": continue
        g = t.get("args", {}).get("1", "")
        g = {"m": "m", "f": "f", "m-p": "m", "f-p": "f"}.get(g)
        if not g: continue                            # mf, by-sense and unspecified nouns can't be colored reliably
        words = [e["word"]] + [x["form"] for x in e.get("forms", []) if "plural" in x.get("tags", [])]
        for w in words: seen[w.lower()].add(g)

out = {"m": [], "f": []}
for w, gs in seen.items():
    if len(gs) == 1 and len(w) >= 3 and w.isalpha() and mostly_noun(w): out[next(iter(gs))].append(w)
json.dump({k: " ".join(sorted(v)) for k, v in out.items()}, open("fr-gender.json", "w", encoding="utf-8"), ensure_ascii=False, separators=(",", ":"))
print({k: len(v) for k, v in out.items()})
