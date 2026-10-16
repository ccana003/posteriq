"""Validated, conditional writes to the existing private knowledge documents."""
import copy
import json
import os
import re
from contextlib import contextmanager

from azure.core import MatchConditions
from azure.core.exceptions import ResourceExistsError, HttpResponseError
from azure.storage.blob import BlobServiceClient, ContentSettings

from knowledge_base import KNOWLEDGE_CONTAINER, add_guidance_records

INTERNAL_FILE = "posteriq-internal.json"
INTERNAL_SOURCE = {
    "title": "PosterIQ internally developed guidance",
    "organization": "PosterIQ",
    "curation_status": "internal",
}
CATEGORIES = {"scientific_content", "statistics", "visual_design", "readability",
              "accessibility", "required_elements"}
FIELDS = {"knowledge_file", "reference_id", "category", "source_section", "source_page",
          "title", "text", "applies_to", "keywords"}


class KnowledgeError(Exception):
    def __init__(self, message, status=400):
        super().__init__(message)
        self.status = status


def validate_guidance(payload):
    if not isinstance(payload, dict):
        raise KnowledgeError("Guidance must be a JSON object.")
    if set(payload) - FIELDS:
        raise KnowledgeError("Unsupported guidance fields: " + ", ".join(sorted(set(payload) - FIELDS)))
    result = {}
    for field, maximum in (("reference_id", 100), ("category", 50), ("title", 300),
                           ("text", 20000), ("knowledge_file", 1024), ("source_section", 500)):
        value = payload.get(field, "")
        if not isinstance(value, str) or len(value) > maximum:
            raise KnowledgeError(f"{field} must be text of at most {maximum} characters.")
        result[field] = value.strip()
    for field in ("reference_id", "category", "title", "text"):
        if not result[field]:
            raise KnowledgeError(f"{field} is required.")
    if not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9_.-]{0,99}", result["reference_id"]):
        raise KnowledgeError("reference_id must contain only letters, numbers, dots, underscores or hyphens.")
    if result["category"] not in CATEGORIES:
        raise KnowledgeError("Select a valid review area.")
    page = payload.get("source_page")
    if page is not None and (type(page) is not int or not 1 <= page <= 100000):
        raise KnowledgeError("source_page must be a positive integer or null.")
    result["source_page"] = page
    for field in ("applies_to", "keywords"):
        value = payload.get(field, [])
        if (not isinstance(value, list) or len(value) > 100 or
                any(not isinstance(item, str) or not item.strip() or len(item) > 200 for item in value)):
            raise KnowledgeError(f"{field} must be a list of nonempty strings (at most 100 items).")
        result[field] = list(dict.fromkeys(item.strip() for item in value))
    result["knowledge_file"] = result["knowledge_file"] or INTERNAL_FILE
    return result


def active_document(name):
    name = name.lower()
    return (name.endswith(".json") and "template" not in name and "backup" not in name
            and not name.endswith((".bak.json", ".old.json", ".test.json")))


