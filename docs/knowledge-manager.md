# Knowledge Manager editing

Knowledge reads remain public. POST, PUT and DELETE verify signed Microsoft Entra
**access tokens** in Python before opening storage. There is no anonymous write
mode, local authentication bypass, shared browser key, or trust in caller-supplied
`X-MS-CLIENT-PRINCIPAL` headers. Missing configuration disables editing (503).
The Functions route declarations use `ANONYMOUS` because the application verifies
the bearer token itself; this does not grant unauthenticated write access.
Existing poster review and builder routes retain their current behavior.

## Entra configuration

Use two single-tenant app registrations in your organization's Entra tenant:

1. **PosterIQ Knowledge API**: record its Application (client) ID. In the manifest,
   set `api.requestedAccessTokenVersion` to `2`. Expose an API with Application ID
   URI `api://<API_CLIENT_ID>` and a delegated scope named `Knowledge.Write`.
   Prefer admin-only consent for this administrative scope.
2. On that API registration, create an enabled app role with value
   **`Knowledge.Editor`**, allowed member type **Users/Groups**. Assign only the
   intended editors (or editor group) to this role using the API's Enterprise
   Application → Users and groups. Granting delegated permission alone does not
   authorize editing; tokens must contain both this role and the scope.
3. **PosterIQ Knowledge Manager SPA**: add the API's delegated `Knowledge.Write`
   permission and grant administrator consent. Add **Single-page application**
   redirect URIs for each approved frontend origin, ending in
   `/knowledge-auth.html`. For example:
   `https://<production-static-web-app-host>/knowledge-auth.html` and, for local
   testing, `http://localhost:8000/knowledge-auth.html`.
   Preview origins must each be registered explicitly before sign-in will work.
   Do not enable implicit grants or create a client secret for the SPA.
4. Configure the Function App's application settings (and restart after saving):

   | Setting | Value |
   | --- | --- |
   | `POSTERIQ_KNOWLEDGE_TENANT_ID` | Tenant GUID; never `common` or `organizations` |
   | `POSTERIQ_KNOWLEDGE_API_CLIENT_ID` | API registration client GUID (v2 token audience) |
   | `POSTERIQ_KNOWLEDGE_SPA_CLIENT_ID` | SPA registration client GUID |
   | `POSTERIQ_STORAGE_CONNECTION_STRING` | Existing private Blob Storage connection string |
   | `POSTERIQ_KNOWLEDGE_CONTAINER` | Existing container; defaults to `knowledge` |

The three Entra identifiers are public configuration, returned by
`GET /api/knowledge/access`; they are not credentials. All must be configured.
The backend fetches/caches Microsoft's signing keys from the fixed tenant JWKS
endpoint on `login.microsoftonline.com`; outbound HTTPS access is required.
It verifies RS256 signatures, issuer, API audience, tenant, expiry, not-before,
identity claims, delegated scope, and editor role. Identity tokens and tokens
for the SPA or another API cannot authorize writes.

The frontend loads the pinned MSAL browser library from `cdn.jsdelivr.net` and
uses popup authorization code/PKCE sign-in with session storage. Allow that host
and Microsoft login endpoints in any frontend CSP. `knowledge-auth.html` is a
minimal same-origin popup return page. Tokens stay out of URLs and logs.
The backend does not require Easy Auth; if it is enabled separately, ensure its
configuration still allows the existing public review and builder workflows.

## CORS

In Function App CORS, allow only the frontend origins you intend to use, including
any explicitly approved preview/local origin. Do not use `*`. The browser sends
`Authorization`, `Content-Type` and (for updates/deletes) `If-Match`; preflight
must permit these headers and POST/PUT/DELETE. The app does not use cross-origin
cookies, so enabling credentialed CORS is unnecessary. CORS is not authorization:
direct requests still require a valid editor token.

## Storage and preservation

The manager reads/writes the **existing private knowledge container**. Documents
keep their existing shape:

```json
{
  "source_document": {"title": "Your source", "organization": "Your organization"},
  "guidance_records": [
    {
      "reference_id": "TEAM-READ-001",
      "category": "readability",
      "guidance": {"title": "Readable text", "text": "Use short sentences."},
      "source_section": "Design",
      "source_page": null,
      "applies_to": ["body_text"],
      "keywords": ["readability"]
    }
  ]
}
```

Source metadata, unknown document/record/guidance properties, and unrelated records
are preserved. Source choices are keyed by blob filename, even if titles repeat.
Deleting the final record leaves its source document intact and selectable.
For internally developed guidance choose **PosterIQ internally developed guidance**:
no publication, source section, page, URL or DOI is required. The manager creates
`posteriq-internal.json` conditionally on first use with explicitly internal
provenance. It never invents an external citation or accepts arbitrary new source
filenames. Adding external source documents remains an administrator task: upload
a valid JSON source document, optionally with an empty `guidance_records` list.
If that reserved internal filename already exists, its metadata is preserved.

