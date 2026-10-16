"""Knowledge Manager UI flows with a fake identity provider and deterministic API."""
import json
import shutil
import threading
from functools import partial
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

from playwright.sync_api import sync_playwright


class QuietHandler(SimpleHTTPRequestHandler):
    def log_message(self, *args):
        pass


def main():
    frontend = Path(__file__).resolve().parents[1] / 'frontend'
    server = ThreadingHTTPServer(('127.0.0.1', 0), partial(QuietHandler, directory=str(frontend)))
    threading.Thread(target=server.serve_forever, daemon=True).start()
    try:
        with sync_playwright() as playwright:
            options = {'headless': True}
            if shutil.which('chromium'):
                options.update(executable_path=shutil.which('chromium'), args=['--no-sandbox'])
            browser = playwright.chromium.launch(**options)
            page = browser.new_page()
            errors, captured = [], []
            public_mode = [False]
            page.on('pageerror', lambda error: errors.append(str(error)))
            page.on('dialog', lambda dialog: dialog.accept())
            # Identity provider is stubbed, but the real page and all UI handlers run.
            page.route('**/msal-browser.min.js', lambda route: route.fulfill(
                content_type='application/javascript', body='''window.msal = { PublicClientApplication: class {
                    async initialize() {}
                    getAllAccounts() { return window.signedIn ? [{}] : []; }
                    async acquireTokenSilent() { return {accessToken: "test-editor-token"}; }
                    async acquireTokenPopup() { window.signedIn = true; return {accessToken: "test-editor-token"}; }
                }};'''))
            records = [{'reference_id': 'RULE-1', 'category': 'readability', 'title': 'Original guidance',
                        'text': 'Original standard', 'knowledge_file': 'guide.json', 'etag': '"v1"',
                        'applies_to': [], 'keywords': [], 'source': 'Original guide'}]
            sources = [{'knowledge_file': 'guide.json', 'title': 'Original guide'}]
            response_status = [200]

            def api(route):
                request = route.request
                if request.url.endswith('/access'):
                    route.fulfill(json={'mode': 'public'} if public_mode[0] else
                                  {'tenant_id': 'tenant', 'client_id': 'spa', 'scope': 'Knowledge.Write'})
                elif request.method == 'GET':
                    route.fulfill(json={'records': records, 'sources': sources})
                else:
                    captured.append(request)
                    if public_mode[0]:
                        assert 'authorization' not in request.headers
                    else:
                        assert request.headers['authorization'] == 'Bearer test-editor-token'
                    if request.method in ('PUT', 'DELETE'):
                        assert request.headers['if-match'] == '"v1"'
                    if response_status[0] != 200:
                        route.fulfill(status=response_status[0], json={})
                        return
                    if request.method == 'DELETE':
                        records.clear()
                    elif request.method == 'POST':
                        records.append(dict(request.post_data_json, etag='"v1"'))
                    else:
                        records[0].update(request.post_data_json)
                    route.fulfill(status=201 if request.method == 'POST' else 200,
                                  json={'message': 'Guidance deleted.' if request.method == 'DELETE' else 'Guidance saved.'})

            page.route('**/api/knowledge**', api)
            page.goto(f'http://127.0.0.1:{server.server_port}/knowledge.html')
            page.get_by_role('heading', name='Original guidance').wait_for()
            page.wait_for_function('!document.getElementById("knowledgeSignIn").disabled')
            page.get_by_role('button', name='Edit', exact=True).click()
            assert page.locator('#guidanceSource').is_disabled()
            page.locator('#guidanceTitle').fill('Edited guidance')
            page.get_by_role('button', name='Save guidance', exact=True).click()
            page.get_by_text('Click Sign in to edit before saving or deleting guidance.', exact=True).wait_for()
            assert not captured
            assert page.locator('#guidanceTitle').input_value() == 'Edited guidance'
            page.locator('#cancelGuidanceButton').click()
            page.locator('#knowledgeSignIn').click()
            page.get_by_text('Signed in. Changes require the Knowledge Editor role.', exact=True).wait_for()
            page.get_by_role('button', name='Edit', exact=True).click()
            page.locator('#guidanceTitle').fill('Edited guidance')
            # Validation, authentication, authorization, and stale-write errors retain drafts.
            for status, text in ((400, 'Check the guidance fields'), (401, 'Sign in to edit, then retry'),
                                 (403, 'Your account needs the Knowledge Editor role'),
                                 (412, 'This document changed. Reload the page')):
                response_status[0] = status
                page.get_by_role('button', name='Save guidance', exact=True).click()
                page.locator('#guidanceFormStatus').filter(has_text=text).wait_for()
                assert page.locator('#guidanceTitle').input_value() == 'Edited guidance'
                assert page.locator('#guidanceModal').is_visible()
            response_status[0] = 200
            page.get_by_role('button', name='Save guidance', exact=True).click()
            page.get_by_role('heading', name='Edited guidance').wait_for()
            assert page.locator('#reviewAreaFilter option').count() == 2  # No duplicate filter options.
            page.get_by_role('button', name='Delete', exact=True).click()
            page.get_by_text('Guidance deleted.', exact=True).wait_for()
            assert not records
            page.locator('#addGuidanceButton').click()
            assert page.locator('#guidanceSource').is_enabled()
            page.locator('#guidanceCategory').select_option('readability')
            page.locator('#guidanceReferenceId').fill('INTERNAL-1')
            page.locator('#guidanceTitle').fill('Internal standard')
            page.locator('#guidanceText').fill('Use supported, readable text.')
            page.locator('#guidanceSource').select_option('posteriq-internal.json')
            # No source section or publication required for internally developed guidance.
            page.get_by_role('button', name='Save guidance', exact=True).click()
            page.get_by_role('heading', name='Internal standard').wait_for()
            assert captured[-1].post_data_json['source_section'] == ''
            # Public testing mode has no sign-in requirement but keeps version headers.
            public_mode[0] = True
            page.reload()
            page.get_by_text('You can add, edit and delete guidance. Sign-in is not required.', exact=True).wait_for()
            assert page.locator('#knowledgeSignIn').is_hidden()
            page.get_by_role('button', name='Edit', exact=True).click()
            page.locator('#guidanceTitle').fill('Publicly edited standard')
            page.get_by_role('button', name='Save guidance', exact=True).click()
            page.get_by_role('heading', name='Publicly edited standard').wait_for()
            page.get_by_role('button', name='Delete', exact=True).click()
            page.get_by_text('Guidance deleted.', exact=True).wait_for()
            page.locator('#addGuidanceButton').click()
            page.locator('#guidanceCategory').select_option('readability')
            page.locator('#guidanceReferenceId').fill('PUBLIC-1')
            page.locator('#guidanceTitle').fill('Publicly added standard')
            page.locator('#guidanceText').fill('Use short sentences.')
            page.locator('#guidanceSource').select_option('posteriq-internal.json')
            page.get_by_role('button', name='Save guidance', exact=True).click()
            page.get_by_role('heading', name='Publicly added standard').wait_for()
            assert not errors, errors
            browser.close()
            print('Knowledge Manager sign-in, validation, stale edits, create, edit and delete browser checks passed.')
    finally:
        server.shutdown()
        server.server_close()


if __name__ == '__main__':
    main()
