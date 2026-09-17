#!/usr/bin/env python3
"""Build egypt-pc-workstation-guide.pdf with ReportLab.

- A4, centered cover page, header (doc title) + footer (page number) on later pages.
- Three-line tables (1.5pt top, 0.75pt header-bottom, 1.5pt bottom), no vertical
  lines, no colored backgrounds, 6pt padding, Paragraph cells that wrap.
- Emoji replaced with plain text; Arabic parenthetical replaced with
  "East Asia (eastasiaeg.com)" (ReportLab can't shape RTL text).
- Non-WinAnsi characters (arrows, approx sign) are transliterated and any
  remainder is reported as a warning.
"""
import re
from pathlib import Path

from reportlab.lib.pagesizes import A4
from reportlab.lib.units import cm
from reportlab.lib import colors
from reportlab.lib.styles import ParagraphStyle
from reportlab.lib.enums import TA_CENTER
from reportlab.platypus import (
    BaseDocTemplate, PageTemplate, Frame, Paragraph, Spacer, Table, TableStyle,
    PageBreak, NextPageTemplate, HRFlowable,
)

SRC = Path(r"C:\KARIM\mca\egypt-pc-workstation-guide.md")
OUT = Path(r"C:\KARIM\mca\egypt-pc-workstation-guide.pdf")

DOC_TITLE = "Egyptian PC Hardware Stores & Workstation Buying Guide"
DOC_SUBTITLE = ("For a dev workstation: running Kimi Code / AI coding tools, "
                "IDEs, Docker, emulators, heavy multitasking")
DOC_DATE = "15 September 2026"

PAGE_W, PAGE_H = A4
MARGIN = 2.5 * cm
AVAIL_W = PAGE_W - 2 * MARGIN  # 16 cm usable

BODY_COLOR = colors.HexColor("#333333")

_bad_chars = {}


def strip_emoji(text: str) -> str:
    text = text.replace("✅", "Yes")
    text = text.replace("❌", "No")
    text = re.sub(r"⚠️\s*", "Note: ", text)
    text = text.replace("⭐", "")
    text = re.sub(r"💡\s*", "Tip: ", text)
    text = re.sub(r"[ \t]{2,}", " ", text)
    return text


def sanitize_pdf(text: str) -> str:
    text = strip_emoji(text)
    # ReportLab standard fonts cannot shape Arabic RTL: replace any
    # parenthetical containing Arabic with the store's latin domain.
    text = re.sub(r"\([^)]*[\u0600-\u06FF][^)]*\)", "(eastasiaeg.com)", text)
    text = text.replace("\u2192", "->")   # rightwards arrow, not in WinAnsi
    text = text.replace("\u2248", "~")    # almost-equal, not in WinAnsi
    return text


def check_encodable(text: str, where: str) -> None:
    for ch in text:
        try:
            ch.encode("cp1252")
        except UnicodeEncodeError:
            _bad_chars.setdefault(ch, set()).add(where)


def inline(text: str) -> str:
    text = sanitize_pdf(text)
    check_encodable(text, text[:60])
    text = text.replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;")
    text = re.sub(r"\*\*(.+?)\*\*", r"<b>\1</b>", text)
    text = re.sub(r"\*([^*]+)\*", r"<i>\1</i>", text)
    return text


# ---------------------------------------------------------------- markdown ---
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
        s = lines[i].strip()
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


# ----------------------------------------------------------------- tables ----
def compute_widths(header, rows):
    ncols = len(header)
    weights = []
    for c in range(ncols):
        texts = [header[c]] + [r[c] for r in rows]
        lens = [len(re.sub(r"\*+", "", sanitize_pdf(t))) for t in texts]
        weights.append(min(max(max(lens), 4), 40))
    total = float(sum(weights))
    widths = [AVAIL_W * w / total for w in weights]
    minw = 1.1 * cm
    for _ in range(12):
        small = [i for i, w in enumerate(widths) if w < minw]
        if not small:
            break
        deficit = sum(minw - widths[i] for i in small)
        for i in small:
            widths[i] = minw
        big = [i for i in range(ncols) if i not in small]
        bigsum = sum(widths[i] for i in big)
        if bigsum <= 0:
            break
        for i in big:
            widths[i] -= deficit * widths[i] / bigsum
    return widths


def make_table(header, rows):
    ncols = len(header)
    fs = 8 if ncols >= 6 else 8.5
    cell = ParagraphStyle("cell", fontName="Helvetica", fontSize=fs,
                          leading=fs + 2.5, textColor=BODY_COLOR)
    head = ParagraphStyle("head", parent=cell, fontName="Helvetica-Bold",
                          textColor=colors.black)
    data = [[Paragraph(inline(h), head) for h in header]]
    for r in rows:
        data.append([Paragraph(inline(c), cell) for c in r])
    t = Table(data, colWidths=compute_widths(header, rows), repeatRows=1)
    t.setStyle(TableStyle([
        ("LINEABOVE", (0, 0), (-1, 0), 1.5, colors.black),
        ("LINEBELOW", (0, 0), (-1, 0), 0.75, colors.black),
        ("LINEBELOW", (0, -1), (-1, -1), 1.5, colors.black),
        ("VALIGN", (0, 0), (-1, -1), "TOP"),
        ("TOPPADDING", (0, 0), (-1, -1), 6),
        ("BOTTOMPADDING", (0, 0), (-1, -1), 6),
        ("LEFTPADDING", (0, 0), (-1, -1), 6),
        ("RIGHTPADDING", (0, 0), (-1, -1), 6),
    ]))
    return t


