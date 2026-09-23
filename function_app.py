import json
import os
import uuid
import base64
from pathlib import Path

import azure.functions as func
import pymupdf
from azure.ai.documentintelligence import DocumentIntelligenceClient
from azure.core.credentials import AzureKeyCredential
from azure.storage.blob import BlobServiceClient, ContentSettings
from openai import AzureOpenAI
from knowledge_base import (
    load_guidance_records,
    search_guidance
)

app = func.FunctionApp(http_auth_level=func.AuthLevel.ANONYMOUS)

MAX_FILE_SIZE = 25 * 1024 * 1024  # 25 MB
KNOWLEDGE_ROOT = Path(__file__).parent / "knowledge"


def get_blob_service_client():
    """Create the PosterIQ Azure Blob Storage client."""
    connection_string = os.environ.get(
        "POSTERIQ_STORAGE_CONNECTION_STRING"
    )

    if not connection_string:
        raise RuntimeError(
            "PosterIQ storage connection is not configured."
        )

    return BlobServiceClient.from_connection_string(
        connection_string
    )


def get_document_intelligence_client():
    """Create the PosterIQ Azure Document Intelligence client."""
    endpoint = os.environ.get("POSTERIQ_DOCINTEL_ENDPOINT")
    key = os.environ.get("POSTERIQ_DOCINTEL_KEY")

    if not endpoint or not key:
        raise RuntimeError(
            "PosterIQ Document Intelligence is not configured."
        )

    return DocumentIntelligenceClient(
        endpoint=endpoint,
        credential=AzureKeyCredential(key)
    )

def get_openai_client():
    """
    Create the Azure OpenAI client used for PosterIQ reviews.
    """
    endpoint = os.environ["POSTERIQ_OPENAI_ENDPOINT"]
    api_key = os.environ["POSTERIQ_OPENAI_KEY"]

    return AzureOpenAI(
        azure_endpoint=endpoint,
        api_key=api_key,
        api_version="2024-10-21"
    )

def polygon_to_list(polygon):
    """Convert an Azure polygon to a JSON-safe list."""
    if not polygon:
        return []

    return list(polygon)


def get_paragraph_location(paragraph):
    """Return the primary location of a paragraph."""
    if not paragraph.bounding_regions:
        return None

    region = paragraph.bounding_regions[0]

    return {
        "page_number": region.page_number,
        "polygon": polygon_to_list(region.polygon)
    }


def build_posteriq_structure(result):
    """
    Convert Document Intelligence output into a PosterIQ representation
    while preserving content, hierarchy, and spatial information.
    """

    pages = []

    for page in result.pages or []:
        pages.append({
            "page_number": page.page_number,
            "width": page.width,
            "height": page.height,
            "unit": page.unit
        })

    title = None
    content_blocks = []
    headings = []
    tables = []

    # Preserve every paragraph as an independent positioned block.
    for index, paragraph in enumerate(result.paragraphs or []):
        content = (paragraph.content or "").strip()

        if not content:
            continue

        location = get_paragraph_location(paragraph)

        block = {
            "block_id": index,
            "content": content,
            "role": paragraph.role,
            "location": location
        }

        content_blocks.append(block)

        if paragraph.role == "title" and title is None:
            title = {
                "content": content,
                "block_id": index,
                "location": location
            }

        if paragraph.role == "sectionHeading":
            headings.append({
                "content": content,
                "block_id": index,
                "location": location
            })

    # Preserve tables independently from text headings.
    for table_number, table in enumerate(
        result.tables or [],
        start=1
    ):
        cells = []

        for cell in table.cells or []:
            cells.append({
                "row_index": cell.row_index,
                "column_index": cell.column_index,
                "content": cell.content
            })

        bounding_regions = []

        for region in table.bounding_regions or []:
            bounding_regions.append({
                "page_number": region.page_number,
                "polygon": polygon_to_list(region.polygon)
            })

        tables.append({
            "table_number": table_number,
            "row_count": table.row_count,
            "column_count": table.column_count,
            "cells": cells,
            "bounding_regions": bounding_regions
        })

    # Basic layout statistics. These are measurements rather than
    # judgments; later PosterIQ stages can interpret them.
    layout = {
        "page_count": len(pages),
        "content_block_count": len(content_blocks),
        "heading_count": len(headings),
        "table_count": len(tables)
    }

    return {
        "title": title,

        # Physical poster/page information.
        "pages": pages,

        # Every positioned paragraph detected by Azure.
        "content_blocks": content_blocks,

        # Visual headings detected by Azure. PosterIQ does not yet
        # assume that every heading is a major scientific section.
        "headings": headings,

        # Structured tables and their physical locations.
        "tables": tables,

        # Simple measurable layout information.
        "layout": layout,

        # Original extracted text remains available for downstream
        # scientific/content analysis.
        "full_text": result.content or ""
    }

