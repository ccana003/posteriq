# PosterIQ Architecture

## MVP workflow

1. A researcher uploads a research poster.
2. The PosterIQ backend receives and validates the file.
3. PosterIQ sends the poster and relevant review standards to the AI analysis layer.
4. The model returns structured feedback.
5. PosterIQ presents actionable feedback to the researcher.

## Initial Azure resources

PosterIQ currently uses:

- Azure Function App: `posteriq-api`
- Azure Storage account: `posteriqstorage`
- Flex Consumption hosting on Linux
- Python 3.12

The resources currently share an Azure resource group with another research application, but PosterIQ resources are independently named and tagged `Project: PosterIQ`.

## Planned components

### API

Azure Functions will provide endpoints for health checks, poster submission, analysis status, and review results.

### Storage

Uploaded posters will be stored separately from application deployment artifacts. Retention and deletion behavior will be defined before production use.

### AI analysis

A vision-capable Azure OpenAI / Microsoft Foundry model will evaluate both poster content and visual presentation.

### Knowledge base

PosterIQ will ground feedback in curated standards rather than relying solely on general model knowledge. Recommendations should identify whether they are grounded in a defined standard or are general suggestions.

### Security

Authentication, authorization, upload validation, data retention, and research-data handling requirements will be finalized before production use.
