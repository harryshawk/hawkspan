#!/usr/bin/env python3

from html import escape
from pathlib import Path

from reportlab import rl_config
from reportlab.lib.colors import HexColor
from reportlab.lib.enums import TA_CENTER
from reportlab.lib.pagesizes import letter
from reportlab.lib.styles import ParagraphStyle, getSampleStyleSheet
from reportlab.lib.units import inch
from reportlab.platypus import Paragraph, SimpleDocTemplate, Spacer


ROOT = Path(__file__).resolve().parents[1]
REVIEW = ROOT / "examples/simpletuner/hawkspan-robots/review/HawkSpan-Robot-Caption-Review.md"
OUTPUT = ROOT / "examples/simpletuner/hawkspan-robots/review/HawkSpan-Robot-Caption-Review-Text-Only.pdf"

rl_config.useA85 = False
styles = getSampleStyleSheet()
title = ParagraphStyle(
    "Title",
    parent=styles["Title"],
    fontName="Helvetica-Bold",
    fontSize=19,
    leading=23,
    textColor=HexColor("#17324d"),
    alignment=TA_CENTER,
    spaceAfter=14,
)
section = ParagraphStyle(
    "Section",
    parent=styles["Heading2"],
    fontName="Helvetica-Bold",
    fontSize=12,
    leading=15,
    textColor=HexColor("#1f5f78"),
    spaceBefore=12,
    spaceAfter=5,
)
caption_type = ParagraphStyle(
    "CaptionType",
    parent=styles["Heading3"],
    fontName="Helvetica-Bold",
    fontSize=9,
    leading=11,
    textColor=HexColor("#495a68"),
    spaceBefore=7,
    spaceAfter=3,
)
body = ParagraphStyle(
    "Body",
    parent=styles["BodyText"],
    fontName="Helvetica",
    fontSize=8.2,
    leading=10.4,
    textColor=HexColor("#17212b"),
    spaceAfter=4,
)


def footer(canvas, document):
    canvas.saveState()
    canvas.setFont("Helvetica", 7.5)
    canvas.setFillColor(HexColor("#687785"))
    canvas.drawString(0.65 * inch, 0.42 * inch, "HawkSpan public robot caption review")
    canvas.drawRightString(7.85 * inch, 0.42 * inch, f"Page {document.page}")
    canvas.restoreState()


story = []
for raw in REVIEW.read_text(encoding="utf-8").splitlines():
    line = raw.strip()
    if not line:
        story.append(Spacer(1, 2))
    elif line.startswith("# "):
        story.append(Paragraph(escape(line[2:]), title))
    elif line.startswith("## "):
        story.append(Paragraph(escape(line[3:]), section))
    elif line.startswith("### "):
        story.append(Paragraph(escape(line[4:]), caption_type))
    else:
        story.append(Paragraph(escape(line).replace("`", ""), body))

document = SimpleDocTemplate(
    str(OUTPUT),
    pagesize=letter,
    rightMargin=0.65 * inch,
    leftMargin=0.65 * inch,
    topMargin=0.55 * inch,
    bottomMargin=0.62 * inch,
    pageCompression=0,
    invariant=1,
    title="HawkSpan Robot Caption Review",
    author="HawkSpan Contributors",
)
document.build(story, onFirstPage=footer, onLaterPages=footer)
