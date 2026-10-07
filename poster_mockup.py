"""Prepare conservative text edits over the original poster, without changing it."""

from collections import Counter
import math
import re

import pymupdf


NUMERIC_TOKEN = r"[-+\u2212\ufe63\uff0d\uff0b]?(?:\d+(?:[.,]\d+)*|\.\d+)(?:[eE][-+\u2212\ufe63\uff0d\uff0b]?\d+)?%?"
NUMERIC_SIGNS = str.maketrans({"\u2212": "-", "\ufe63": "-", "\uff0d": "-", "\uff0b": "+"})


def _numeric_tokens(text):
    return Counter(token.translate(NUMERIC_SIGNS) for token in re.findall(NUMERIC_TOKEN, text))


def _rectangle(location, dimensions, pdf_page):
    if not location or location.get("page_number") != 1:
        return None
    polygon = location.get("polygon", [])
    if len(polygon) != 8 or not all(
        isinstance(value, (int, float)) and math.isfinite(value)
        for value in polygon
    ):
        return None
    width, height = dimensions.get("width", 0), dimensions.get("height", 0)
    if width <= 0 or height <= 0:
        return None
    xs, ys = polygon[::2], polygon[1::2]
    # Rotated paragraphs cannot be faithfully replaced by horizontal text.
    if abs(ys[1] - ys[0]) > height * 0.003 or abs(xs[3] - xs[0]) > width * 0.003:
        return None
    rect = pymupdf.Rect(
        min(xs) / width * pdf_page.rect.width,
        min(ys) / height * pdf_page.rect.height,
        max(xs) / width * pdf_page.rect.width,
        max(ys) / height * pdf_page.rect.height,
    )
    if rect.is_empty or not pdf_page.rect.contains(rect):
        return None
    return rect


