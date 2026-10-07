"""Build and test a Linux/Python 3.12 Azure Functions deployment ZIP."""

import argparse
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import zipfile


BACKEND_FILES = (
    "function_app.py", "knowledge_base.py", "poster_mockup.py",
    "host.json", "requirements.txt", "schemas/review.schema.json",
)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output", required=True, type=Path)
    args = parser.parse_args()
    if sys.platform != "linux" or sys.version_info[:2] != (3, 12):
        parser.error("Build on Linux with Python 3.12; GitHub Actions provides this environment.")
    repo = Path(__file__).resolve().parents[1]
    output = args.output.resolve()
    output.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(prefix="posteriq-deployment-") as temporary:
        staging = Path(temporary)
        packages = staging / ".python_packages/lib/site-packages"
        for name in BACKEND_FILES:
            destination = staging / name
            destination.parent.mkdir(parents=True, exist_ok=True)
            shutil.copy2(repo / name, destination)
        subprocess.run([
            sys.executable, "-m", "pip", "install", "--only-binary=:all:",
            "--target", str(packages), "-r", str(repo / "requirements.txt"),
        ], check=True)
        test_environment = dict(os.environ)
        test_environment["PYTHONPATH"] = str(packages)
        # Exercise the exact dependency set that will go into the ZIP.
        subprocess.run([
            sys.executable, "-m", "unittest", "discover", "-s", "tests", "-v",
        ], cwd=repo, env=test_environment, check=True)
        # -S excludes globally installed packages. Import application files from
        # the staged package and exercise its compiled PDF dependency as well.
        smoke_check = """
import json
import azure.functions as func
import pymupdf
import function_app
assert len(function_app.app.get_functions()) == 7
assert function_app.load_review_schema()['properties']['schema_version']['const'] == '1.1'
response = function_app.health(func.HttpRequest(method='GET', url='/api/health', body=b''))
assert response.status_code == 200
assert json.loads(response.get_body()) == {'service': 'PosterIQ', 'status': 'ok'}
document = pymupdf.open()
document.new_page().insert_text((72, 72), 'Deployment smoke check')
image = function_app.render_poster_image(document.tobytes())
document.close()
assert image['bytes'].startswith(b'\\x89PNG')
print('Isolated deployment package smoke checks passed.')
"""
        subprocess.run([sys.executable, "-S", "-c", smoke_check],
                       cwd=staging, env=test_environment, check=True)
        with zipfile.ZipFile(output, "w", compression=zipfile.ZIP_DEFLATED) as archive:
            for path in sorted(staging.rglob("*")):
                if path.is_file() and "__pycache__" not in path.parts and path.suffix != ".pyc":
                    archive.write(path, path.relative_to(staging).as_posix())
        with zipfile.ZipFile(output) as archive:
            names = archive.namelist()
            if not all(name in names for name in BACKEND_FILES) or archive.testzip() is not None:
                raise RuntimeError("Deployment ZIP failed verification.")
            if any(name.endswith("local.settings.json") or name == ".env" for name in names):
                raise RuntimeError("Local configuration must not be packaged.")
    print(f"Deployment ZIP ready: {output} ({output.stat().st_size / 1024**2:.1f} MiB)")


if __name__ == "__main__":
    main()