def render_poster_image(pdf_bytes):
    """
    Render the first page of a poster PDF as a PNG for
    downstream visual analysis.
    """

    document = pymupdf.open(
        stream=pdf_bytes,
        filetype="pdf"
    )

    try:
        if document.page_count == 0:
            raise ValueError("The PDF contains no pages.")

        page = document[0]

        # 2x rendering provides a useful balance between visual
        # detail and image size for poster analysis.
        matrix = pymupdf.Matrix(2, 2)

        pixmap = page.get_pixmap(
            matrix=matrix,
            alpha=False
        )

        png_bytes = pixmap.tobytes("png")

        return {
            "bytes": png_bytes,
            "width": pixmap.width,
            "height": pixmap.height
        }

    finally:
        document.close()
        
def get_review_guidance():
    """
    Retrieve a small set of curated guidance records for poster review.

    The MVP uses keyword retrieval. Later this can be replaced with
    semantic/vector retrieval without changing the review pipeline.
    """
    queries = [
        "poster readability font contrast white space",
        "visual hierarchy figures graphics alignment",
        "poster sections title introduction methods results conclusion",
        "concise text bullets jargon audience key message"
    ]

    guidance_by_id = {}

    for query in queries:
        matches = search_guidance(query, limit=5)

        for match in matches:
            record = match["record"]
            reference_id = record.get("reference_id")

            if reference_id:
                guidance_by_id[reference_id] = record

    return list(guidance_by_id.values())        

def build_review_context(poster_structure, guidance_records):
    """
    Build the text context supplied to the PosterIQ review model.
    """

    guidance = []

    for record in guidance_records:
        guidance.append({
            "reference_id": record.get("reference_id"),
            "category": record.get("category"),
            "source": record.get("source"),
            "source_section": record.get("source_section"),
            "guidance": record.get("guidance"),
            "applies_to": record.get("applies_to", [])
        })

    return {
        "poster": {
            "title": poster_structure.get("title"),
            "pages": poster_structure.get("pages", []),
            "content_blocks": poster_structure.get(
                "content_blocks",
                []
            ),
            "headings": poster_structure.get("headings", []),
            "tables": poster_structure.get("tables", []),
            "layout": poster_structure.get("layout", {}),
            "full_text": poster_structure.get("full_text", "")
        },
        "curated_guidance": guidance
    }
 
POSTERIQ_REVIEW_SYSTEM_PROMPT = """
You are PosterIQ, an AI assistant that reviews scientific research posters.

You will receive:
1. Structured poster content extracted from the PDF.
2. Spatial information about poster elements.
3. A rendered image of the poster.
4. Curated guidance records supplied by PosterIQ.

Evaluate the poster across these categories:
- scientific_content
- statistics
- visual_design
- readability
- accessibility
- required_elements

IMPORTANT EVIDENCE RULES

Base findings on evidence visible in the supplied poster content, tables,
layout data, or rendered image.

Do not invent missing poster content, statistical results, design properties,
institutional requirements, or source material.

CURATED GUIDANCE RULES

The curated guidance supplied in the request is the only material you may
describe as a curated standard.

When a recommendation is directly supported by a supplied guidance record:
- guidance.type must be "curated_standard"
- guidance.reference_id must exactly match that record's reference_id
- guidance.source must match the supplied source
- guidance.section must identify the supplied source section

Never invent a reference_id, source, section, requirement, or institutional
standard.

GENERAL SUGGESTION RULES

You may identify useful issues that are not covered by the supplied curated
guidance.

For these:
- guidance.type must be "general_suggestion"
- guidance.source must be null
- guidance.section must be null
- guidance.reference_id must be null

Do not present a general suggestion as an institutional requirement.

STATISTICS

Evaluate statistical reporting when the poster provides enough evidence to
do so.

If no statistical guidance record has been supplied, statistical
recommendations must be labeled as general suggestions.

Do not invent analyses, sample sizes, statistical tests, effect estimates,
confidence intervals, p-values, or results that are not present.

VISUAL REVIEW

Use the rendered poster image for judgments involving visual hierarchy,
contrast, density, whitespace, alignment, graphics, tables, and overall
legibility.

Use extracted spatial information as additional evidence.

PRIORITIZATION

Use:
- high: likely to materially affect interpretation, scientific clarity,
  accessibility, or the reader's ability to understand the poster.
- medium: meaningful improvement that does not fundamentally prevent
  understanding.
- low: refinement or polish.

OUTPUT

Return only valid JSON conforming to the PosterIQ review schema supplied
with the request.

Do not include markdown, commentary, or text outside the JSON object.
"""

