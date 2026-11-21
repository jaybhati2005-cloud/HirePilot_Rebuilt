"""Fetch MediaPipe vision assets on the server so the browser never depends on a CDN.

The browser prefers /static/vendor/mediapipe/* (served by this app). The library is
taken from the npm package tarball, and we do NOT hard-code its file names or a single
version: every file under wasm/ is kept, and several versions are tried in order. If the
tarball cannot be fetched, the file listing is discovered from unpkg/jsDelivr instead.
"""
from __future__ import annotations

import io
import json
import logging
import tarfile
import threading
from pathlib import Path
from typing import Callable
from urllib.parse import urlparse

logger = logging.getLogger("hirepilot.vision")

# Tried in order until one works. Local files are version-agnostic once downloaded.
VERSIONS = ["0.10.22", "0.10.21", "0.10.20", "0.10.18", "0.10.17", "0.10.14"]
PACKAGE = "@mediapipe/tasks-vision"
REGISTRIES = [
    "https://registry.npmjs.org",
    "https://registry.yarnpkg.com",
    "https://registry.npmmirror.com",
    "https://mirrors.cloud.tencent.com/npm",
    "https://repo.huaweicloud.com/repository/npm",
]
CDN_HOSTS = ["https://unpkg.com", "https://cdn.jsdelivr.net/npm", "https://fastly.jsdelivr.net/npm", "https://gcore.jsdelivr.net/npm"]
LISTING_URLS = [
    "https://unpkg.com/{package}@{version}/?meta",
    "https://data.jsdelivr.com/v1/package/npm/{package}@{version}/flat",
]
# Last-resort guesses when no listing can be fetched (missing ones are simply skipped).
GUESSED_FILES = [
    "vision_bundle.mjs",
    "wasm/vision_wasm_internal.js", "wasm/vision_wasm_internal.wasm",
    "wasm/vision_wasm_nosimd_internal.js", "wasm/vision_wasm_nosimd_internal.wasm",
    "wasm/vision_wasm_module_internal.js", "wasm/vision_wasm_module_internal.wasm",
]
MODEL_BASE = "https://storage.googleapis.com/mediapipe-models"
MODEL_FILES = {
    "face_landmarker.task": f"{MODEL_BASE}/face_landmarker/face_landmarker/float16/1/face_landmarker.task",
    "pose_landmarker_lite.task": f"{MODEL_BASE}/pose_landmarker/pose_landmarker_lite/float16/1/pose_landmarker_lite.task",
    "hand_landmarker.task": f"{MODEL_BASE}/hand_landmarker/hand_landmarker/float16/1/hand_landmarker.task",
}

DEFAULT_TARGET = Path(__file__).resolve().parent.parent / "frontend" / "vendor" / "mediapipe"
_state: dict = {"downloading": False, "errors": []}
_lock = threading.Lock()


def _fetch(url: str, timeout: float = 60) -> bytes:
    import httpx  # imported lazily; httpx honours proxy env vars and ships its own CA bundle

    response = httpx.get(
        url, timeout=httpx.Timeout(timeout, connect=8.0), follow_redirects=True,
        headers={"User-Agent": "HirePilot/7.0"},
    )
    response.raise_for_status()
    return response.content


def _host(url: str) -> str:
    return urlparse(url).netloc or url


def _is_http_error(error: Exception) -> bool:
    return error.__class__.__name__ == "HTTPStatusError"


def _describe(url: str, error: Exception) -> str:
    """Short, readable reason: host + what happened."""
    host = _host(url)
    if _is_http_error(error):
        return f"{host}: HTTP {error.response.status_code} (file or version not found)"  # type: ignore[attr-defined]
    text = str(error) or error.__class__.__name__
    if "CERTIFICATE_VERIFY_FAILED" in text or "certificate" in text.lower():
        return f"{host}: TLS certificate problem (antivirus/proxy HTTPS inspection?)"
    return f"{host}: {error.__class__.__name__} {text[:100]}"


def _note(url: str, error: Exception) -> None:
    message = _describe(url, error)
    if message not in _state["errors"]:
        _state["errors"].append(message)


# ------------------------------------------------------------------- status

def library_ready(target: Path) -> bool:
    wasm = target / "wasm"
    return (
        (target / "vision_bundle.mjs").is_file()
        and any(wasm.glob("*.wasm"))
        and any(wasm.glob("*.js"))
    )


def _model_present(target: Path, name: str) -> bool:
    path = target / name
    return path.is_file() and path.stat().st_size > 0


def missing_files(target: Path = DEFAULT_TARGET) -> list[str]:
    missing: list[str] = []
    if not (target / "vision_bundle.mjs").is_file():
        missing.append("vision_bundle.mjs")
    if not any((target / "wasm").glob("*.wasm")):
        missing.append("wasm/*.wasm")
    if not any((target / "wasm").glob("*.js")):
        missing.append("wasm/*.js")
    missing += [name for name in MODEL_FILES if not _model_present(target, name)]
    return missing


def status(target: Path = DEFAULT_TARGET) -> dict:
    missing = missing_files(target)
    return {
        "ready": library_ready(target) and _model_present(target, "face_landmarker.task"),
        "complete": not missing,
        "missing": missing,
        "downloading": _state["downloading"],
        "errors": list(_state["errors"])[-6:],
        "version": (target / "version.txt").read_text().strip() if (target / "version.txt").exists() else None,
    }


# ----------------------------------------------------------------- library