class KnowledgeStore:
    def __init__(self, container=None):
        if container is None:
            connection = os.getenv("POSTERIQ_STORAGE_CONNECTION_STRING")
            if not connection:
                raise KnowledgeError("Knowledge storage is not configured.", 503)
            container = BlobServiceClient.from_connection_string(connection).get_container_client(KNOWLEDGE_CONTAINER)
        self.container = container

    def documents(self):
        documents = {}
        for blob in self.container.list_blobs():
            if not active_document(blob.name):
                continue
            download = self.container.get_blob_client(blob.name).download_blob()
            data = json.loads(download.readall().decode("utf-8"))
            if (not isinstance(data, dict) or not isinstance(data.get("source_document"), dict)
                    or not isinstance(data.get("guidance_records"), list)
                    or any(not isinstance(record, dict) for record in data["guidance_records"])):
                raise KnowledgeError("A stored knowledge document is invalid; ask an administrator to repair it.", 503)
            documents[blob.name] = (data, download.properties.etag)
        return documents

    def snapshot(self):
        records, sources = [], []
        for name, (data, etag) in self.documents().items():
            source = {field: data["source_document"].get(field)
                      for field in ("title", "organization", "date", "curation_status")}
            source["knowledge_file"] = name
            sources.append(source)
            document_records = []
            add_guidance_records(copy.deepcopy(data), document_records, name)
            for record in document_records:
                record["_etag"] = etag
            records.extend(document_records)
        if not any(source["knowledge_file"] == INTERNAL_FILE for source in sources):
            sources.append(dict(INTERNAL_SOURCE, knowledge_file=INTERNAL_FILE))
        return records, sources

    @contextmanager
    def write_lock(self):
        # One container-wide lease serializes ID checks across different documents.
        # Infinite lease fails closed if the worker dies: an admin must break it.
        lock = self.container.get_blob_client(".knowledge-manager.lock")
        try:
            lock.upload_blob(b"", overwrite=False)
        except ResourceExistsError:
            pass
        try:
            lease = lock.acquire_lease(lease_duration=-1)
        except HttpResponseError as exc:
            if exc.status_code in (409, 412):
                raise KnowledgeError("Another knowledge write is in progress. Retry shortly.", 409) from exc
            raise
        try:
            yield
        finally:
            lease.release()

    def mutate(self, method, payload=None, reference_id=None, etag=None, knowledge_file=None):
        validated = validate_guidance(payload) if method != "DELETE" else None
        if method != "POST" and (not isinstance(etag, str) or not etag or etag == "*"):
            raise KnowledgeError("Reload the guidance and provide its version using If-Match.", 428)
        if method == "PUT" and validated["reference_id"] != reference_id:
            raise KnowledgeError("Reference IDs cannot be changed when editing guidance.")
        with self.write_lock():
            docs = self.documents()
            matches = [(name, record) for name, (doc, _) in docs.items()
                       for record in doc["guidance_records"]
                       if isinstance(record.get("reference_id"), str)
                       and record["reference_id"].casefold() == (validated["reference_id"] if method == "POST" else reference_id).casefold()]
            if method == "POST":
                if matches:
                    raise KnowledgeError("That reference ID already exists. Choose a unique ID.", 409)
                name = validated["knowledge_file"]
                if name not in docs:
                    if name != INTERNAL_FILE:
                        raise KnowledgeError("Select an existing source document or internally developed guidance.")
                    docs[name] = ({"source_document": copy.deepcopy(INTERNAL_SOURCE), "guidance_records": []}, None)
                original = None
            else:
                if not matches:
                    raise KnowledgeError("Guidance was not found. Reload the knowledge base.", 404)
                if len(matches) != 1:
                    raise KnowledgeError("Duplicate stored reference IDs require administrator repair.", 409)
                name, original = matches[0]
                if original["reference_id"] != reference_id:
                    raise KnowledgeError("Use the exact stored reference ID; IDs cannot be changed during an edit or delete.")
                requested_file = knowledge_file if method == "DELETE" else validated["knowledge_file"]
                if requested_file != name:
                    raise KnowledgeError("The source document cannot be changed during an edit or delete.")
                if etag != docs[name][1]:
                    raise KnowledgeError("This document changed since you loaded it. Reload before editing or deleting.", 412)
            doc, current_etag = docs[name]
            if method == "DELETE":
                doc["guidance_records"].remove(original)
            else:
                record = copy.deepcopy(original) if original is not None else {}
                for field in ("reference_id", "category", "source_section", "source_page", "applies_to", "keywords"):
                    record[field] = validated[field]
                record.setdefault("guidance", {}).update(title=validated["title"], text=validated["text"])
                if original is None:
                    doc["guidance_records"].append(record)
                else:
                    doc["guidance_records"][doc["guidance_records"].index(original)] = record
            options = {"overwrite": False} if current_etag is None else {
                "overwrite": True, "etag": current_etag, "match_condition": MatchConditions.IfNotModified}
            try:
                self.container.get_blob_client(name).upload_blob(
                    json.dumps(doc, ensure_ascii=False).encode("utf-8"),
                    content_settings=ContentSettings(content_type="application/json"), **options)
            except HttpResponseError as exc:
                if exc.status_code in (409, 412):
                    raise KnowledgeError("The knowledge document changed. Reload before retrying.", 412) from exc
                raise
        return {"message": "Guidance deleted." if method == "DELETE" else "Guidance saved.",
                "reference_id": validated["reference_id"] if method == "POST" else reference_id}
