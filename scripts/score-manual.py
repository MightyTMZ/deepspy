"""Score a pasted research answer against benchmarks/helix-rubric.json with the same rule as the runner
(case-insensitive substring; `all` items need every string). Appends/replaces the entry in benchmarks/manual-results.json.

  python scripts/score-manual.py "ChatGPT Astra (browsing)" benchmarks/astra-answer-2026-09-13.md 393
"""
import json, re, sys
from pathlib import Path

name, answer_path, seconds = sys.argv[1], sys.argv[2], float(sys.argv[3]) if len(sys.argv) > 3 else None
bench = Path("benchmarks")
rubric = json.loads((bench / "helix-rubric.json").read_text(encoding="utf-8"))
norm = lambda s: re.sub(r"\s+", " ", s.lower().replace("\u2019", "'").replace("\u201c", '"').replace("\u201d", '"')).strip()
material = norm(Path(answer_path).read_text(encoding="utf-8"))
hits = [it["id"] for it in rubric["items"] if (all(norm(a) in material for a in it["accept"]) if it.get("all") else any(norm(a) in material for a in it["accept"]))]
groups = {}
for it in rubric["items"]:
    g = groups.setdefault(it["group"], [0, 0]); g[1] += 1; g[0] += it["id"] in hits
out = bench / "manual-results.json"
entries = json.loads(out.read_text(encoding="utf-8")) if out.exists() else []
entries = [e for e in entries if e.get("name") != name]
entries.append({"name": name, "hits": hits, "score": len(hits), "seconds": seconds, "source": str(answer_path).replace("\\", "/")})
out.write_text(json.dumps(entries, indent=2), encoding="utf-8")
print(f"{name}: {len(hits)} / {len(rubric['items'])}")
for g, (h, n) in groups.items(): print(f"  {g}: {h}/{n}")
print("missed:", ", ".join(it["label"] for it in rubric["items"] if it["id"] not in hits)[:600])