def extract_npm_tarball(data: bytes, target: Path) -> list[str]:
    """Keep package/vision_bundle.mjs and every file directly under package/wasm/."""
    saved: list[str] = []
    root = target.resolve()
    with tarfile.open(fileobj=io.BytesIO(data), mode="r:gz") as archive:
        for member in archive.getmembers():
            if not member.isfile() or not member.name.startswith("package/"):
                continue
            relative = member.name[len("package/"):]
            parts = relative.split("/")
            wanted = relative == "vision_bundle.mjs" or (len(parts) == 2 and parts[0] == "wasm" and parts[1] and not parts[1].startswith("."))
            if not wanted:
                continue
            payload = archive.extractfile(member)
            if payload is None:
                continue
            destination = (target / relative).resolve()
            if root not in destination.parents:
                continue  # never write outside the target folder
            destination.parent.mkdir(parents=True, exist_ok=True)
            destination.write_bytes(payload.read())
            saved.append(relative)
    return saved


def import_local_archives(target: Path, log: Callable[[str], None]) -> None:
    """Offline path: any *.tgz placed in the target folder (or its parent) is unpacked."""
    for folder in (target, target.parent):
        for archive in (folder.glob("*.tgz") if folder.exists() else []):
            try:
                saved = extract_npm_tarball(archive.read_bytes(), target)
                if saved:
                    log(f"Unpacked {len(saved)} library files from {archive.name}")
            except Exception as error:  # noqa: BLE001
                _note(str(archive), error)


def _try_tarballs(target: Path, log: Callable[[str], None]) -> str | None:
    dead_hosts: set[str] = set()
    for version in VERSIONS:
        for registry in REGISTRIES:
            if registry in dead_hosts:
                continue
            url = f"{registry}/{PACKAGE}/-/tasks-vision-{version}.tgz"
            try:
                log(f"Downloading MediaPipe {version} from {_host(url)}")
                saved = extract_npm_tarball(_fetch(url, timeout=90), target)
                if "vision_bundle.mjs" in saved and any(name.endswith(".wasm") for name in saved):
                    log(f"Saved {len(saved)} library files (version {version})")
                    return version
                _state["errors"].append(f"{_host(url)}: archive had no vision_bundle.mjs/wasm (saved {len(saved)} files)")
            except Exception as error:  # noqa: BLE001
                _note(url, error)
                if not _is_http_error(error):
                    dead_hosts.add(registry)  # unreachable host: do not retry other versions on it
    return None


def _listing(version: str) -> list[str]:
    """Discover file paths (relative, e.g. 'wasm/x.wasm') from unpkg or jsDelivr."""
    for template in LISTING_URLS:
        url = template.format(package=PACKAGE, version=version)
        try:
            payload = json.loads(_fetch(url, timeout=30).decode("utf-8"))
        except Exception as error:  # noqa: BLE001
            _note(url, error)
            continue
        found: list[str] = []

        def walk(node):
            if isinstance(node, dict):
                for key in ("path", "name"):
                    value = node.get(key)
                    if isinstance(value, str) and value.startswith("/"):
                        found.append(value.lstrip("/"))
                for child in node.values():
                    walk(child)
            elif isinstance(node, list):
                for child in node:
                    walk(child)

        walk(payload)
        wanted = [
            name for name in dict.fromkeys(found)
            if name == "vision_bundle.mjs" or (name.startswith("wasm/") and name.count("/") == 1 and name.endswith((".js", ".wasm")))
        ]
        if wanted:
            return wanted
    return []


def _try_cdn_files(target: Path, log: Callable[[str], None]) -> str | None:
    for version in VERSIONS:
        names = _listing(version) or GUESSED_FILES
        saved = 0
        for name in names:
            for host in CDN_HOSTS:
                url = f"{host}/{PACKAGE}@{version}/{name}"
                try:
                    destination = target / name
                    destination.parent.mkdir(parents=True, exist_ok=True)
                    destination.write_bytes(_fetch(url, timeout=90))
                    saved += 1
                    break
                except Exception as error:  # noqa: BLE001
                    _note(url, error)
        if library_ready(target):
            log(f"Saved {saved} library files from CDN (version {version})")
            return version
    return None


def ensure_assets(target: Path = DEFAULT_TARGET, log: Callable[[str], None] = logger.info) -> dict:
    """Download whatever is missing. Safe to call repeatedly; never raises."""
    if not _lock.acquire(blocking=False):
        return status(target)
    _state["downloading"] = True
    _state["errors"] = []
    try:
        target.mkdir(parents=True, exist_ok=True)
        import_local_archives(target, log)

        if not library_ready(target):
            version = _try_tarballs(target, log) or _try_cdn_files(target, log)
            if version:
                (target / "version.txt").write_text(version)

        for name, url in MODEL_FILES.items():
            if _model_present(target, name):
                continue
            try:
                log(f"Downloading model {name}")
                (target / name).write_bytes(_fetch(url, timeout=120))
            except Exception as error:  # noqa: BLE001
                _note(url, error)
    except Exception as error:  # noqa: BLE001 - never crash the API at startup
        _state["errors"].append(f"unexpected: {error}")
    finally:
        _state["downloading"] = False
        _lock.release()
    result = status(target)
    for line in result["errors"]:
        logger.warning("Vision asset download problem: %s", line)
    log("MediaPipe vision assets are ready." if result["complete"] else f"MediaPipe vision assets incomplete; missing: {', '.join(result['missing'])}")
    return result