def load_review_schema():
    """
    Load the PosterIQ structured review JSON schema.
    """
    schema_path = os.path.join(
        os.path.dirname(__file__),
        "schemas",
        "review.schema.json"
    )

    with open(schema_path, "r", encoding="utf-8") as file:
        return json.load(file)

def generate_poster_review(
    poster_id,
    poster_structure,
    poster_image_bytes,
    guidance_records
):
    """
    Generate a structured PosterIQ review using extracted poster data,
    the rendered poster image, and curated guidance.
    """
    client = get_openai_client()
    deployment = os.environ["POSTERIQ_OPENAI_DEPLOYMENT"]

    review_context = build_review_context(
        poster_structure,
        guidance_records
    )

    review_context["poster_id"] = poster_id

    review_schema = load_review_schema()

    image_base64 = base64.b64encode(
        poster_image_bytes
    ).decode("utf-8")

    response = client.chat.completions.create(
        model=deployment,
        messages=[
            {
                "role": "system",
                "content": POSTERIQ_REVIEW_SYSTEM_PROMPT
            },
            {
                "role": "user",
                "content": [
                    {
                        "type": "text",
                        "text": (
                            "Review this research poster using the supplied "
                            "poster evidence and curated guidance.\n\n"
                            "POSTERIQ INPUT:\n"
                            + json.dumps(review_context)
                        )
                    },
                    {
                        "type": "image_url",
                        "image_url": {
                            "url": (
                                "data:image/png;base64,"
                                + image_base64
                            ),
                            "detail": "low"
                        }
                    }
                ]
            }
        ],
        response_format={
            "type": "json_schema",
            "json_schema": {
                "name": "posteriq_review",
                "strict": True,
                "schema": review_schema
            }
        },
        max_completion_tokens=6000
    )

    choice = response.choices[0]
    review_text = choice.message.content

    print(
        "PosterIQ model response: "
        f"finish_reason={choice.finish_reason}, "
        f"content_length={len(review_text or '')}"
    )

    if not review_text:
        raise RuntimeError(
            "Azure OpenAI returned no review content. "
            f"finish_reason={choice.finish_reason}"
        )

    
    review = json.loads(review_text)

    return validate_review_guidance(
        review,
        guidance_records
    )
 
def validate_review_guidance(review, guidance_records):
    """
    Enforce PosterIQ guidance provenance after model generation.

    Curated citations are resolved against the actual knowledge records.
    Unknown or unsupported references are converted to general suggestions.
    """
    guidance_by_id = {
        record.get("reference_id"): record
        for record in guidance_records
        if record.get("reference_id")
    }

    for finding in review.get("findings", []):
        guidance = finding.get("guidance", {})
        guidance_type = guidance.get("type")
        reference_id = guidance.get("reference_id")

        if guidance_type == "curated_standard":
            record = guidance_by_id.get(reference_id)

            if record:
                # PosterIQ, not the model, supplies authoritative provenance.
                guidance["source"] = record.get("source")
                guidance["section"] = record.get("source_section")
                guidance["reference_id"] = record.get("reference_id")
                guidance["text"] = (
                    record.get("guidance", {}).get("text")
                )

            else:
                # Never allow an invented or unavailable citation to appear
                # as curated guidance.
                guidance["type"] = "general_suggestion"
                guidance["source"] = None
                guidance["section"] = None
                guidance["reference_id"] = None
                guidance["text"] = None

        else:
            # General suggestions must never carry institutional provenance.
            guidance["type"] = "general_suggestion"
            guidance["source"] = None
            guidance["section"] = None
            guidance["reference_id"] = None
            guidance["text"] = None

    return review
def add_finding_locations(review, poster_structure):
    """
    Resolve finding block IDs to physical poster locations.

    Azure OpenAI identifies the evidence using block_ids.
    PosterIQ then deterministically resolves those IDs against
    Document Intelligence output. The model does not generate
    or modify poster coordinates.
    """

    blocks_by_id = {
        block.get("block_id"): block
        for block in poster_structure.get("content_blocks", [])
        if block.get("block_id") is not None
    }

    for finding in review.get("findings", []):
        evidence = finding.get("evidence", {})
        block_ids = evidence.get("block_ids", [])

        locations = []

        for block_id in block_ids:
            block = blocks_by_id.get(block_id)

            if not block:
                continue

            location = block.get("location")

            if not location:
                continue

            locations.append({
                "block_id": block_id,
                "page_number": location.get("page_number"),
                "polygon": location.get("polygon", [])
            })

        evidence["locations"] = locations

    review["poster_layout"] = {
        "pages": poster_structure.get("pages", [])
    }

    return review
