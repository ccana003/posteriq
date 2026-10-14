# PosterIQ

PosterIQ is an AI-guided research poster review application. Researchers will be able to upload a research poster and receive feedback grounded in curated scientific communication, statistical reporting, accessibility, and visual presentation standards.

## Current milestone

The initial backend is an Azure Functions application running on Python 3.12.

### Health endpoint

```http
GET /api/health
```

Expected response:

```json
{
  "service": "PosterIQ",
  "status": "ok"
}
```

## Planned architecture

- Azure Functions — backend API and orchestration
- Azure Blob Storage — poster file handling
- Azure OpenAI / Microsoft Foundry — poster analysis
- Curated knowledge base — PosterIQ review standards
- Web frontend — poster upload and review results

## Development

Copy `local.settings.example.json` to `local.settings.json` for local development and provide local configuration values there. Do not commit secrets.

## Evidence-based feedback and suggested layouts

New reviews use model-output schema 1.1. Findings require specific evidence,
high confidence, and a concrete explanation of why a change matters. Acceptable
sections should remain unchanged, and an empty findings list is valid. Optional
refinements are labeled separately. Unclear or unreadable evidence is reported
as an assessment limitation rather than a speculative recommendation.

After a review, select **Preview suggested layout** to see targeted draft text
edits over the original poster. The author can edit the suggested wording,
turn individual edits off, switch back to the original, or download a PNG.
The suggested layout opens in a large viewer with zoom up to 400%, explicit
Original/Suggested layout modes, an applied-edit count and optional changed-area
outlines. Draft edits scroll separately from the poster. The inline poster stays
beside a long review on desktop. Downloads display preparation and handoff status,
and repeated clicks are blocked while the PNG is being prepared.
Readability rewrites take priority over cosmetic edits, with up to twelve
source-based drafts across affected text blocks. Condensation must retain the
source claims, qualifiers, numerical values, units and citations. One finding
may require several drafts, so the viewer reports both drafts applied and
recommendations addressed. Drafts that cannot fit are automatically unchecked
and marked Not applied; shortening their text retries the fit check.
The original PDF is never changed. Locations and approximate styles come from
the original PDF, and every edit is linked to a review finding.

The preview preserves unaffected sections, figures, logos and layout. It skips
unsafe regions, including overlapping content, figures, tables, complex
backgrounds, rotated text and blocks without native PDF text. It retains the
original when draft text cannot fit without shrinking below the source font size.
Numeric values, signs and percentages must survive the proposed AI edits.
These checks are not a scientific fact checker: authors must verify draft wording.

Mockups currently cover text regions on the first page. Recommendations needing
new scientific content, figure redraws or a redesigned layout remain manual
author edits. Typography is approximate, and the exported PNG is a layout draft,
not a print-ready poster. Older saved/sample reviews remain usable but have no
generated mockup. High-detail visual review and mockup suggestions share the
existing model deployment. Supported readability findings trigger an additional
editorial model request that reads the whole poster and creates section-purpose
rewrites (for example, abstract scope, background problem, model observations,
and conclusion takeaway). This adds processing time and model usage but needs no
new service configuration. Safe rewrites appear on the poster; drafts for unsafe
regions remain available as text for manual placement. If the editorial request
fails, the completed review is preserved and an assessment limitation is shown.

### Checks

With the Python environment activated:

```sh
python -m unittest discover -s tests -v
node --test tests/mockup.test.cjs
```

The Python tests exercise source-PDF geometry, protected figures, evidence
filtering, numeric preservation, and the review endpoint with simulated Azure
responses. They do not verify live Azure services or real model accuracy.

Optional browser checks require Playwright and Chromium. Install Playwright in
your development environment, run `playwright install chromium`, then run
`python tests/browser_mockup.py`. These checks use a synthetic poster and confirm
unchanged figure pixels, editable text, overflow protection, downloads, reset,
zero-finding reviews, older sample reviews and the mobile mockup editor.

See [Windows commit and deployment instructions](docs/windows-deployment.md)
for publishing backend changes. Frontend changes deploy through the existing
GitHub Actions workflow after a push to `main`; backend changes require a
separate Function App publish.

## Guided poster builder

Open **Build a poster** (`frontend/builder.html`) to create an editable poster
alongside the existing PDF review workflow. Select research, protocol, case/model
or narrative, enter title/credits, audience, dimensions and organizer instructions,
then request a guided outline. The backend loads the existing curated knowledge
at runtime. Sourced required elements are distinguished from suggested sections;
when guidance is unavailable the outline explicitly says requirements were not
verified. A non-AI suggested outline is also available.

Answer each section's question with source notes, generate concise wording,
revise it and explicitly approve it. Only approved content appears on the poster.
Editing content or source notes removes approval. Figures accept PNG/JPEG files,
with author-supplied descriptions and captions. Drag sections or their corners,
use keyboard arrows or placement controls, and adjust body font size. Layout
checks report overlaps, unapproved sections, small text, unavailable figures and
clipped text. Two provisional column layouts can be compared; switching layouts
rearranges the same approved content and never rewrites it. Actual institutional
templates and branding can be added to the template registry once supplied.

The assembled-poster review sends the rendered PNG plus structured content to
the existing Azure OpenAI deployment. It checks the argument, consistency,
figure/caption relationships, readable layout and applicable guidance. Suggested
replacements return to the editor as **unapproved** drafts. The review is marked
out of date after any poster change. AI output does not certify scientific
validity; authors must verify wording, figures, citations and requirements.

Drafts, including source notes and figures, save in IndexedDB on the current
browser/device. They are not saved in an account or synchronized across devices.
Use **Save editable draft** to download a JSON backup, and **Open draft** to
restore it elsewhere. The PNG export is a 1200-pixel-wide mockup, not a
print-ready or editable publication file. Figures are resized to a maximum
1600-pixel edge for this preview. SVG/PDF/PowerPoint export, supplied templates,
authenticated account storage and collaborative editing are future work.

### Builder API and deployment

The new `POST /api/builder/{action}` route supports `plan`, `draft` and `review`.
It uses existing OpenAI and knowledge-storage configuration; no new secrets or
Azure services are required. Requests are stateless and bounded to 10 MB. Failed
AI actions leave the browser document unchanged. Numerical values introduced by
AI drafts are checked against supplied notes; this does not replace semantic or
scientific review. Source images are kept locally; final review sends the poster
rendering instead of duplicating every figure in the request.

Deploy the new Function App ZIP before testing AI actions in the new PR preview.
The ZIP builder includes `poster_builder.py` and validates all eight Functions.
The static frontend deploys separately through the existing workflow. Add the
new PR preview's exact origin to Function App CORS while retaining current
origins, as for the previous PR. Do not merge until the deployed AI flow has been
reviewed with representative source material and current curated guidance.

Additional checks:

```bash
node --test tests/*.test.cjs
python -m unittest discover -s tests -v
python tests/browser_builder.py
python tests/browser_mockup.py
```

The browser checks use deterministic AI fixtures, so they validate UI behavior
and data handling without claiming to validate live AI quality. GitHub Actions
runs both browser workflows in Chromium as well as deployment-package checks.
