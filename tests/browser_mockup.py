"""Optional real-browser checks: pip install playwright; playwright install chromium.

Run from the repository root: python tests/browser_mockup.py
No Azure credentials are used; the backend's real PDF-derived preview data is
rendered in the actual frontend. Core integration is covered by unittest.
"""

from functools import partial
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
import shutil
import sys
import threading

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from playwright.sync_api import sync_playwright
from function_app import render_poster_image
from poster_mockup import prepare_mockup
from test_poster_mockup import fixture


class QuietHandler(SimpleHTTPRequestHandler):
    def log_message(self, *args):
        pass


def main():
    pdf, structure, review = fixture()
    review = prepare_mockup(review, structure, pdf)
    image = render_poster_image(pdf)["bytes"]
    frontend = Path(__file__).resolve().parents[1] / "frontend"
    server = ThreadingHTTPServer(("127.0.0.1", 0), partial(QuietHandler, directory=str(frontend)))
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    try:
        with sync_playwright() as playwright:
            options = {"headless": True}
            if shutil.which("chromium"):
                options["executable_path"] = shutil.which("chromium")
                options["args"] = ["--no-sandbox"]
            browser = playwright.chromium.launch(**options)
            page = browser.new_page(viewport={"width": 1440, "height": 1100})
            errors = []
            page.on("pageerror", lambda error: errors.append(str(error)))
            page.goto(f"http://127.0.0.1:{server.server_port}/")
            page.route("**/test-poster.png", lambda route: route.fulfill(body=image, content_type="image/png"))
            page.evaluate('(review) => {posterPreview.src="/test-poster.png";renderReview(review);}', review)
            page.get_by_role("button", name="Preview suggested layout").click()
            page.wait_for_function('document.querySelector("#mockupStatus").textContent.startsWith("1 of 1")')
            original = page.evaluate("""() => {
                const c=document.createElement('canvas');
                c.width=mockupCanvas.width;c.height=mockupCanvas.height;
                c.getContext('2d').drawImage(posterMockup.image,0,0,c.width,c.height);
                return c.toDataURL();
            }""")
            assert page.locator("#mockupCanvas").is_visible()
            assert page.locator("#mockupCanvas").evaluate("c=>c.toDataURL()") != original
            assert page.evaluate("""() => {
                const c=document.createElement('canvas');
                c.width=mockupCanvas.width;c.height=mockupCanvas.height;
                const ctx=c.getContext('2d');ctx.drawImage(posterMockup.image,0,0,c.width,c.height);
                const out=mockupCanvas.getContext('2d');
                return [[700,160,400,340],[0,0,100,100]].every(r=>{
                    const a=ctx.getImageData(...r).data,b=out.getImageData(...r).data;
                    return a.every((v,i)=>v===b[i]);
                });
            }""")
            page.locator("#mockupChanges input").uncheck()
            assert page.locator("#mockupCanvas").evaluate("c=>c.toDataURL()") == original
            page.locator("#mockupChanges input").check()
            page.locator("#mockupText0").fill("An overlong draft sentence. " * 180)
            assert "does not fit" in page.locator(".mockup-edit-status").inner_text()
            assert page.locator("#mockupCanvas").evaluate("c=>c.toDataURL()") == original
            page.locator("#mockupText0").fill("Enrollment: 120 participants. Response rate: 80%.")
            with page.expect_download() as event:
                page.get_by_role("button", name="Download mockup PNG").click()
            assert event.value.suggested_filename == "posteriq-suggested-layout.png"
            assert Path(event.value.path()).read_bytes().startswith(b"\x89PNG\r\n\x1a\n")
            page.get_by_role("button", name="Show original poster").click()
            assert page.locator("#posterPreview").is_visible()
            page.evaluate("resetReview()")
            assert page.locator("#mockupButton").is_disabled()
            empty = {**review, "findings": [], "mockup": {"changes": [], "omitted_count": 0},
                     "summary": {**review["summary"], "top_priorities": []}}
            page.evaluate("review=>renderReview(review)", empty)
            page.get_by_role("button", name="Preview suggested layout").click()
            page.wait_for_function('document.querySelector("#mockupStatus").textContent.includes("No clear issues")')
            assert page.locator("#mockupCanvas").evaluate("c=>c.toDataURL()") == original
            page.evaluate("resetReview()")
            page.get_by_role("button", name="Explore a sample review").click()
            page.wait_for_function("currentReview !== null")
            assert page.locator("#mockupButton").is_disabled()
            page.set_viewport_size({"width": 390, "height": 844})
            page.evaluate('(review)=>{posterPreview.src="/test-poster.png";renderReview(review)}', review)
            page.get_by_role("button", name="Preview suggested layout").click()
            page.wait_for_function('document.querySelector("#mockupStatus").textContent.startsWith("1 of 1")')
            # Check this feature's mobile layout; the existing site header has
            # independent overflow and is outside these changes.
            assert page.locator("#mockupCanvas").evaluate("e=>e.getBoundingClientRect().right<=window.innerWidth")
            assert page.locator("#mockupEditor").evaluate("e=>e.scrollWidth<=e.clientWidth")
            assert not errors, errors
            browser.close()
            print("Browser checks passed: preserved figure pixels, edits/reverts, overflow protection, PNG download, original toggle, reset, zero findings, legacy sample and mobile editor.")
    finally:
        server.shutdown()
        server.server_close()
        thread.join()


if __name__ == "__main__":
    main()