# ============================================================
# KNOWLEDGE MANAGER
# ============================================================

@app.route(
    route="knowledge",
    methods=["GET"],
    auth_level=func.AuthLevel.ANONYMOUS
)
def get_knowledge(req: func.HttpRequest) -> func.HttpResponse:
    """
    Return curated PosterIQ knowledge records for the
    Knowledge Manager.

    Read-only MVP endpoint.
    """

    try:
        records = load_guidance_records()
        
        source_documents = {}
        public_records = []

        for record in records:
            guidance = record.get("guidance", {})
            source = record.get("source")

            if source and source not in source_documents:
                source_documents[source] = {
                    "title": source,
                    "organization": record.get("source_organization"),
                    "date": record.get("source_date"),
                    "curation_status": record.get("curation_status"),
                    "knowledge_file": record.get("_knowledge_file")
                }
            public_records.append({
                "reference_id": record.get("reference_id"),
                "category": record.get("category"),
                "knowledge_file": record.get("_knowledge_file"),
                "source_page": record.get("source_page"),
                "source_section": record.get("source_section"),
                "source": record.get("source"),
                "source_organization": record.get("source_organization"),
                "source_date": record.get("source_date"),
                "curation_status": record.get("curation_status"),
                "title": guidance.get("title"),
                "text": guidance.get("text"),
                "applies_to": record.get("applies_to", []),
                "keywords": record.get("keywords", [])
            })

        return func.HttpResponse(
            json.dumps({
                "count": len(public_records),
                "sources": list(source_documents.values()),
                "records": public_records
            }),
            mimetype="application/json",
            status_code=200
        )

    except Exception as exc:
        print(
            "PosterIQ knowledge manager error: "
            f"{type(exc).__name__}: {exc}"
        )

        return func.HttpResponse(
            json.dumps({
                "error": "Unable to load PosterIQ knowledge."
            }),
            mimetype="application/json",
            status_code=500
        )


@app.route(
    route="knowledge",
    methods=["POST"],
    auth_level=func.AuthLevel.ANONYMOUS
)
def create_knowledge(req: func.HttpRequest) -> func.HttpResponse:
    """
    Add a curated guidance record to a local PosterIQ
    knowledge document.
    """

    try:
        payload = req.get_json()

        required_fields = [
            "knowledge_file",
            "reference_id",
            "category",
            "source_section",
            "title",
            "text"
        ]

        missing_fields = [
            field
            for field in required_fields
            if not payload.get(field)
        ]

        if missing_fields:
            return func.HttpResponse(
                json.dumps({
                    "error": "Missing required fields.",
                    "fields": missing_fields
                }),
                mimetype="application/json",
                status_code=400
            )

        knowledge_file = payload["knowledge_file"]

        records = load_guidance_records()

        valid_files = {
            record.get("_knowledge_file")
            for record in records
            if record.get("_knowledge_file")
        }

        if knowledge_file not in valid_files:
            return func.HttpResponse(
                json.dumps({
                    "error": "Unknown knowledge document."
                }),
                mimetype="application/json",
                status_code=400
            )

        reference_id = payload["reference_id"].strip()

        existing_ids = {
            str(record.get("reference_id", "")).strip().lower()
            for record in records
        }

        if reference_id.lower() in existing_ids:
            return func.HttpResponse(
                json.dumps({
                    "error": "Reference ID already exists."
                }),
                mimetype="application/json",
                status_code=409
            )

        # Resolve the selected document strictly inside
        # PosterIQ's local knowledge directory.
        knowledge_path = (
            KNOWLEDGE_ROOT / Path(knowledge_file)
        ).resolve()

        knowledge_root = KNOWLEDGE_ROOT.resolve()

        if knowledge_root not in knowledge_path.parents:
            return func.HttpResponse(
                json.dumps({
                    "error": "Invalid knowledge document path."
                }),
                mimetype="application/json",
                status_code=400
            )

        if not knowledge_path.is_file():
            return func.HttpResponse(
                json.dumps({
                    "error": "Knowledge document was not found locally."
                }),
                mimetype="application/json",
                status_code=404
            )

        with knowledge_path.open(
            "r",
            encoding="utf-8"
        ) as file:
            document = json.load(file)

        guidance_records = document.get("guidance_records")

        if not isinstance(guidance_records, list):
            return func.HttpResponse(
                json.dumps({
                    "error":
                        "Knowledge document has an invalid structure."
                }),
                mimetype="application/json",
                status_code=500
            )

        new_record = {
            "reference_id": reference_id,
            "category": payload["category"].strip(),
            "source_section": payload["source_section"].strip(),
            "guidance": {
                "title": payload["title"].strip(),
                "text": payload["text"].strip()
            },
            "applies_to": payload.get("applies_to", []),
            "keywords": payload.get("keywords", [])
        }

        source_page = payload.get("source_page")

        if source_page is not None:
            new_record["source_page"] = source_page

        guidance_records.append(new_record)

        with knowledge_path.open(
            "w",
            encoding="utf-8"
        ) as file:
            json.dump(
                document,
                file,
                indent=2,
                ensure_ascii=False
            )
            file.write("\n")

        return func.HttpResponse(
            json.dumps({
                "status": "created",
                "message": "Guidance was added successfully.",
                "record": new_record
            }),
            mimetype="application/json",
            status_code=201
        )

    except ValueError:
        return func.HttpResponse(
            json.dumps({
                "error": "Invalid JSON request."
            }),
            mimetype="application/json",
            status_code=400
        )

    except Exception as exc:
        print(
            "PosterIQ knowledge create error: "
            f"{type(exc).__name__}: {exc}"
        )

        return func.HttpResponse(
            json.dumps({
                "error": "Unable to save guidance."
            }),
            mimetype="application/json",
            status_code=500
        )

