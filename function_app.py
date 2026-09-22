import json
import os
import uuid

import azure.functions as func
from azure.storage.blob import BlobServiceClient, ContentSettings

app = func.FunctionApp(http_auth_level=func.AuthLevel.ANONYMOUS)

MAX_FILE_SIZE = 25 * 1024 * 1024  # 25 MB


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
                    "error": "PosterIQ currently accepts PDF files only."
                }),
                mimetype="application/json",
                status_code=400,
            )

        if not file_bytes.startswith(b"%PDF-"):
            return func.HttpResponse(
                json.dumps({
                    "error": "The uploaded file does not appear to be a valid PDF."
                }),
                mimetype="application/json",
                status_code=400,
            )

        if len(file_bytes) > MAX_FILE_SIZE:
            return func.HttpResponse(
                json.dumps({
                    "error": "The PDF exceeds the 25 MB upload limit."
                }),
                mimetype="application/json",
                status_code=413,
            )

        connection_string = os.environ.get(
            "POSTERIQ_STORAGE_CONNECTION_STRING"
        )
        container_name = os.environ.get(
            "POSTERIQ_POSTERS_CONTAINER",
            "posters"
        )

        if not connection_string:
            raise RuntimeError(
                "PosterIQ storage connection is not configured."
            )

        poster_id = str(uuid.uuid4())
        blob_name = f"{poster_id}.pdf"

        blob_service = BlobServiceClient.from_connection_string(
            connection_string
        )

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

        return func.HttpResponse(
            json.dumps({
                "status": "stored",
                "poster_id": poster_id,
                "filename": filename,
                "size_bytes": len(file_bytes),
                "message": "Poster uploaded and stored successfully."
            }),
            mimetype="application/json",
            status_code=201,
        )

    except Exception:
        return func.HttpResponse(
            json.dumps({
                "error": "PosterIQ could not process or store the uploaded file."
            }),
            mimetype="application/json",
            status_code=500,
        )
