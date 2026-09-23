import json
import os

from azure.storage.blob import BlobServiceClient


KNOWLEDGE_DIR = os.path.join(
    os.path.dirname(__file__),
    "knowledge"
)

KNOWLEDGE_CONTAINER = os.getenv(
    "POSTERIQ_KNOWLEDGE_CONTAINER",
    "knowledge"
)


def add_guidance_records(
    data,
    records,
    knowledge_file
):
    """
    Add guidance records from one PosterIQ knowledge document
    while preserving document-level source provenance.
    """
    source_document = data.get(
        "source_document",
        {}
    )

    for record in data.get(
        "guidance_records",
        []
    ):
        record["source"] = (
            source_document.get("title")
        )

        record["source_organization"] = (
            source_document.get("organization")
        )

        record["source_date"] = (
            source_document.get("date")
        )

        record["curation_status"] = (
            source_document.get("curation_status")
        )

        record["_knowledge_file"] = (
            knowledge_file
        )

        records.append(record)


def load_local_guidance_records():
    """
    Load PosterIQ guidance from the local knowledge directory.

    Used during local development.
    """
    records = []

    if not os.path.isdir(KNOWLEDGE_DIR):
        return records

    for root, _, files in os.walk(
        KNOWLEDGE_DIR
    ):
        for filename in files:

            filename_lower = filename.lower()

            if not filename_lower.endswith(
                ".json"
            ):
                continue

            # Template and backup files are not
            # active PosterIQ guidance documents.
            if (
                "template" in filename_lower
                or "backup" in filename_lower
                or filename_lower.endswith(".bak.json")
                or filename_lower.endswith(".old.json")
                or filename_lower.endswith(".test.json")
            ):
                continue

            path = os.path.join(
                root,
                filename
            )

            with open(
                path,
                "r",
                encoding="utf-8"
            ) as file:
                data = json.load(file)

            relative_path = os.path.relpath(
                path,
                KNOWLEDGE_DIR
            )

            add_guidance_records(
                data,
                records,
                relative_path
            )

    return records


def load_blob_guidance_records():
    """
    Load PosterIQ guidance from the private Azure Blob
    Storage knowledge container.

    Used by the deployed Azure Function when the local
    knowledge directory is not available.
    """
    records = []

    connection_string = os.getenv(
        "POSTERIQ_STORAGE_CONNECTION_STRING"
    )

    if not connection_string:
        return records

    blob_service_client = (
        BlobServiceClient.from_connection_string(
            connection_string
        )
    )

    container_client = (
        blob_service_client.get_container_client(
            KNOWLEDGE_CONTAINER
        )
    )

    for blob in container_client.list_blobs():

        blob_name = blob.name

        if not blob_name.lower().endswith(
            ".json"
        ):
            continue

        blob_name_lower = blob_name.lower()

        if (
            "template" in blob_name_lower
            or "backup" in blob_name_lower
            or blob_name_lower.endswith(".bak.json")
            or blob_name_lower.endswith(".old.json")
            or blob_name_lower.endswith(".test.json")
        ):
            continue

        blob_client = (
            container_client.get_blob_client(
                blob_name
            )
        )

        blob_bytes = (
            blob_client
            .download_blob()
            .readall()
        )

        data = json.loads(
            blob_bytes.decode("utf-8")
        )

        add_guidance_records(
            data,
            records,
            blob_name
        )

    return records


def load_guidance_records():
    """
    Load PosterIQ guidance.

    Local development:
        Uses the local knowledge directory.

    Azure deployment:
        Falls back to the private Azure Blob Storage
        knowledge container.

    Document-level provenance is preserved in both cases.
    """

    local_records = (
        load_local_guidance_records()
    )

    if local_records:
        return local_records

    return load_blob_guidance_records()


def search_guidance(
    query,
    category=None,
    limit=5
):
    """
    Simple MVP keyword retrieval.

    This will eventually be replaced or supplemented by
    semantic/vector retrieval, but gives PosterIQ a
    deterministic retrieval layer now.
    """

    records = load_guidance_records()

    query_terms = {
        term.lower()
        for term in query.split()
        if term.strip()
    }

    matches = []

    for record in records:

        if (
            category
            and record.get("category")
            != category
        ):
            continue

        searchable_parts = [
            record.get(
                "reference_id",
                ""
            ),
            record.get(
                "category",
                ""
            ),
            record.get(
                "source_section",
                ""
            ),
            record.get(
                "guidance",
                {}
            ).get(
                "title",
                ""
            ),
            record.get(
                "guidance",
                {}
            ).get(
                "text",
                ""
            ),
            " ".join(
                record.get(
                    "applies_to",
                    []
                )
            ),
            " ".join(
                record.get(
                    "keywords",
                    []
                )
            )
        ]

        searchable_text = " ".join(
            searchable_parts
        ).lower()

        score = sum(
            1
            for term in query_terms
            if term in searchable_text
        )

        if score > 0:
            matches.append({
                "score": score,
                "record": record
            })

    matches.sort(
        key=lambda item: item["score"],
        reverse=True
    )

    return matches[:limit]