import json
import os
import uuid

import azure.functions as func
import pymupdf
from azure.ai.documentintelligence import DocumentIntelligenceClient
from azure.core.credentials import AzureKeyCredential
from azure.storage.blob import BlobServiceClient, ContentSettings

app = func.FunctionApp(http_auth_level=func.AuthLevel.ANONYMOUS)

MAX_FILE_SIZE = 25 * 1024 * 1024  # 25 MB


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
