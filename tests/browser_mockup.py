"""Optional real-browser checks: pip install playwright; playwright install chromium.

Run from the repository root: python tests/browser_mockup.py
No Azure credentials are used; the backend's real PDF-derived preview data is
rendered in the actual frontend. Core integration is covered by unittest.
"""

from functools import partial
from http.server import BaseHTTPRequestHandler, SimpleHTTPRequestHandler, ThreadingHTTPServer
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
            page.route("**/test-poster.png*", lambda route: route.fulfill(body=image, content_type="image/png"))
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
            assert page.locator("#posterViewer").is_visible()
            assert "1 draft edit applied" in page.locator("#viewerModeLabel").inner_text()
            assert page.locator(".viewer-edit-highlight").count() == 1
            fitted_width = page.locator("#viewerStage").bounding_box()["width"]
            page.locator("#posterZoom").select_option("3")
            assert page.locator("#viewerStage").bounding_box()["width"] > fitted_width * 2.9
            page.locator("#posterZoom").select_option("1")
            page.locator("#viewerOriginalButton").click()
            assert "Original poster" in page.locator("#viewerModeLabel").inner_text()
            assert page.locator("#downloadMockup").is_disabled()
            assert page.locator(".viewer-edit-highlight").count() == 0
            page.locator("#viewerMockupButton").click()
            assert page.locator("#mockupCanvas").evaluate("c=>c.toDataURL()") != original
            page.set_viewport_size({"width": 390, "height": 844})
            close_position = page.locator("#closePosterViewer").bounding_box()
            assert close_position["y"] >= 0 and close_position["x"] + close_position["width"] <= 390
            page.set_viewport_size({"width": 1440, "height": 1100})
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
                page.evaluate("""() => {
                    window.savedToBlob = mockupCanvas.toBlob.bind(mockupCanvas);
                    window.exportCalls = 0;
                    mockupCanvas.toBlob = (callback, type) => {
                        exportCalls++;
                        setTimeout(() => savedToBlob(callback, type), 1000);
                    };
                    downloadMockup.click(); downloadMockup.click(); downloadMockup.click();
                }""")
                assert page.locator("#downloadMockup").is_disabled()
                assert page.locator("#downloadMockup").inner_text() == "Preparing PNG…"
                assert "Please wait" in page.locator("#downloadStatus").inner_text()
                assert page.evaluate("exportCalls") == 1
            assert event.value.suggested_filename == "posteriq-suggested-layout.png"
            assert Path(event.value.path()).read_bytes().startswith(b"\x89PNG\r\n\x1a\n")
            assert "Download started" in page.locator("#downloadStatus").inner_text()
            assert not page.locator("#downloadMockup").is_disabled()
            page.evaluate("() => {mockupCanvas.toBlob = callback => callback(null);}")
            page.get_by_role("button", name="Download mockup PNG").click()
            assert "could not be prepared" in page.locator("#downloadStatus").inner_text()
            assert not page.locator("#downloadMockup").is_disabled()
            page.evaluate("() => {mockupCanvas.toBlob = savedToBlob;}")
            page.get_by_role("button", name="Close preview").click()
            page.get_by_role("button", name="Show original poster").click()
            assert page.locator("#posterPreview").is_visible()
            # A long review must not push the sticky poster out of sight.
            long_review = {**review, "findings": review["findings"] * 25}
            page.evaluate("review=>renderReview(review)", long_review)
            page.locator(".finding-card").nth(12).scroll_into_view_if_needed()
            position = page.locator(".poster-panel").bounding_box()
            assert position["y"] >= 0 and position["y"] + position["height"] <= 1100
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
            close_position = page.locator("#closePosterViewer").bounding_box()
            assert close_position["y"] >= 0 and close_position["x"] + close_position["width"] <= 390
            assert not errors, errors

            # Reproduce an Azure-like cross-origin image cache: the original
            # image response has no CORS header, but CORS requests are allowed.
            requests = []

            class ImageHandler(BaseHTTPRequestHandler):
                def do_GET(self):
                    origin = self.headers.get("Origin")
                    requests.append((self.path, origin))
                    self.send_response(200)
                    self.send_header("Content-Type", "image/png")
                    self.send_header("Cache-Control", "private, max-age=3600")
                    if origin:
                        self.send_header("Access-Control-Allow-Origin", origin)
                    # Deliberately omit Vary: Origin to exercise the stale cache.
                    self.end_headers()
                    self.wfile.write(image)

                def log_message(self, *args):
                    pass

            image_server = ThreadingHTTPServer(("127.0.0.1", 0), ImageHandler)
            image_thread = threading.Thread(target=image_server.serve_forever, daemon=True)
            image_thread.start()
            try:
                cached_page = browser.new_page()
                cached_page.goto(f"http://127.0.0.1:{server.server_port}/")
                url = f"http://127.0.0.1:{image_server.server_port}/cached-poster.png"
                cached_page.evaluate("url=>posterPreview.src=url", url)
                cached_page.wait_for_function("posterPreview.complete && posterPreview.naturalWidth > 0")
                assert requests[0] == ("/cached-poster.png", None)
                cached_page.evaluate("review=>renderReview(review)", review)
                cached_page.get_by_role("button", name="Preview suggested layout").click()
                cached_page.wait_for_function('document.querySelector("#mockupStatus").textContent.startsWith("1 of 1")')
                assert any(path == "/cached-poster.png?mockup=1" and origin for path, origin in requests)
                with cached_page.expect_download() as download:
                    cached_page.get_by_role("button", name="Download mockup PNG").click()
                assert Path(download.value.path()).read_bytes().startswith(b"\x89PNG\r\n\x1a\n")
                cached_page.close()
            finally:
                image_server.shutdown()
                image_server.server_close()
                image_thread.join()
            browser.close()
            print("Browser checks passed: preserved pixels, edits/reverts, zoom, version labels, changed-area outlines, download progress and deduplication, export failure recovery, sticky preview, mobile viewer, reset, zero findings, legacy sample and cached cross-origin images.")
    finally:
        server.shutdown()
        server.server_close()
        thread.join()


if __name__ == "__main__":
    main()