@app.route(
    route="knowledge/{reference_id}",
    methods=["PUT"]
)
def update_knowledge(req: func.HttpRequest) -> func.HttpResponse:
    """
    Update an existing curated guidance record
    in a local PosterIQ knowledge document.
    """

    reference_id = req.route_params.get(
        "reference_id",
        ""
    ).strip()

    try:
        payload = req.get_json()
    except ValueError:
        return func.HttpResponse(
            json.dumps({
                "error": "Request body must be valid JSON."
            }),
            status_code=400,
            mimetype="application/json"
        )

    required_fields = [
        "knowledge_file",
        "category",
        "source_section",
        "title",
        "text"
    ]

    missing_fields = [
        field
        for field in required_fields
        if not payload.get(field)
    ]

    if missing_fields:
        return func.HttpResponse(
            json.dumps({
                "error":
                    "Missing required fields: "
                    + ", ".join(missing_fields)
            }),
            status_code=400,
            mimetype="application/json"
        )

    try:
        knowledge_file = payload["knowledge_file"]

        knowledge_path = (
            KNOWLEDGE_ROOT / Path(knowledge_file)
        ).resolve()

        knowledge_root = KNOWLEDGE_ROOT.resolve()

        if knowledge_root not in knowledge_path.parents:
            return func.HttpResponse(
                json.dumps({
                    "error": "Invalid knowledge document path."
                }),
                status_code=400,
                mimetype="application/json"
            )

        if not knowledge_path.exists():
            return func.HttpResponse(
                json.dumps({
                    "error": "Knowledge document was not found."
                }),
                status_code=404,
                mimetype="application/json"
            )

        with open(
            knowledge_path,
            "r",
            encoding="utf-8"
        ) as file:
            data = json.load(file)

        guidance_records = data.get("guidance_records")

        if not isinstance(guidance_records, list):
            return func.HttpResponse(
                json.dumps({
                    "error":
                        "Knowledge document does not contain "
                        "a valid guidance_records list."
                }),
                status_code=400,
                mimetype="application/json"
            )

        target_record = next(
            (
                record
                for record in guidance_records
                if record.get("reference_id", "").lower()
                == reference_id.lower()
            ),
            None
        )

        if target_record is None:
            return func.HttpResponse(
                json.dumps({
                    "error": "Guidance record was not found."
                }),
                status_code=404,
                mimetype="application/json"
            )

        target_record["category"] = payload["category"].strip()
        target_record["source_section"] = (
            payload["source_section"].strip()
        )

        target_record["guidance"] = {
            "title": payload["title"].strip(),
            "text": payload["text"].strip()
        }

        target_record["applies_to"] = payload.get(
            "applies_to",
            []
        )

        target_record["keywords"] = payload.get(
            "keywords",
            []
        )

        source_page = payload.get("source_page")

        if source_page is not None:
            target_record["source_page"] = source_page
        else:
            target_record.pop("source_page", None)

        with open(
            knowledge_path,
            "w",
            encoding="utf-8"
        ) as file:
            json.dump(
                data,
                file,
                indent=2,
                ensure_ascii=False
            )
            file.write("\n")

        return func.HttpResponse(
            json.dumps({
                "status": "updated",
                "message": "Guidance was updated successfully."
            }),
            status_code=200,
            mimetype="application/json"
        )

    except Exception as exc:
        print(f"Knowledge update failed: {exc}")

        return func.HttpResponse(
            json.dumps({
                "error": "Unable to update guidance."
            }),
            status_code=500,
            mimetype="application/json"
        )