Knowledge Manager reads Blob Storage when a connection is configured; without it,
it retains local read-only fallback. Writes always use Blob Storage. Poster review
and builder retrieval still use their existing local/blob loading behavior. Do
not ship a local knowledge directory in production if edits should immediately
be used by those existing retrieval paths.

## API contract

All write requests require `Authorization: Bearer <access token>`.

- `POST /api/knowledge`: JSON object with `reference_id`, `category`, `title`,
  `text`, `knowledge_file`, optional `source_section`, `source_page`, `applies_to`,
  and `keywords`. An empty/omitted filename selects internal guidance. Returns
  201 and a confirmation; existing reference IDs are never overwritten.
- `PUT /api/knowledge/{reference_id}`: same fields, plus `If-Match` containing
  the exact `etag` returned for that record by GET. IDs and source documents
  cannot be changed by an edit. Optional fields omitted on a PUT are cleared.
- `DELETE /api/knowledge/{reference_id}?knowledge_file=<filename>`: requires the
  record's `If-Match` version and exact source filename. Returns 200 confirmation.

Categories: `scientific_content`, `statistics`, `visual_design`, `readability`,
`accessibility`, `required_elements`. IDs use letters/numbers/dots/underscores/
hyphens, are globally unique case-insensitively, and are at most 100 characters.
Titles/text are required nonblank strings (max 300/20,000 characters). Source
section is optional text (max 500); pages are positive integers or null. Tags are
arrays of nonblank strings (max 100 entries, 200 characters each). Unknown input
fields and invalid types are rejected. JSON request size is limited to 64 KB.

Error statuses: 400 validation, 401 sign-in required/invalid token, 403 missing
editor role or delegated scope, 404 missing record, 409 duplicate ID/write busy,
412 stale version/storage conflict, 413 request too large, 428 missing version,
503 missing configuration or unavailable service/storage. The frontend keeps
unsaved form contents on failure and displays the server's message. Sign in before
saving/deleting; successful writes reload the list and show a confirmation.

### Concurrency and recovery

GET returns a document ETag with each record. PUT/DELETE require that exact ETag,
and the upload uses Azure's conditional `IfNotModified` match. Changes anywhere
in the source document invalidate previously loaded versions. Reload before
retrying a stale edit; copy any unsaved wording first. The UI intentionally does
not silently merge or overwrite another editor's work.

A container-wide lease on `.knowledge-manager.lock` serializes write transactions
and global duplicate-ID checks across documents. The lease is released on handled
success or failure. It is deliberately infinite: if a worker is forcibly killed,
writes fail closed with 409 until an administrator breaks the lease. In Azure
Storage Explorer/Portal, locate that lock blob and **Break lease** after verifying
no Knowledge Manager write is running. Never break a lease during active edits.
Direct storage maintenance must also be done with editing paused: external tools
do not participate in this application lease. Enable Azure Blob versioning/soft
delete and take a backup before deployment for administrative recovery.

## Review, deployment and verification

This change does not deploy itself. The Static Web Apps PR workflow now requires
the **`deploy-preview`** label before deploying a PR preview. Leave the label off
for code-only review. Main-branch frontend deployment behavior is unchanged;
merging still triggers the existing production frontend workflow.
The Functions workflow runs tests and builds a ZIP but does not deploy it.

After review, configure Entra and CORS, then manually deploy the new **inner**
`posteriq-api-deploy.zip` built by GitHub Actions (not GitHub's source-code ZIP).
The package includes `knowledge_manager.py`, `knowledge_auth.py` and the PyJWT
cryptography dependency. Deploy the frontend separately using your existing SWA
workflow when authorized. Without the backend/configuration, the page explains
that editing is unavailable; existing public tools remain available.

Verification before enabling editor access:

1. GET knowledge works without signing in.
2. Anonymous and ordinary signed-in accounts cannot create/edit/delete.
3. An assigned editor signs in, creates internal guidance, edits it, and deletes
   it, receiving confirmations after each action.
4. Two tabs edit the same source: after the first saves, the second gets a stale
   version error. Refresh before retrying; the first edit must remain intact.
5. Existing source metadata and unrelated records remain unchanged.
6. Poster review and builder still work as before.

Automated checks (no production credentials needed):

```sh
python -m unittest discover -s tests -v
node --test tests/*.test.cjs
python tests/browser_knowledge.py
python tests/browser_builder.py
python tests/browser_mockup.py
python scripts/build_deployment_zip.py --output /tmp/posteriq-api-deploy.zip
```

Browser checks require Playwright/Chromium. Identity and storage are simulated in
the automated tests; a real Entra tenant sign-in and Azure CORS check remain a
manual staging verification after configuration. No production deployment is
performed by these checks.
