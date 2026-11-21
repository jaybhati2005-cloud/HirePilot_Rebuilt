import io
import json
import tarfile

from backend import vision_assets as va


class HTTPStatusError(Exception):
    """Stands in for httpx.HTTPStatusError (matched by class name)."""

    def __init__(self, status_code):
        super().__init__(f"HTTP {status_code}")
        self.response = type("R", (), {"status_code": status_code})()


def _tarball(files):
    buffer = io.BytesIO()
    with tarfile.open(fileobj=buffer, mode="w:gz") as archive:
        for name, data in files.items():
            info = tarfile.TarInfo(name)
            info.size = len(data)
            archive.addfile(info, io.BytesIO(data))
    return buffer.getvalue()


PACKAGE_FILES = {
    "package/vision_bundle.mjs": b"export{}",
    "package/wasm/vision_wasm_internal.js": b"a",
    "package/wasm/vision_wasm_internal.wasm": b"\0asm",
    "package/wasm/vision_wasm_module_internal.js": b"b",
    "package/wasm/vision_wasm_module_internal.wasm": b"\0asm",
    "package/package.json": b"{}",
    "package/../evil.txt": b"bad",
}


def _fake_network(monkeypatch, routes):
    """routes: url -> bytes, or an int HTTP status to raise. Unlisted URLs 404."""
    def fake_fetch(url, timeout=60):
        result = routes.get(url, 404)
        if isinstance(result, int):
            raise HTTPStatusError(result)
        return result
    monkeypatch.setattr(va, "_fetch", fake_fetch)


def _models(target_routes=None):
    routes = {url: b"model" for url in va.MODEL_FILES.values()}
    routes.update(target_routes or {})
    return routes


def test_extract_keeps_every_wasm_file_and_blocks_traversal(tmp_path):
    saved = va.extract_npm_tarball(_tarball(PACKAGE_FILES), tmp_path / "mp")
    assert sorted(saved) == [
        "vision_bundle.mjs",
        "wasm/vision_wasm_internal.js", "wasm/vision_wasm_internal.wasm",
        "wasm/vision_wasm_module_internal.js", "wasm/vision_wasm_module_internal.wasm",
    ]
    assert not (tmp_path / "evil.txt").exists()
    assert va.library_ready(tmp_path / "mp")


def test_falls_back_to_older_version_when_newest_is_missing(tmp_path, monkeypatch):
    _fake_network(monkeypatch, _models({
        f"{va.REGISTRIES[0]}/{va.PACKAGE}/-/tasks-vision-0.10.21.tgz": _tarball(PACKAGE_FILES),
    }))
    result = va.ensure_assets(tmp_path / "mp", log=lambda message: None)
    assert result["complete"] is True
    assert result["version"] == "0.10.21"


def test_discovers_files_from_listing_when_tarballs_fail(tmp_path, monkeypatch):
    listing = {"files": [{"path": "/wasm", "type": "directory", "files": [
        {"path": "/wasm/odd_name.js", "type": "file"}, {"path": "/wasm/odd_name.wasm", "type": "file"}]},
        {"path": "/vision_bundle.mjs", "type": "file"}, {"path": "/package.json", "type": "file"}]}
    routes = _models({
        va.LISTING_URLS[0].format(package=va.PACKAGE, version="0.10.22"): json.dumps(listing).encode(),
        f"{va.CDN_HOSTS[0]}/{va.PACKAGE}@0.10.22/vision_bundle.mjs": b"export{}",
        f"{va.CDN_HOSTS[0]}/{va.PACKAGE}@0.10.22/wasm/odd_name.js": b"js",
        f"{va.CDN_HOSTS[0]}/{va.PACKAGE}@0.10.22/wasm/odd_name.wasm": b"\0asm",
    })
    _fake_network(monkeypatch, routes)
    result = va.ensure_assets(tmp_path / "mp", log=lambda message: None)
    assert result["ready"] is True
    assert (tmp_path / "mp" / "wasm" / "odd_name.wasm").exists()


def test_reports_readable_errors_when_everything_fails(tmp_path, monkeypatch):
    _fake_network(monkeypatch, {})
    result = va.ensure_assets(tmp_path / "mp", log=lambda message: None)
    assert result["ready"] is False
    assert "vision_bundle.mjs" in result["missing"]
    assert any("HTTP 404" in line for line in result["errors"])


def test_local_tgz_dropped_in_folder_is_unpacked_without_network(tmp_path, monkeypatch):
    _fake_network(monkeypatch, {})
    target = tmp_path / "mp"
    target.mkdir()
    (target / "tasks-vision-0.10.22.tgz").write_bytes(_tarball(PACKAGE_FILES))
    va.import_local_archives(target, lambda message: None)
    assert va.library_ready(target)


def test_status_ready_needs_library_and_face_model(tmp_path):
    target = tmp_path / "mp"
    va.extract_npm_tarball(_tarball(PACKAGE_FILES), target)
    assert va.status(target)["ready"] is False
    (target / "face_landmarker.task").write_bytes(b"m")
    status = va.status(target)
    assert status["ready"] is True and status["complete"] is False