@app.route(
    route="knowledge/{reference_id}",
    methods=["DELETE"]
)
def delete_knowledge(req: func.HttpRequest) -> func.HttpResponse:
    """
    Delete an existing curated guidance record
    from a local PosterIQ knowledge document.
    """

    reference_id = req.route_params.get(
        "reference_id",
        ""
    ).strip()

    knowledge_file = req.params.get(
        "knowledge_file",
        ""
    ).strip()

    if not reference_id or not knowledge_file:
        return func.HttpResponse(
            json.dumps({
                "error": "Reference ID and knowledge file are required."
            }),
            status_code=400,
            mimetype="application/json"
        )

    try:
        knowledge_path = (
            KNOWLEDGE_ROOT / Path(knowledge_file)
        ).resolve()

        knowledge_root = KNOWLEDGE_ROOT.resolve()

        if knowledge_root not in knowledge_path.parents:
            return func.HttpResponse(
                json.dumps({
                    "error": "Invalid knowledge document path."
                }),
                status_code=400,
                mimetype="application/json"
            )

        if not knowledge_path.exists():
            return func.HttpResponse(
                json.dumps({
                    "error": "Knowledge document was not found."
                }),
                status_code=404,
                mimetype="application/json"
            )

        with open(
            knowledge_path,
            "r",
            encoding="utf-8"
        ) as file:
            data = json.load(file)

        guidance_records = data.get("guidance_records")

        if not isinstance(guidance_records, list):
            return func.HttpResponse(
                json.dumps({
                    "error": "Invalid guidance_records list."
                }),
                status_code=400,
                mimetype="application/json"
            )

        original_count = len(guidance_records)

        data["guidance_records"] = [
            record
            for record in guidance_records
            if record.get("reference_id", "").lower()
            != reference_id.lower()
        ]

        if len(data["guidance_records"]) == original_count:
            return func.HttpResponse(
                json.dumps({
                    "error": "Guidance record was not found."
                }),
                status_code=404,
                mimetype="application/json"
            )

        with open(
            knowledge_path,
            "w",
            encoding="utf-8"
        ) as file:
            json.dump(
                data,
                file,
                indent=2,
                ensure_ascii=False
            )
            file.write("\n")

        return func.HttpResponse(
            json.dumps({
                "status": "deleted",
                "message": "Guidance was deleted successfully."
            }),
            status_code=200,
            mimetype="application/json"
        )

    except Exception as exc:
        print(f"Knowledge delete failed: {exc}")

        return func.HttpResponse(
            json.dumps({
                "error": "Unable to delete guidance."
            }),
            status_code=500,
            mimetype="application/json"
        )
        
@app.route(route="health", methods=["GET"])

def health(req: func.HttpRequest) -> func.HttpResponse:
    """Health check endpoint for PosterIQ."""

    return func.HttpResponse(
        json.dumps({
            "service": "PosterIQ",
            "status": "ok"
        }),
        mimetype="application/json",
        status_code=200,
    )


@app.route(route="posters", methods=["POST"])
def upload_poster(req: func.HttpRequest) -> func.HttpResponse:
    """Receive, validate, and securely store a research poster PDF."""

    try:
        files = req.files

        if "file" not in files:
            return func.HttpResponse(
                json.dumps({
                    "error": "No file was uploaded.",
                    "expected_field": "file"
                }),
                mimetype="application/json",
                status_code=400,
            )

        uploaded_file = files["file"]
        filename = uploaded_file.filename or "poster.pdf"
        file_bytes = uploaded_file.read()

        if not filename.lower().endswith(".pdf"):
            return func.HttpResponse(
                json.dumps({
                    "error":
                    "PosterIQ currently accepts PDF files only."
                }),
                mimetype="application/json",
                status_code=400,
            )

        if not file_bytes.startswith(b"%PDF-"):
            return func.HttpResponse(
                json.dumps({
                    "error":
                    "The uploaded file does not appear to be a valid PDF."
                }),
                mimetype="application/json",
                status_code=400,
            )

        if len(file_bytes) > MAX_FILE_SIZE:
            return func.HttpResponse(
                json.dumps({
                    "error":
                    "The PDF exceeds the 25 MB upload limit."
                }),
                mimetype="application/json",
                status_code=413,
            )

        container_name = os.environ.get(
            "POSTERIQ_POSTERS_CONTAINER",
            "posters"
        )

        poster_id = str(uuid.uuid4())
        blob_name = f"{poster_id}.pdf"

        blob_service = get_blob_service_client()

        blob_client = blob_service.get_blob_client(
            container=container_name,
            blob=blob_name
        )

        blob_client.upload_blob(
            file_bytes,
            overwrite=False,
            content_settings=ContentSettings(
                content_type="application/pdf"
            ),
            metadata={
                "original_filename": filename,
                "poster_id": poster_id
            }
        )
        
        rendered = render_poster_image(file_bytes)

        image_blob_name = f"{poster_id}.png"

        image_blob_client = blob_service.get_blob_client(
            container=container_name,
            blob=image_blob_name
        )

        image_blob_client.upload_blob(
            rendered["bytes"],
            overwrite=False,
            content_settings=ContentSettings(
                content_type="image/png"
            ),
            metadata={
                "poster_id": poster_id,
                "asset_type": "rendered_poster"
            }
        )

        return func.HttpResponse(
            json.dumps({
                "status": "stored",
                "poster_id": poster_id,
                "filename": filename,
                "size_bytes": len(file_bytes),
                "visual": {
                    "rendered": True,
                    "width": rendered["width"],
                    "height": rendered["height"],
                    "format": "png"
                },
                "message":
                "Poster uploaded, rendered, and stored successfully."
            }),
            mimetype="application/json",
            status_code=201,
        )

    except Exception as exc:
        print(
            f"PosterIQ upload error: "
            f"{type(exc).__name__}: {exc}"
        )

        return func.HttpResponse(
            json.dumps({
                "error":
                "PosterIQ could not process or store the uploaded file."
            }),
            mimetype="application/json",
            status_code=500,
        )