def _colors(page, rect, spans):
    pixmap = page.get_pixmap(
        matrix=pymupdf.Matrix(0.5, 0.5), clip=rect,
        colorspace=pymupdf.csRGB, alpha=False,
    )
    samples = pixmap.samples
    stride = 3 * max(1, len(samples) // (3 * 1500))
    pixels = [tuple(samples[i:i + 3]) for i in range(0, len(samples) - 2, stride)]
    if not pixels:
        return None
    background, count = Counter(pixels).most_common(1)[0]
    # Do not paint over photos, gradients, diagrams, or textured backgrounds.
    if count / len(pixels) < 0.75:
        return None
    span = max(spans, key=lambda item: len(item.get("text", "")))
    color = span.get("color", 0)
    return {
        "background": "#" + "".join(f"{channel:02x}" for channel in background),
        "color": f"#{color:06x}",
        "font_size": span["size"] / page.rect.width,
        "font_family": "serif" if any(
            name in span.get("font", "").lower() for name in ("times", "georgia", "cambria")
        ) else "sans-serif",
        "bold": bool(span.get("flags", 0) & 16),
    }


def prepare_mockup(review, structure, pdf_bytes):
    """Filter unsupported findings and attach safe, authoritative preview regions.

    Coordinates, colors and typography come from the source PDF, never from AI.
    The client still requires author review of suggested text. Complex graphic
    edits remain in the recommendations instead of being fabricated here.
    """
    findings = review.get("findings", [])
    accepted = {}
    for index, finding in enumerate(findings):
        if (
            finding.get("confidence") == "high"
            and finding.get("evidence", {}).get("description", "").strip()
            and finding.get("impact", "").strip()
            and finding.get("recommendation", "").strip()
        ):
            accepted[index] = len(accepted)
    review["findings"] = [findings[index] for index in accepted]
    # Never leave priorities referring to a filtered-out finding.
    priority_findings = [
        finding for finding in review["findings"]
        if finding.get("kind") == "issue" and finding.get("priority") in ("high", "medium")
    ]
    priority_findings.sort(key=lambda finding: 0 if finding["priority"] == "high" else 1)
    review["summary"]["top_priorities"] = [
        finding["recommendation"] for finding in priority_findings[:5]
    ]

    proposals = review.pop("mockup_changes", [])
    mockup = {"changes": [], "manual_drafts": [], "omitted_count": len(proposals)}
    review["mockup"] = mockup
    dimensions = next((p for p in structure.get("pages", []) if p.get("page_number") == 1), None)
    if not dimensions or not proposals:
        return review

    with pymupdf.open(stream=pdf_bytes, filetype="pdf") as document:
        if not document.page_count:
            return review
        page = document[0]
        blocks = {block["block_id"]: block for block in structure.get("content_blocks", [])}
        rectangles = {
            block_id: _rectangle(block.get("location"), dimensions, page)
            for block_id, block in blocks.items()
        }
        text_spans = [
            span for block in page.get_text("dict")["blocks"]
            for line in block.get("lines", []) for span in line["spans"]
        ]
        drawings = page.get_drawings()
        used = set()
        # Readability rewrites take priority if several proposals target one block.
        proposals = sorted(proposals, key=lambda proposal: 0 if (
            proposal.get("finding_index") in accepted
            and findings[proposal["finding_index"]].get("category") == "readability"
            and proposal.get("suggested_text", "").strip() != blocks.get(
                proposal.get("block_id"), {}).get("content", "").strip()
        ) else 1)
        manual_candidates = {}
        for proposal in proposals[:12]:
            index, block_id = proposal.get("finding_index"), proposal.get("block_id")
            if index not in accepted or block_id not in blocks or block_id in used:
                continue
            finding = findings[index]
            if block_id not in finding.get("evidence", {}).get("block_ids", []):
                continue
            block, rect = blocks[block_id], rectangles[block_id]
            original = block.get("content", "").strip()
            suggested = proposal.get("suggested_text", "").strip()
            if (original and suggested and suggested != original and len(suggested) <= 5000
                    and finding.get("category") == "readability"
                    and _numeric_tokens(original) == _numeric_tokens(suggested)
                    and block.get("role") not in ("title", "pageHeader", "pageFooter")):
                manual_candidates.setdefault(block_id, {
                    "finding_index": accepted[index], "block_id": block_id,
                    "original_text": original, "suggested_text": suggested,
                    "reason": proposal.get("reason", ""),
                    "section_name": proposal.get("section_name", finding.get("evidence", {}).get("section", "Text section")),
                    "section_purpose": proposal.get("section_purpose", ""),
                    "limitation": "This text region cannot be replaced safely while preserving the original design. Apply the rewrite in your source poster."})
            if rect is None or block.get("role") in ("title", "pageHeader", "pageFooter"):
                continue
            if any(
                other_id != block_id and other is not None
                and (rect & other).get_area() > rect.get_area() * 0.01
                for other_id, other in rectangles.items()
            ):
                continue
            if any(rect.intersects(pymupdf.Rect(image["bbox"])) for image in page.get_image_info()):
                continue
            # Flat enclosing rectangles may be section backgrounds; every other
            # intersecting vector drawing may be a figure, border or symbol.
            if any(
                rect.intersects(drawing["rect"])
                and not (
                    drawing["rect"].contains(rect)
                    and drawing.get("fill") is not None
                    and drawing.get("color") is None
                    and all(item[0] == "re" for item in drawing.get("items", []))
                )
                for drawing in drawings
            ):
                continue
            table_rectangles = [
                _rectangle(region, dimensions, page)
                for table in structure.get("tables", []) for region in table.get("bounding_regions", [])
            ]
            if any(other is not None and rect.intersects(other) for other in table_rectangles):
                continue
            original = block.get("content", "").strip()
            suggested = proposal.get("suggested_text", "").strip()
            if not original or not suggested or len(suggested) > 5000:
                continue
            # Preserve every numeric token, including repeated values and units'
            # numeric portions. This is a guard, not a scientific fact checker.
            if _numeric_tokens(original) != _numeric_tokens(suggested):
                continue
            spans = [
                span for span in text_spans
                if rect.intersects(pymupdf.Rect(span["bbox"])) and span.get("text", "").strip()
            ]
            if not spans:
                continue
            # Mixed sizes/colors, maths and rotated text need a human designer.
            if any(
                abs(span["size"] - spans[0]["size"]) > 1
                or span.get("color") != spans[0].get("color")
                or span.get("flags") != spans[0].get("flags")
                for span in spans
            ):
                continue
            style = _colors(page, rect, spans)
            if style is None:
                continue
            scale = proposal.get("font_scale", 1)
            if not isinstance(scale, (int, float)) or not math.isfinite(scale) or not 1 <= scale <= 1.35:
                continue
            if proposal.get("improve_contrast") and finding.get("category") == "accessibility":
                channels = [int(style["background"][i:i + 2], 16) for i in (1, 3, 5)]
                style["color"] = "#111111" if sum(channels) > 382 else "#ffffff"
            if suggested == original and scale == 1 and style["color"] == f"#{spans[0].get('color', 0):06x}":
                continue
            mockup["changes"].append({
                "finding_index": accepted[index], "block_id": block_id,
                "original_text": original, "suggested_text": suggested,
                "reason": proposal.get("reason", ""), "font_scale": scale,
                "section_name": proposal.get("section_name", finding.get("evidence", {}).get("section", "Text section")),
                "section_purpose": proposal.get("section_purpose", ""),
                "region": {"left": rect.x0 / page.rect.width, "top": rect.y0 / page.rect.height,
                           "width": rect.width / page.rect.width, "height": rect.height / page.rect.height},
                "style": style,
            })
            used.add(block_id)
        mockup["manual_drafts"] = [draft for block_id, draft in manual_candidates.items() if block_id not in used]
    mockup["omitted_count"] = len(proposals) - len(mockup["changes"])
    return review