# ------------------------------------------------------------- page frames ---
def on_main(canvas, doc):
    canvas.saveState()
    canvas.setFont("Helvetica", 8)
    canvas.setFillColor(colors.HexColor("#555555"))
    canvas.drawString(MARGIN, PAGE_H - 1.5 * cm, DOC_TITLE)
    canvas.setStrokeColor(colors.HexColor("#999999"))
    canvas.setLineWidth(0.5)
    canvas.line(MARGIN, PAGE_H - 1.7 * cm, PAGE_W - MARGIN, PAGE_H - 1.7 * cm)
    canvas.setFont("Helvetica", 9)
    canvas.drawCentredString(PAGE_W / 2, 1.4 * cm, str(canvas.getPageNumber()))
    canvas.restoreState()


def main() -> None:
    blocks = parse_blocks(SRC.read_text(encoding="utf-8"))

    # Skip the leading h1 (title) and the subtitle h3 — both live on the cover.
    rest = blocks
    if rest and rest[0][0] == "h1":
        rest = rest[1:]
    if rest and rest[0][0] == "h3" and rest[0][1].startswith("For a dev workstation"):
        rest = rest[1:]

    st_h2 = ParagraphStyle("H2", fontName="Helvetica-Bold", fontSize=14,
                           leading=17, spaceBefore=18, spaceAfter=6,
                           textColor=colors.black, keepWithNext=1)
    st_h3 = ParagraphStyle("H3", fontName="Helvetica-Bold", fontSize=11.5,
                           leading=14, spaceBefore=12, spaceAfter=4,
                           textColor=colors.black, keepWithNext=1)
    st_body = ParagraphStyle("Body", fontName="Helvetica", fontSize=9.5,
                             leading=13.5, spaceAfter=6, textColor=BODY_COLOR)
    st_list = ParagraphStyle("List", parent=st_body, leftIndent=16,
                             firstLineIndent=-16, spaceAfter=4)

    story = []
    for b in rest:
        kind = b[0]
        if kind == "h2":
            story.append(Paragraph(inline(b[1]), st_h2))
        elif kind == "h3":
            story.append(Paragraph(inline(b[1]), st_h3))
        elif kind == "h1":
            story.append(Paragraph(inline(b[1]), st_h2))
        elif kind == "p":
            story.append(Paragraph(inline(b[1]), st_body))
        elif kind == "hr":
            story.append(HRFlowable(width="100%", thickness=0.5,
                                    color=colors.HexColor("#BBBBBB"),
                                    spaceBefore=10, spaceAfter=10))
        elif kind == "ol":
            for n, t in b[1]:
                story.append(Paragraph(f"{n}.&nbsp;&nbsp;{inline(t)}", st_list))
        elif kind == "ul":
            for t in b[1]:
                story.append(Paragraph(f"\u2022&nbsp;&nbsp;{inline(t)}", st_list))
        elif kind == "table":
            # No spacer before the table: keepWithNext on the preceding heading
            # must bind directly to the table, otherwise the heading can be
            # orphaned at a page bottom.
            story.append(make_table(b[1], b[2]))
            story.append(Spacer(1, 6))

    cover_title = ParagraphStyle("CoverTitle", fontName="Helvetica-Bold",
                                 fontSize=23, leading=28, alignment=TA_CENTER,
                                 textColor=colors.black)
    cover_sub = ParagraphStyle("CoverSub", fontName="Helvetica", fontSize=11.5,
                               leading=16, alignment=TA_CENTER,
                               textColor=colors.HexColor("#555555"))
    cover_date = ParagraphStyle("CoverDate", fontName="Helvetica", fontSize=11,
                                leading=14, alignment=TA_CENTER,
                                textColor=colors.HexColor("#555555"))
    cover = [
        Spacer(1, 6.5 * cm),
        Paragraph(DOC_TITLE.replace("&", "&amp;"), cover_title),
        Spacer(1, 0.9 * cm),
        Paragraph(DOC_SUBTITLE, cover_sub),
        Spacer(1, 1.4 * cm),
        Paragraph(DOC_DATE, cover_date),
        NextPageTemplate("Main"),
        PageBreak(),
    ]

    frame_cover = Frame(MARGIN, 2.2 * cm, AVAIL_W, PAGE_H - 4.4 * cm, id="cover")
    frame_main = Frame(MARGIN, 2.2 * cm, AVAIL_W, PAGE_H - 4.6 * cm, id="main")
    doc = BaseDocTemplate(
        str(OUT), pagesize=A4,
        leftMargin=MARGIN, rightMargin=MARGIN,
        topMargin=2.2 * cm, bottomMargin=2.2 * cm,
        title=DOC_TITLE, author="Research compiled 15 September 2026",
    )
    doc.addPageTemplates([
        PageTemplate(id="Cover", frames=[frame_cover]),
        PageTemplate(id="Main", frames=[frame_main], onPage=on_main),
    ])
    doc.build(cover + story)

    print(f"Wrote {OUT}")
    if _bad_chars:
        print("WARNING - characters not encodable in WinAnsi:")
        for ch, where in _bad_chars.items():
            print(f"  U+{ord(ch):04X} {ch!r} in e.g. {sorted(where)[0]!r}")
    else:
        print("All text encodable in WinAnsi (no broken-glyph risk).")


if __name__ == "__main__":
    main()