@app.route(
    route="posters/{poster_id}/extract",
    methods=["POST"]
)
def extract_poster(req: func.HttpRequest) -> func.HttpResponse:
    """
    Extract and organize poster content using
    Azure AI Document Intelligence.
    """

    try:
        poster_id = req.route_params.get("poster_id")

        if not poster_id:
            return func.HttpResponse(
                json.dumps({
                    "error": "Poster ID is required."
                }),
                mimetype="application/json",
                status_code=400,
            )

        try:
            uuid.UUID(poster_id)
        except ValueError:
            return func.HttpResponse(
                json.dumps({
                    "error": "Invalid poster ID."
                }),
                mimetype="application/json",
                status_code=400,
            )

        container_name = os.environ.get(
            "POSTERIQ_POSTERS_CONTAINER",
            "posters"
        )

        blob_name = f"{poster_id}.pdf"

        blob_service = get_blob_service_client()

        blob_client = blob_service.get_blob_client(
            container=container_name,
            blob=blob_name
        )

        if not blob_client.exists():
            return func.HttpResponse(
                json.dumps({
                    "error": "Poster was not found."
                }),
                mimetype="application/json",
                status_code=404,
            )

        poster_bytes = blob_client.download_blob().readall()

        document_client = get_document_intelligence_client()

        poller = document_client.begin_analyze_document(
            "prebuilt-layout",
            body=poster_bytes
        )

        result = poller.result()

        poster_structure = build_posteriq_structure(result)

        response = {
            "status": "extracted",
            "poster_id": poster_id,
            "model": "prebuilt-layout",
            "poster": poster_structure
        }

        return func.HttpResponse(
            json.dumps(response),
            mimetype="application/json",
            status_code=200,
        )

    except Exception as exc:
        print(
            f"PosterIQ extraction error: "
            f"{type(exc).__name__}: {exc}"
        )

        return func.HttpResponse(
            json.dumps({
                "error":
                "PosterIQ could not extract the poster."
            }),
            mimetype="application/json",
            status_code=500,
        )

@app.route(route="ai-test", methods=["GET"])
def ai_test(req: func.HttpRequest) -> func.HttpResponse:
    """
    Minimal Azure OpenAI connectivity test.
    """
    try:
        client = get_openai_client()
        deployment = os.environ["POSTERIQ_OPENAI_DEPLOYMENT"]

        response = client.chat.completions.create(
            model=deployment,
            messages=[
                {
                    "role": "user",
                    "content": "Reply with exactly: PosterIQ connected"
                }
            ],
            max_completion_tokens=10
        )

        message = response.choices[0].message.content

        return func.HttpResponse(
            json.dumps({
                "status": "ok",
                "response": message
            }),
            mimetype="application/json",
            status_code=200
        )

    except Exception as exc:
        print(f"Azure OpenAI test failed: {type(exc).__name__}: {exc}")

        return func.HttpResponse(
            json.dumps({
                "status": "error",
                "message": "Azure OpenAI connection test failed."
            }),
            mimetype="application/json",
            status_code=500
        )


# ============================================================
# POSTER PREVIEW
# ============================================================

