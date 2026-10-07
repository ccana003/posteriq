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
existing review model request; there is no additional AI service to configure.

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
