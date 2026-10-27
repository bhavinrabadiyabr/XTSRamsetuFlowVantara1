"""Symphony hostlookup, with a direct-gateway fallback.

Load-balanced Symphony hosts require POST /hostlookup, then login on the
returned connectionString. DeltaX answers /hostlookup with type=true and
description HL_INFO_0001, pointing at /Nhostlookup, which 404s. That hint is
not a session key, so login uses /interactive/user/session and
/apibinarymarketdata/auth/login on the original :3000 root.
"""
from __future__ import annotations

import os
from pathlib import Path
from urllib.parse import urlparse

import requests

_LOOKUP: dict[str, tuple[str, str] | None] = {}


def load_backend_dotenv() -> None:
    env_path = Path(__file__).resolve().parent / ".env"
    if not env_path.is_file():
        return
    try:
        for line in env_path.read_text(encoding="utf-8").splitlines():
            s = line.strip()
            if not s or s.startswith("#") or "=" not in s:
                continue
            key, _, val = s.partition("=")
            key = key.strip()
            val = val.strip().strip('"').strip("'")
            if key and key not in os.environ:
                os.environ[key] = val
    except Exception:
        return


load_backend_dotenv()


def _env(name: str, default: str = "") -> str:
    v = os.getenv(name)
    return default if v is None else str(v)


def broker_root() -> str:
    raw = _env("XTS_ROOT") or _env("XTS_MD_ROOT") or "http://136.233.190.210:3000"
    return raw.strip().rstrip("/")


def _result_field(res: dict, *names: str) -> str:
    lower = {str(k).lower(): v for k, v in res.items()}
    for name in names:
        v = res.get(name)
        if v is None:
            v = lower.get(name.lower())
        if v is not None and str(v).strip():
            return str(v).strip()
    return ""


def _type_ok(data: dict) -> bool:
    kind = data.get("type")
    if isinstance(kind, bool):
        return kind
    return str(kind or "").lower() == "success"


def _lookup_pair(data: dict) -> tuple[str, str] | None:
    res = data.get("result") if isinstance(data.get("result"), dict) else data
    if not isinstance(res, dict):
        return None
    unique = _result_field(res, "uniqueKey", "UniqueKey")
    conn = _result_field(res, "connectionString", "ConnectionString")
    if not unique or not conn:
        return None
    return conn.rstrip("/"), unique


def _is_balancer_hint(conn: str, unique: str) -> bool:
    """DeltaX returns HL_INFO_0001 and a /Nhostlookup URL. That is not a login key."""
    path = urlparse(conn).path.lower()
    token = unique.upper()
    return (
        "hostlookup" in path
        or token.startswith("HL_INFO")
        or token.startswith("HL_INF")
        or token.startswith("HL-INF")
    )


def _read_json(response: requests.Response) -> dict | None:
    try:
        data = response.json()
    except Exception:
        return None
    return data if isinstance(data, dict) else None


def hostlookup(root: str, version: str, timeout_s: float) -> tuple[str, str] | None:
    """Return (connectionString, uniqueKey), or None when login should use the root directly."""
    root = (root or "").strip().rstrip("/")
    version = (version or "").strip() or "interactive_1.0.2"
    cache_key = f"{root}|{version}"
    if cache_key in _LOOKUP:
        return _LOOKUP[cache_key]

    url = f"{root}/hostlookup"
    password = _env("XTS_HOSTLOOKUP_PASSWORD", "2021HostLookUpAccess").strip() or "2021HostLookUpAccess"
    payloads = (
        {"accesspassword": password, "version": version},
        {"AccessPassword": password, "version": version},
    )
    found: tuple[str, str] | None = None
    missing = False
    last_error = ""
    for payload in payloads:
        try:
            response = requests.post(url, json=payload, timeout=timeout_s)
        except requests.RequestException as e:
            last_error = str(e)
            continue
        if response.status_code in (404, 405):
            missing = True
            break
        data = _read_json(response)
        if not isinstance(data, dict):
            last_error = f"HTTP {response.status_code}"
            continue
        desc = str(data.get("description") or "")
        code = str(data.get("code") or "")
        if "not found" in desc.lower() or code == "e-app-001":
            missing = True
            break
        if not _type_ok(data):
            last_error = desc or code or f"HTTP {response.status_code}"
            continue
        pair = _lookup_pair(data)
        if pair is None:
            last_error = "hostlookup response missing uniqueKey/connectionString"
            continue
        conn, unique = pair
        if not _is_balancer_hint(conn, unique):
            found = (conn, unique)
            break
        # One extra hop. If that route 404s, the published :3000 gateway is the login host.
        try:
            follow = requests.post(conn, json=payload, timeout=timeout_s)
        except requests.RequestException as e:
            last_error = str(e)
            missing = True
            break
        follow_data = _read_json(follow)
        if follow.status_code in (404, 405) or not isinstance(follow_data, dict):
            missing = True
            break
        follow_desc = str(follow_data.get("description") or "")
        follow_code = str(follow_data.get("code") or "")
        if "not found" in follow_desc.lower() or follow_code == "e-app-001" or not _type_ok(follow_data):
            missing = True
            break
        followed = _lookup_pair(follow_data)
        if followed is None or _is_balancer_hint(*followed):
            missing = True
            break
        found = followed
        break
    if found is None and not missing and last_error:
        raise RuntimeError(f"XTS hostlookup failed: {last_error}")
    _LOOKUP[cache_key] = found
    return found


def _origin_and_path(connection_string: str) -> tuple[str, str]:
    parsed = urlparse(connection_string)
    origin = f"{parsed.scheme}://{parsed.netloc}".rstrip("/")
    path = (parsed.path or "").strip("/")
    return origin, path


def interactive_base(connection_string: str, root: str) -> str:
    origin, path = _origin_and_path(connection_string)
    if path and "interactive" in path.lower():
        return connection_string.rstrip("/")
    return f"{(origin or root).rstrip('/')}/interactive"


def marketdata_base(connection_string: str, root: str) -> tuple[str, str, str]:
    """Return (rest_base, socket_origin, socketio_path)."""
    origin, path = _origin_and_path(connection_string)
    origin = origin or root.rstrip("/")
    if path and "market" in path.lower():
        return connection_string.rstrip("/"), origin, f"{path}/socket.io"
    return f"{origin}/apibinarymarketdata", origin, "apibinarymarketdata/socket.io"
