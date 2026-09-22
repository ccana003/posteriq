import json
import azure.functions as func

app = func.FunctionApp(http_auth_level=func.AuthLevel.ANONYMOUS)

@app.route(route="health", methods=["GET"])
def health(req: func.HttpRequest) -> func.HttpResponse:
    """Health check endpoint for PosterIQ."""
    return func.HttpResponse(
        json.dumps({"service": "PosterIQ", "status": "ok"}),
        mimetype="application/json",
        status_code=200,
    )
