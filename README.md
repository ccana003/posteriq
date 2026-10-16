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
use keyboard arrows or placement controls, and adjust body font size. On drop, resize or numeric placement, neighboring regions move to avoid overlap,
including draft placeholders. If current sizes cannot fit, the board reorders
into non-overlapping template slots. Wording, approvals and font sizes are retained;
review overflow warnings after reflow. Remove sections from the main editor
actions or the × beside each item in the section list. Layout checks report
overlaps, unapproved sections, small text, unavailable figures and clipped text. Two provisional column layouts can be compared; switching layouts
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

### Start from an article PDF

The builder also offers **Start from an article PDF** alongside starting from
scratch. Upload a searchable PDF (25 MB, 40 pages and 120,000 extracted characters
maximum), set a focus, and use the poster type, audience and organizer requirements
from Poster details. The AI proposes concise sections with exact PDF page numbers,
source excerpts and suggested article metadata. Nothing enters the poster until
the author selects drafts and chooses **Add selected drafts to builder**.

Choose a new poster or append to an existing one. Appending retains existing wording and approvals. Metadata replacement is opt-in;
placement is retained where possible and the board reflows if new regions overlap. New drafts are unapproved, with source text in their notes
and original excerpts available under Article source. Source references survive
IndexedDB saves and editable JSON export/import. Appended sections reflow when necessary to avoid overlaps: inspect layout and
text-fit warnings before export.

Up to eight figure candidates are offered. Original figure captions are matched
to nearby raster images and vector-chart clusters, including neighboring panels.
Caption-linked figures are selected by default and enter as unapproved figure
sections with their original captions and PDF page references. Unlabeled raster
images remain unchecked candidates. Verify all axes, legends, panels and captions
before approval; detection is heuristic and Add figure remains available for
missing figures or replacement crops. Scanned/image-only PDFs are explicitly rejected with guidance to use
a searchable/OCR version. The uploaded PDF is processed transiently rather than
stored in Blob Storage; retained excerpts and selected images save locally with
the editable poster. The article proposal uses the existing OpenAI deployment.

`POST /api/builder/article` accepts multipart form data (`file`, `focus`,
`poster_type`, `audience`, `event_requirements`) through the existing builder
Function. Deploy the latest ZIP, which includes `article_import.py`, before
trying this action. Existing PDF review and from-scratch builder flows remain
available. Automated source/number checks do not establish scientific validity;
verify the proposed text against the publication before approving.


### Figure sizing and optional headings

Figure headings default off on the poster; the section name remains in the editor
and section list. Use **Show figure title on poster** to display it. Proportional
mode fits the section around the image's width and aspect ratio, placing the
caption immediately beneath it. The corner handle and width/height controls resize
the image proportionally, with automatic layout adjustment to prevent overlap.
**Fit section to image** removes excess container space. Saved drafts retain title
visibility and sizing preferences; images are not repeatedly auto-resized on reload.

Crop-to-fill and stretch-to-fill are explicit alternatives. Crop can hide axes or
legends, and stretch distorts image proportions; layout checks flag these choices.
Very crowded boards may constrain the image size or return to template slots:
inspect fit warnings instead of shrinking scientific text silently. Live view,
template comparison, consistency-review image and PNG export use the same renderer.

## Knowledge Manager editing

Add, edit and delete curated guidance, including internally developed standards.
For testing without sign-in, explicitly set `POSTERIQ_KNOWLEDGE_ALLOW_ANONYMOUS_WRITES=true`
on the Function App. Protected editing remains the default and uses Microsoft
Entra editor roles. Both modes use the existing private knowledge container. See
[configuration, concurrency and manual deployment instructions](docs/knowledge-manager.md).
Public knowledge reads, poster review and poster building retain their existing behavior.
