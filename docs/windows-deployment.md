# Commit and deploy from Windows Command Prompt

These commands are for Command Prompt (`cmd.exe`), from the repository's local
checkout. Replace the example path with the actual PosterIQ folder. Run each
step separately and inspect its result before continuing.

## Download a prepared ZIP for manual Azure deployment

Before merging, open the PR's **Checks** tab and select **Build Azure Functions
deployment ZIP**. Open its workflow run and wait for a successful result. In the
run's **Artifacts** section, download **posteriq-azure-deployment**.

Extract that downloaded artifact ZIP once. It contains **posteriq-api-deploy.zip**.
Upload the inner **posteriq-api-deploy.zip**, still zipped, using the Function App's
manual ZIP deployment option. It has `host.json` at its root and includes tested
Linux/Python 3.12 dependencies. GitHub's **Code → Download ZIP** is a source archive
and should not be uploaded directly as this deployment package.

The build workflow does not deploy to Azure or merge the PR. Manually uploading
to `posteriq-api` updates that app, so use a separate test Function App if you need
to keep production unchanged. A frontend PR preview still uses the API address
configured in its JavaScript; it does not automatically create a test backend.

## Bring the changes into your local checkout

First check your local working tree. Preserve any existing edits before copying
updated files over them. If it is clean, update `main` before applying the files.

```cmd
cd /d "C:\path\to\posteriq"
git status
git branch --show-current
git pull --ff-only origin main
```

Only run the pull when you are on `main` and the working tree is clean. If local
edits or a different branch are present, reconcile those first. The cloud edits
are not automatically copied to your Windows computer. Copy the changed files
into the matching paths in this checkout, preserving local settings and secrets.

## Validate, commit, and push

Use Python 3.12. If your `.venv` already exists, activate it rather than replacing
it. When no virtual environment exists, create one with `py -3.12 -m venv .venv`.

```cmd
.venv\Scripts\activate
python -m pip install -r requirements.txt
python -m unittest discover -s tests -v
node --test tests\mockup.test.cjs
git diff --check
git diff
git status
```

Stage only the intended changes. For the suggested-layout feature, the changed
paths are:

```cmd
git add .funcignore README.md docs/windows-deployment.md function_app.py poster_mockup.py schemas/review.schema.json frontend/index.html frontend/app.js frontend/mockup.js frontend/styles.css tests/test_poster_mockup.py tests/mockup.test.cjs tests/browser_mockup.py
git diff --cached --stat
git commit -m "Add design-preserving mockups and evidence-based poster reviews"
git push origin main
```

The frontend GitHub Actions workflow deploys `frontend/` to Azure Static Web Apps.
Confirm that workflow succeeds. It does not deploy the Python Function App.
No application settings or API keys should be committed.

## Publish the Azure Function App

Before publishing, confirm Azure CLI and Azure Functions Core Tools v4 are
installed. The repository documents a Python 3.12 Linux Flex Consumption app
named `posteriq-api`. Verify that this is still the correct app and subscription.

```cmd
az --version
func --version
az login
az account show --query "{subscription:name,id:id}" --output table
az functionapp list --query "[?name=='posteriq-api'].{name:name,resourceGroup:resourceGroup,host:defaultHostName}" --output table
```

If the subscription is wrong, select the correct subscription before publishing.
Do not create or overwrite app settings during a code-only update. The existing
Storage, Document Intelligence, and OpenAI settings are still required.

From the repository root, with the Python environment active:

```cmd
func azure functionapp publish posteriq-api --python
```

Core Tools handles the Python build for the Azure target. `.funcignore` excludes
local secrets, virtual environments, tests, frontend files and local artifacts
from the backend deployment. The deployed code must include `poster_mockup.py`
and `schemas/review.schema.json` alongside `function_app.py` and `requirements.txt`.
If publishing fails, inspect the exact error rather than retrying blindly or
changing credentials. Flex Consumption needs a current Core Tools v4 release.

## Verify the deployed change

Using the hostname returned above:

```cmd
curl "https://YOUR_FUNCTION_HOST/api/health"
```

Expect `{"service":"PosterIQ","status":"ok"}`. Then open the deployed
frontend, refresh it, and review a real poster. Confirm the review works before
checking the suggested layout button, editable drafts, original-poster toggle
and PNG download. Confirm acceptable sections are not criticized, and that
uncertain evidence is reported as a limitation. Check original numbers and claims
against any draft wording. A successful health request alone does not validate
Document Intelligence, Storage, OpenAI or review quality.

The mockup uses the same API origin as the existing frontend. If its image or
download fails, check the Function App's existing CORS configuration for the
frontend's exact origin, without replacing other allowed origins.

## Testing the poster builder before merging

The builder is a new page at `/builder.html`. Its AI actions need the latest
Function App deployment, not just the new frontend preview.

1. In the builder PR, open the successful **Build Azure Functions deployment ZIP**
   workflow. Download the **posteriq-azure-deployment** artifact.
2. Extract the downloaded outer ZIP once. Manually deploy the inner
   **posteriq-api-deploy.zip**, still zipped, using the existing Function App
   manual deployment process. This updates the shared backend; the existing PDF
   endpoints are retained.
3. In Function App **CORS**, add the new PR preview's exact origin (no trailing
   slash). Keep the production origin and other allowed origins. The new PR has
   a different preview origin from PR #1.
4. Open the PR preview, choose **Build a poster**, and hard-refresh if necessary.
5. Create an outline using representative source notes, draft/approve sections,
   upload a figure and caption, compare layouts, and review the assembled poster.
   Check that moving between layouts leaves approved wording unchanged.
6. Save an editable JSON draft, reload and restore it, then download the mockup
   PNG. Test the existing PDF review path as well.

The same OpenAI deployment and curated knowledge store are used; no new secrets
or services are needed. Until the new backend is deployed, manual authoring and
saved drafts work, but AI builder actions will report that the API is unavailable.
The organization's actual templates have not been supplied: both included layouts
are explicitly provisional. Only merge after testing the live AI output and
required-element guidance. Merging deploys the static site; it does not upload
the Function App ZIP automatically.

### Testing article-assisted building in PR #2

Deploy the latest inner Function App ZIP from this PR again to enable the new
article action. The preview URL and its existing CORS entry stay the same.
Hard-refresh the preview, open Build a poster, expand **Start from an article
PDF**, choose a searchable publication and describe the poster's focus. Review
proposed text and page excerpts, select drafts, then choose whether to start a
new poster or append to the current one. Verify existing approved text and
placement are retained when appending. Every imported section needs approval;
image candidates also need their captions and descriptions before approval.


### Section removal, automatic layout and article figures

The latest PR #2 update makes Remove section visible in the main section actions
and adds × controls beside each section in the list. Drag into another region,
release and verify the board makes room without overlaps (including unapproved
placeholders). On a full board it may reorder into template slots; check overflow
warnings afterward. Wording, approval and font size do not change during reflow.

Deploy the latest backend ZIP to test enhanced article figure detection, then run
a new article proposal. Caption-linked raster and vector figures should be selected
as draft figure sections, with source pages and original captions. Verify complete
panels/axes/legends and caption accuracy before approving. Detection is best effort;
manual figure upload and replacement remain available.
