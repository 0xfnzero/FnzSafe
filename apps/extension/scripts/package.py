"""Package the compiled extension; preserve any identical, already-published ZIP."""
import hashlib
import io
import json
from html.parser import HTMLParser
from urllib.parse import urlsplit
from pathlib import Path
import zipfile

extension = Path(__file__).resolve().parents[1]
dist = extension / "dist"
version = json.loads((extension / "package.json").read_text())["version"]
manifest = json.loads((dist / "manifest.json").read_text())
if manifest["version"] != version:
    raise SystemExit("Manifest/package version mismatch; rebuild before packaging.")
required = {"manifest.json", "popup.html", "popup.js", "approval.html", "approval.js", "passkey.html", "passkey.js", "clipboard.html", "clipboard.js", "styles.css",
            manifest["background"]["service_worker"]}
required.update(manifest["icons"].values())
required.update(manifest["action"]["default_icon"].values())
for script in manifest["content_scripts"]:
    required.update(script["js"])
files = {p.relative_to(dist).as_posix(): p.read_bytes()
         for p in sorted(dist.rglob("*")) if p.is_file()}
class AssetReferences(HTMLParser):
    def handle_starttag(self, tag, attrs):
        attributes = dict(attrs)
        reference = attributes.get("src") if tag == "script" else attributes.get("href") if tag == "link" and attributes.get("rel") == "stylesheet" else None
        if reference:
            url = urlsplit(reference)
            if url.scheme or url.netloc or url.path.startswith("/") or ".." in Path(url.path).parts:
                raise SystemExit("Extension UI must reference local bundled assets.")
            required.add(url.path)

for name, data in files.items():
    if name.endswith(".html"):
        AssetReferences().feed(data.decode("utf-8"))

if not required.issubset(files) or any(name.endswith(".map") for name in files):
    raise SystemExit("Incomplete or development build; run npm run build first.")
output = extension.parents[1] / "release" / "extension"
output.mkdir(parents=True, exist_ok=True)
archive = output / f"FnzSafe-extension-{version}.zip"
if archive.exists():
    with zipfile.ZipFile(archive) as previous:
        if (previous.testzip() or len(previous.namelist()) != len(files)
                or set(previous.namelist()) != set(files)
                or any(previous.read(name) != data for name, data in files.items())):
            raise SystemExit(f"{archive.name} already contains a different build. Bump the version; do not overwrite published packages.")
else:
    buffer = io.BytesIO()
    with zipfile.ZipFile(buffer, "w", zipfile.ZIP_DEFLATED) as package:
        for name, data in files.items():
            info = zipfile.ZipInfo(name, date_time=(1980, 1, 1, 0, 0, 0))
            info.compress_type = zipfile.ZIP_DEFLATED
            info.external_attr = 0o644 << 16
            package.writestr(info, data)
    with archive.open("xb") as target:
        target.write(buffer.getvalue())
checksum = output / f"SHA256SUMS-{version}.txt"
line = f"{hashlib.sha256(archive.read_bytes()).hexdigest()}  {archive.name}\n"
if checksum.exists() and checksum.read_text() != line:
    raise SystemExit("Existing checksum differs; inspect the release artifacts.")
checksum.write_text(line)
print(f"Compiled extension: {archive}")
print(f"Checksum: {checksum}")
