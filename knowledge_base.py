import json
import os


KNOWLEDGE_DIR = os.path.join(
    os.path.dirname(__file__),
    "knowledge"
)


def load_guidance_records():
    """
    Load all PosterIQ guidance records from JSON knowledge files
    while preserving document-level source provenance.
    """
    records = []

    if not os.path.isdir(KNOWLEDGE_DIR):
        return records

    for root, _, files in os.walk(KNOWLEDGE_DIR):
        for filename in files:
            if not filename.lower().endswith(".json"):
                continue

            # Template files are documentation, not actual guidance.
            if "template" in filename.lower():
                continue

            path = os.path.join(root, filename)

            with open(path, "r", encoding="utf-8") as file:
                data = json.load(file)

            source_document = data.get("source_document", {})

            for record in data.get("guidance_records", []):
                # Preserve the parent document's provenance on each
                # individual guidance record.
                record["source"] = source_document.get("title")
                record["source_organization"] = (
                    source_document.get("organization")
                )
                record["source_date"] = source_document.get("date")
                record["curation_status"] = (
                    source_document.get("curation_status")
                )

                record["_knowledge_file"] = os.path.relpath(
                    path,
                    KNOWLEDGE_DIR
                )

                records.append(record)

    return records

def search_guidance(query, category=None, limit=5):
    """
    Simple MVP keyword retrieval.

    This will eventually be replaced or supplemented by semantic/vector
    retrieval, but gives PosterIQ a deterministic retrieval layer now.
    """
    records = load_guidance_records()

    query_terms = {
        term.lower()
        for term in query.split()
        if term.strip()
    }

    matches = []

    for record in records:
        if category and record.get("category") != category:
            continue

        searchable_parts = [
            record.get("reference_id", ""),
            record.get("category", ""),
            record.get("source_section", ""),
            record.get("guidance", {}).get("title", ""),
            record.get("guidance", {}).get("text", ""),
            " ".join(record.get("applies_to", [])),
            " ".join(record.get("keywords", []))
        ]

        searchable_text = " ".join(searchable_parts).lower()

        score = sum(
            1 for term in query_terms
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