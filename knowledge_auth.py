"""Explicit public editing for testing, or verified Entra editor access by default."""
import os
import re
from functools import lru_cache

import jwt
from jwt import PyJWKClient

from knowledge_manager import KnowledgeError


def public_editing_enabled():
    """Explicit deployment opt-in; never inferred from missing Entra settings."""
    return os.getenv("POSTERIQ_KNOWLEDGE_ALLOW_ANONYMOUS_WRITES", "").strip().lower() == "true"


def auth_config():
    if public_editing_enabled():
        return {"mode": "public"}
    tenant = os.getenv("POSTERIQ_KNOWLEDGE_TENANT_ID", "")
    audience = os.getenv("POSTERIQ_KNOWLEDGE_API_CLIENT_ID", "")
    spa_client = os.getenv("POSTERIQ_KNOWLEDGE_SPA_CLIENT_ID", "")
    guid = r"[0-9a-fA-F]{8}(?:-[0-9a-fA-F]{4}){3}-[0-9a-fA-F]{12}"
    if not all(re.fullmatch(guid, value) for value in (tenant, audience, spa_client)):
        raise KnowledgeError("Knowledge editing is not configured. Contact the PosterIQ administrator.", 503)
    return {"tenant_id": tenant, "api_client_id": audience, "client_id": spa_client,
            "scope": f"api://{audience}/Knowledge.Write"}


@lru_cache(maxsize=4)
def signing_keys(tenant):
    return PyJWKClient(f"https://login.microsoftonline.com/{tenant}/discovery/v2.0/keys",
                       cache_jwk_set=True, lifespan=3600, timeout=10)


def authorize_write(req):
    if public_editing_enabled():
        return {"oid": "anonymous"}
    config = auth_config()  # Protected mode still fails closed without configuration.
    authorization = req.headers.get("Authorization", "")
    if not authorization.startswith("Bearer ") or len(authorization) > 16384:
        raise KnowledgeError("Sign in with an authorized Knowledge Editor account to make changes.", 401)
    token = authorization[7:]
    try:
        key = signing_keys(config["tenant_id"]).get_signing_key_from_jwt(token).key
        claims = jwt.decode(token, key, algorithms=["RS256"], audience=config["api_client_id"],
                            issuer=f'https://login.microsoftonline.com/{config["tenant_id"]}/v2.0',
                            options={"require": ["exp", "iat", "nbf", "iss", "aud", "tid", "oid"]})
    except jwt.PyJWKClientConnectionError as exc:
        raise KnowledgeError("The sign-in service is temporarily unavailable. Retry shortly.", 503) from exc
    except (jwt.PyJWTError, ValueError, TypeError) as exc:
        raise KnowledgeError("Your sign-in expired or is invalid. Sign in again.", 401) from exc
    roles, scope = claims.get("roles"), claims.get("scp")
    if (claims.get("tid") != config["tenant_id"] or not isinstance(roles, list)
            or "Knowledge.Editor" not in roles or not isinstance(scope, str)
            or "Knowledge.Write" not in scope.split()):
        raise KnowledgeError("Your account is not authorized as a Knowledge Editor.", 403)
    return claims
