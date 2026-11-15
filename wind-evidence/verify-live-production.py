"""Verify the live wind deployment against the already-tested production build."""
import concurrent.futures
import datetime
import hashlib
import json
from pathlib import Path
import re
import urllib.request

EVIDENCE = Path(__file__).resolve().parent
SITE = "https://snowglider.ai/"
MERGE_SHA = "778f9ef54c3761081d1f223d2c981b2c7a5a6294"
EXPECTED = json.loads((EVIDENCE / "production-expected-hashes.json").read_text())
TESTED_ENTRY = "/assets/index-nkm_IA9q.js"


def fetch(path):
    url = SITE + path + "?verify=" + MERGE_SHA
    request = urllib.request.Request(url, headers={"Cache-Control": "no-cache"})
    with urllib.request.urlopen(request, timeout=25) as response:
        body = response.read()
        return {
            "path": path,
            "url": response.geturl(),
            "status": response.status,
            "contentType": response.headers.get("content-type", ""),
            "bytes": len(body),
            "sha256": hashlib.sha256(body).hexdigest(),
        }, body


def verify_module(path):
    result, _ = fetch(path)
    result["expectedSha256"] = EXPECTED[path]
    result["hashMatchesTestedBuild"] = result["sha256"] == EXPECTED[path]
    accepted_mimes = ("text/css",) if path.endswith(".css") else ("javascript", "ecmascript")
    result["validMime"] = any(mime in result["contentType"] for mime in accepted_mimes)
    return result


home, html_bytes = fetch("")
html = html_bytes.decode("utf-8")
home["buildId"] = re.findall(r'<meta name="build-id" content="([^"]+)"', html)
home["entryModules"] = re.findall(r'<script type="module" crossorigin src="([^"]+)"', html)
home["entryMatchesTestedBuild"] = home["entryModules"] == [TESTED_ENTRY]
with concurrent.futures.ThreadPoolExecutor(max_workers=4) as pool:
    modules = list(pool.map(verify_module, EXPECTED))
success = home["status"] == 200 and home["entryMatchesTestedBuild"] and all(
    item["status"] == 200 and item["hashMatchesTestedBuild"] and item["validMime"]
    for item in modules
)
report = {
    "verifiedAt": datetime.datetime.now(datetime.timezone.utc).isoformat(),
    "mergeCommit": MERGE_SHA,
    "testedHead": "2cb650ea898c6ba6af8b606061fe9e83590c7248",
    "runtimeCommit": "9660fc069c86b4a777f978a4b33e030c93922e8f",
    "workflow": "https://github.com/den-run-ai/snowglider/actions/runs/43654403648",
    "method": "HTTPS fetch with revision cache key; homepage entry URL and SHA-256 of all emitted game JS/CSS bundles plus eight affected source modules compared with the tested production build. Git confirms identical runtime trees between tested head and merge. Build timestamp is injected only into HTML, outside these file hashes.",
    "home": home,
    "files": modules,
    "success": success,
}
(EVIDENCE / "production-verification.json").write_text(json.dumps(report, indent=2) + "\n")
print(json.dumps({"success": success, "buildId": home["buildId"], "entryModules": home["entryModules"], "entryMatchesTestedBuild": home["entryMatchesTestedBuild"], "files": [{"path": item["path"], "status": item["status"], "match": item["hashMatchesTestedBuild"], "validMime": item["validMime"]} for item in modules]}, indent=2))
raise SystemExit(0 if success else 1)