@app.route(
    route="posters/{poster_id}/preview",
    methods=["GET"],
    auth_level=func.AuthLevel.ANONYMOUS
)
def preview_poster(req: func.HttpRequest) -> func.HttpResponse:
    """
    Return the rendered PNG preview for an uploaded poster.

    The poster remains stored in the private Azure Blob container.
    The frontend retrieves the image through this API endpoint.
    """

    poster_id = req.route_params.get("poster_id")

    if not poster_id:
        return func.HttpResponse(
            json.dumps({
                "error": "Poster ID is required."
            }),
            mimetype="application/json",
            status_code=400
        )

    try:
        uuid.UUID(poster_id)
    except ValueError:
        return func.HttpResponse(
            json.dumps({
                "error": "Invalid poster ID."
            }),
            mimetype="application/json",
            status_code=400
        )

    try:
        container_name = os.environ.get(
            "POSTERIQ_POSTERS_CONTAINER",
            "posters"
        )

        blob_service = get_blob_service_client()

        image_blob = blob_service.get_blob_client(
            container=container_name,
            blob=f"{poster_id}.png"
        )

        if not image_blob.exists():
            return func.HttpResponse(
                json.dumps({
                    "error": "Rendered poster image was not found."
                }),
                mimetype="application/json",
                status_code=404
            )

        poster_image_bytes = image_blob.download_blob().readall()

        return func.HttpResponse(
            body=poster_image_bytes,
            mimetype="image/png",
            status_code=200,
            headers={
                "Cache-Control": "private, max-age=3600"
            }
        )

    except Exception as exc:
        print(
            f"Poster preview failed for {poster_id}: "
            f"{type(exc).__name__}: {exc}"
        )

        return func.HttpResponse(
            json.dumps({
                "error": "PosterIQ could not load the poster preview."
            }),
            mimetype="application/json",
            status_code=500
        )


# ============================================================
# POSTER REVIEW
# ============================================================

@app.route(
    route="posters/{poster_id}/review",
    methods=["POST"]
)
def review_poster(req: func.HttpRequest) -> func.HttpResponse:
    """
    Generate a PosterIQ review using Document Intelligence,
    the rendered poster image, curated guidance, and Azure OpenAI.
    """
    try:
        poster_id = req.route_params.get("poster_id")

        if not poster_id:
            return func.HttpResponse(
                json.dumps({
                    "error": "Poster ID is required."
                }),
                mimetype="application/json",
                status_code=400
            )

        try:
            uuid.UUID(poster_id)
        except ValueError:
            return func.HttpResponse(
                json.dumps({
                    "error": "Invalid poster ID."
                }),
                mimetype="application/json",
                status_code=400
            )

        container_name = os.environ.get(
            "POSTERIQ_POSTERS_CONTAINER",
            "posters"
        )

        blob_service = get_blob_service_client()

        pdf_blob = blob_service.get_blob_client(
            container=container_name,
            blob=f"{poster_id}.pdf"
        )

        image_blob = blob_service.get_blob_client(
            container=container_name,
            blob=f"{poster_id}.png"
        )

        if not pdf_blob.exists():
            return func.HttpResponse(
                json.dumps({
                    "error": "Poster PDF was not found."
                }),
                mimetype="application/json",
                status_code=404
            )

        if not image_blob.exists():
            return func.HttpResponse(
                json.dumps({
                    "error": "Rendered poster image was not found."
                }),
                mimetype="application/json",
                status_code=404
            )

        poster_bytes = pdf_blob.download_blob().readall()
        poster_image_bytes = image_blob.download_blob().readall()

        # Extract structured scientific and spatial content.
        document_client = get_document_intelligence_client()

        poller = document_client.begin_analyze_document(
            "prebuilt-layout",
            body=poster_bytes
        )

        result = poller.result()

        poster_structure = build_posteriq_structure(result)

        # Retrieve the curated PosterIQ guidance relevant to review.
        guidance_records = get_review_guidance()

        # Generate the multimodal structured review.
        review = generate_poster_review(
            poster_id=poster_id,
            poster_structure=poster_structure,
            poster_image_bytes=poster_image_bytes,
            guidance_records=guidance_records
        )

        # Resolve AI-selected evidence blocks to authoritative
        # Document Intelligence poster coordinates.
        review = add_finding_locations(
            review,
            poster_structure
        )

        return func.HttpResponse(
            json.dumps(review),
            mimetype="application/json",
            status_code=200
        )

    except Exception as exc:
        print(
            f"PosterIQ review error: "
            f"{type(exc).__name__}: {exc}"
        )

        return func.HttpResponse(
            json.dumps({
                "error": "PosterIQ could not review the poster."
            }),
            mimetype="application/json",
            status_code=500
        )     