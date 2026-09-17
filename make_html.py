#!/usr/bin/env python3
"""Render egypt-pc-workstation-guide.md to a styled standalone HTML file.

- Preserves all content (stores, tables, prices, notes).
- Replaces decorative emoji with plain text (Yes / No / Note: / Tip:).
- Keeps the Arabic parenthetical "(شرق آسيا)".
- Self-contained: inline CSS, no external deps, no JS.
"""
import re
from pathlib import Path

SRC = Path(r"C:\KARIM\mca\egypt-pc-workstation-guide.md")
OUT = Path(r"C:\KARIM\mca\egypt-pc-workstation-guide.html")


def strip_emoji(text: str) -> str:
    text = text.replace("✅", "Yes")
    text = text.replace("❌", "No")
    text = re.sub(r"⚠️\s*", "Note: ", text)
    text = text.replace("⭐", "")
    text = re.sub(r"💡\s*", "Tip: ", text)
    text = re.sub(r"[ \t]{2,}", " ", text)
    return text


def inline_html(text: str) -> str:
    text = text.replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;")
    text = re.sub(r"\*\*(.+?)\*\*", r"<strong>\1</strong>", text)
    text = re.sub(r"\*([^*]+)\*", r"<em>\1</em>", text)
    return text


def is_special(line: str) -> bool:
    s = line.strip()
    return (
        not s
        or s.startswith("#")
        or s.startswith("|")
        or s.startswith("- ")
        or re.match(r"^\d+\.\s+", s) is not None
        or re.match(r"^-{3,}\s*$", s) is not None
    )


def parse_blocks(text: str):
    lines = text.split("\n")
    blocks = []
    i = 0
    while i < len(lines):
        line = lines[i].rstrip()
        s = line.strip()
        if not s:
            i += 1
            continue
        if s.startswith("|"):
            tbl = []
            while i < len(lines) and lines[i].strip().startswith("|"):
                tbl.append(lines[i].strip())
                i += 1
            rows = [[c.strip() for c in ln.strip("|").split("|")] for ln in tbl]
            blocks.append(("table", rows[0], rows[2:]))
        elif s.startswith("### "):
            blocks.append(("h3", s[4:].strip()))
            i += 1
        elif s.startswith("## "):
            blocks.append(("h2", s[3:].strip()))
            i += 1
        elif s.startswith("# "):
            blocks.append(("h1", s[2:].strip()))
            i += 1
        elif re.match(r"^-{3,}\s*$", s):
            blocks.append(("hr",))
            i += 1
        elif re.match(r"^\d+\.\s+", s):
            items = []
            while i < len(lines) and re.match(r"^\d+\.\s+", lines[i].strip()):
                m = re.match(r"^(\d+)\.\s+(.*)$", lines[i].strip())
                items.append((m.group(1), m.group(2)))
                i += 1
            blocks.append(("ol", items))
        elif s.startswith("- "):
            items = []
            while i < len(lines) and lines[i].strip().startswith("- "):
                items.append(lines[i].strip()[2:])
                i += 1
            blocks.append(("ul", items))
        else:
            paras = [s]
            i += 1
            while i < len(lines) and not is_special(lines[i]):
                paras.append(lines[i].strip())
                i += 1
            blocks.append(("p", " ".join(paras)))
    return blocks


_used_slugs = {}


def slugify(text: str) -> str:
    s = re.sub(r"\*+", "", text).lower()
    s = re.sub(r"[^\w\s-]", "", s)
    s = re.sub(r"[\s_]+", "-", s).strip("-")
    base, n = s, 2
    while s in _used_slugs:
        s = f"{base}-{n}"
        n += 1
    _used_slugs[s] = True
    return s


