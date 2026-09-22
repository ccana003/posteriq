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