CSS = """
:root { color-scheme: light; }
* { box-sizing: border-box; }
body {
  font-family: "Segoe UI", -apple-system, BlinkMacSystemFont, Roboto,
               "Helvetica Neue", Arial, sans-serif;
  color: #333; background: #fff; line-height: 1.65; margin: 0;
}
.container { max-width: 960px; margin: 0 auto; padding: 2.5rem 1.5rem 4rem; }
header.doc-header { border-bottom: 2px solid #333; padding-bottom: 1.25rem; margin-bottom: 1.5rem; }
h1 { font-size: 1.75rem; line-height: 1.3; margin: 0 0 0.5rem; color: #222; }
.subtitle { font-size: 1.05rem; color: #555; margin: 0 0 0.75rem; }
.dateline {
  background: #f5f5f5; border-left: 3px solid #999;
  padding: 0.6rem 0.9rem; font-size: 0.92rem; margin: 0;
}
nav.toc {
  background: #f5f5f5; border: 1px solid #ddd;
  padding: 1rem 1.5rem; margin: 1.75rem 0 2.25rem; font-size: 0.95rem;
}
nav.toc .toc-title { font-weight: 700; margin: 0 0 0.4rem; }
nav.toc ul { margin: 0; padding-left: 1.25rem; }
nav.toc li { margin: 0.15rem 0; }
nav.toc a { color: #1a4f8a; text-decoration: none; }
nav.toc a:hover { text-decoration: underline; }
h2 {
  font-size: 1.3rem; color: #222; margin: 2.4rem 0 0.75rem;
  padding-bottom: 0.3rem; border-bottom: 1px solid #999;
}
h3 { font-size: 1.08rem; color: #222; margin: 1.6rem 0 0.5rem; }
p { margin: 0.6rem 0; }
ul, ol { margin: 0.6rem 0; padding-left: 1.5rem; }
li { margin: 0.3rem 0; }
hr { border: none; border-top: 1px solid #bbb; margin: 2rem 0; }
table {
  border-collapse: collapse; width: 100%;
  margin: 1rem 0 1.4rem; font-size: 0.9rem;
}
th, td { padding: 0.45rem 0.6rem; text-align: left; vertical-align: top; }
thead th {
  background: #f5f5f5; font-weight: 700;
  border-top: 2px solid #333; border-bottom: 1px solid #333;
}
tbody tr { border-bottom: 1px solid #ddd; }
tbody tr:nth-child(even) { background: #f5f5f5; }
tbody tr:last-child { border-bottom: 2px solid #333; }
code { background: #f5f5f5; padding: 0.1rem 0.3rem; font-size: 0.9em; }
strong { color: #222; }
@media (max-width: 640px) {
  .container { padding: 1.25rem 1rem 3rem; }
  table { font-size: 0.82rem; display: block; overflow-x: auto; }
}
"""


def main() -> None:
    raw = strip_emoji(SRC.read_text(encoding="utf-8"))
    blocks = parse_blocks(raw)

    # Header: first h1 (title), following h3 (subtitle), following p (dateline)
    title, subtitle, dateline = "", "", ""
    rest = blocks
    if blocks and blocks[0][0] == "h1":
        title = blocks[0][1]
        rest = blocks[1:]
    if rest and rest[0][0] == "h3" and rest[0][1].startswith("For a dev workstation"):
        subtitle = rest[0][1]
        rest = rest[1:]
    if rest and rest[0][0] == "p" and rest[0][1].startswith("**Research date"):
        dateline = re.sub(r"^\*\*|\*\*$", "", rest[0][1])
        rest = rest[1:]

    # Assign anchor ids to headings in a single pass (stable, unique slugs)
    heading_slugs = {}
    for idx, b in enumerate(rest):
        if b[0] in ("h2", "h3"):
            heading_slugs[idx] = slugify(b[1])

    toc_entries = [
        (b[0], heading_slugs[idx], re.sub(r"\*+", "", b[1]))
        for idx, b in enumerate(rest)
        if b[0] in ("h2", "h3")
    ]

    parts = []
    for idx, b in enumerate(rest):
        kind = b[0]
        if kind == "h2":
            parts.append(f'<h2 id="{heading_slugs[idx]}">{inline_html(b[1])}</h2>')
        elif kind == "h3":
            parts.append(f'<h3 id="{heading_slugs[idx]}">{inline_html(b[1])}</h3>')
        elif kind == "h1":
            parts.append(f"<h2>{inline_html(b[1])}</h2>")
        elif kind == "p":
            parts.append(f"<p>{inline_html(b[1])}</p>")
        elif kind == "hr":
            parts.append("<hr>")
        elif kind == "ol":
            lis = "\n".join(
                f'<li value="{n}">{inline_html(t)}</li>' for n, t in b[1]
            )
            parts.append(f"<ol>\n{lis}\n</ol>")
        elif kind == "ul":
            lis = "\n".join(f"<li>{inline_html(t)}</li>" for t in b[1])
            parts.append(f"<ul>\n{lis}\n</ul>")
        elif kind == "table":
            header, rows = b[1], b[2]
            ths = "".join(f"<th>{inline_html(h)}</th>" for h in header)
            trs = []
            for r in rows:
                tds = "".join(f"<td>{inline_html(c)}</td>" for c in r)
                trs.append(f"<tr>{tds}</tr>")
            parts.append(
                "<table>\n<thead><tr>" + ths + "</tr></thead>\n<tbody>\n"
                + "\n".join(trs)
                + "\n</tbody>\n</table>"
            )

    toc_items = "\n".join(
        f'<li style="{"margin-left:1.1rem" if lvl == "h3" else ""}">'
        f'<a href="#{sid}">{name}</a></li>'
        for lvl, sid, name in toc_entries
    )

    html = f"""<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>{inline_html(title)}</title>
<style>{CSS}</style>
</head>
<body>
<div class="container">
<header class="doc-header">
<h1>{inline_html(title)}</h1>
<p class="subtitle">{inline_html(subtitle)}</p>
<p class="dateline">{inline_html(dateline)}</p>
</header>
<nav class="toc">
<p class="toc-title">Contents</p>
<ul>
{toc_items}
</ul>
</nav>
{chr(10).join(parts)}
</div>
</body>
</html>
"""
    OUT.write_text(html, encoding="utf-8")
    print(f"Wrote {OUT} ({len(html):,} chars, {len(toc_entries)} TOC entries)")


if __name__ == "__main__":
    main()
