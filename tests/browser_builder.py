"""Real-browser builder workflow checks with deterministic AI responses; no Azure credentials."""
import json
import shutil
import threading
from functools import partial
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

import pymupdf
from playwright.sync_api import sync_playwright


class QuietHandler(SimpleHTTPRequestHandler):
    def log_message(self, *args):
        pass


def main():
    frontend = Path(__file__).resolve().parents[1] / 'frontend'
    server = ThreadingHTTPServer(('127.0.0.1', 0), partial(QuietHandler, directory=str(frontend)))
    threading.Thread(target=server.serve_forever, daemon=True).start()
    captured = []
    try:
        with sync_playwright() as playwright:
            options = {'headless': True}
            if shutil.which('chromium'):
                options.update(executable_path=shutil.which('chromium'), args=['--no-sandbox'])
            browser = playwright.chromium.launch(**options)
            page = browser.new_page(viewport={'width':1440,'height':1100},accept_downloads=True)
            errors = []
            page.on('pageerror',lambda error:errors.append(str(error)))
            page.on('dialog',lambda dialog:dialog.accept())
            def ai(route):
                payload=route.request.post_data_json
                captured.append((route.request.url,payload))
                action=route.request.url.rsplit('/',1)[-1]
                if action=='plan':
                    result={'sections':[{'id':'section-1','title':'Background','purpose':'Explain the problem.','question':'What problem does your study address?','requirement_level':'recommended','sources':[]}, {'id':'section-2','title':'Conclusion','purpose':'State the takeaway.','question':'What is the supported takeaway?','requirement_level':'recommended','sources':[]}], 'notes':['Fixture guidance is a suggested starting point.'],'guidance_available':False}
                elif action=='draft':
                    result={'text':'• Enrollment was 120 participants.\n• Estimates remain uncertain.','questions':[],'editorial_notes':['Shortened the narrative without changing the supplied values.']}
                else:
                    result={'overview':'Purpose and findings agree.','strengths':['The figure has a caption.'],'findings':[{'section_ids':['section-2'],'issue':'Repeated statement','evidence':'Enrollment was 120 participants.','recommendation':'Focus the conclusion on uncertainty.','suggested_text':'Estimates remain uncertain.','source_reference_ids':[]}],'questions':[],'limitations':['Author review remains necessary.']}
                route.fulfill(json=result)
            page.route('**/api/builder/*',ai)
            page.goto(f'http://127.0.0.1:{server.server_port}/builder.html')
            page.get_by_text('Drafts save on this browser and device',exact=True).wait_for()
            page.locator('#posterTitle').fill('A source-grounded poster')
            page.locator('#posterAuthors').fill('Research Team')
            page.locator('#posterAffiliations').fill('University')
            page.locator('#posterAudience').fill('Clinical researchers')
            page.locator('#planPoster').click()
            page.locator('#sectionNotes').fill('Enrollment was 120 participants. Estimates remain uncertain.')
            placeholder=page.locator('#builderCanvas').evaluate('canvas=>canvas.toDataURL()')
            page.locator('#draftSection').click()
            page.wait_for_function('document.getElementById("sectionText").value.includes("120")')
            assert 'Draft —' in page.locator('#approvalStatus').inner_text()
            assert page.locator('#builderCanvas').evaluate('canvas=>canvas.toDataURL()')==placeholder
            page.locator('#approveSection').click()
            assert page.locator('#builderCanvas').evaluate('canvas=>canvas.toDataURL()')!=placeholder
            assert 'Approved and placed' in page.locator('#approvalStatus').inner_text()
            page.locator('#nextSection').click()
            page.locator('#sectionNotes').fill('Enrollment was 120 participants. Estimates remain uncertain.')
            page.locator('#draftSection').click()
            page.wait_for_function('document.getElementById("sectionText").value.includes("120")')
            page.locator('#approveSection').click()
            assert 'not approved' not in page.locator('#layoutWarnings').inner_text()
            # Templates rearrange approved content, never rewrite it.
            page.locator('#builderTemplate').select_option('two')
            assert 'Approved and placed' in page.locator('#approvalStatus').inner_text()
            assert '120' in page.locator('#sectionText').input_value()
            page.locator('#compareTemplates').click()
            assert page.locator('#templateOptions canvas').count()==2
            page.locator('#closeTemplateDialog').click()
            # Drag the actual canvas overlay and verify the saved normalized geometry changes.
            handle=page.locator('[data-section-id="section-2"]')
            handle.scroll_into_view_if_needed()
            before=handle.bounding_box()
            page.mouse.move(before['x']+25,before['y']+25)
            page.mouse.down();page.mouse.move(before['x']+65,before['y']+45,steps=8);page.mouse.up()
            assert float(page.locator('#sectionX').input_value())>51
            # Resize the selected canvas region without invalidating approved wording.
            handle=page.locator('[data-section-id="section-2"]')
            corner=handle.locator('.resize-handle');corner.scroll_into_view_if_needed()
            size_before=handle.bounding_box()['width'];bounds=corner.bounding_box()
            page.mouse.move(bounds['x']+5,bounds['y']+5);page.mouse.down()
            page.mouse.move(bounds['x']+30,bounds['y']+20,steps=6);page.mouse.up()
            assert page.locator('[data-section-id="section-2"]').bounding_box()['width']>size_before
            assert 'Approved and placed' in page.locator('#approvalStatus').inner_text()
            # Figure upload, description, caption and approval.
            page.locator('#addFigure').click()
            image_doc=pymupdf.open();image_page=image_doc.new_page(width=300,height=180)
            image_page.draw_rect(pymupdf.Rect(25,25,150,140),fill=(0,.5,.6))
            image_page.insert_text((30,165),'Observed response')
            png=image_page.get_pixmap().tobytes('png');image_doc.close()
            page.locator('#figureFile').set_input_files({'name':'figure.png','mimeType':'image/png','buffer':png})
            page.get_by_text('Figure added. Describe what it shows, add its caption, and approve it.',exact=True).wait_for()
            page.locator('#figureDescription').fill('A diagram representing the supplied observations.')
            page.locator('#figureCaption').fill('Observed response in the supplied study.')
            page.locator('#approveSection').click()
            # Save/restore includes approvals and the embedded figure.
            with page.expect_download() as download:
                page.locator('#backupDraft').click()
            backup=json.loads(Path(download.value.path()).read_text())
            assert all(s['approved'] for s in backup['sections'])
            assert backup['sections'][2]['imageData'].startswith('data:image/png;base64,')
            page.wait_for_function('document.getElementById("saveStatus").textContent.startsWith("Saved")')
            page.reload()
            page.get_by_text('Draft restored from this device',exact=True).wait_for()
            assert page.locator('#sectionSteps li').count()==3
            # A response generated from stale notes must not overwrite new author edits.
            held=[]
            def hold(route): held.append(route)
            page.route('**/api/builder/draft',hold)
            original_text=page.locator('#sectionText').input_value()
            page.locator('#sectionNotes').fill('Enrollment was 120 participants. Estimates remain uncertain.')
            page.locator('#draftSection').click()
            page.wait_for_timeout(100)
            assert held
            page.locator('#sectionNotes').fill('Enrollment was 120 participants. Estimates remain uncertain. Updated source notes.')
            held[0].fulfill(json={'text':'STALE RESPONSE','questions':[],'editorial_notes':[]})
            page.wait_for_function('document.getElementById("builderMessage").textContent.includes("response was not applied")')
            assert page.locator('#sectionText').input_value()==original_text
            page.unroute('**/api/builder/draft',hold)
            page.locator('#approveSection').click()
            # A backend that has not been deployed leaves the poster intact.
            def absent(route): route.fulfill(status=404,json={'error':'Not found'})
            page.route('**/api/builder/review',absent)
            page.locator('#checkPoster').click()
            page.wait_for_function('document.getElementById("builderMessage").textContent.includes("not deployed yet")')
            assert 'Approved and placed' in page.locator('#approvalStatus').inner_text()
            page.unroute('**/api/builder/review',absent)
            # Imported backups preserve content and embedded figures too.
            page.locator('#importDraft').set_input_files({'name':'draft.json','mimeType':'application/json','buffer':json.dumps(backup).encode()})
            page.get_by_text('Editable draft opened.',exact=True).wait_for()
            page.locator('#checkPoster').click()
            page.locator('#consistencyResults').wait_for(state='visible')
            assert captured[-1][1]['poster_image'].startswith('data:image/png;base64,')
            assert all('imageData' not in section for section in captured[-1][1]['document']['sections'])
            page.get_by_role('button',name='Use as an unapproved draft').click()
            assert page.locator('#sectionText').input_value()=='Estimates remain uncertain.'
            assert 'Draft —' in page.locator('#approvalStatus').inner_text()
            assert 'changed after this review' in page.locator('#reviewStale').inner_text()
            page.locator('#approveSection').click()
            # PNG handoff and no repeated download while encoding.
            with page.expect_download() as download:
                page.locator('#downloadPoster').click()
            assert Path(download.value.path()).read_bytes().startswith(b'\x89PNG')
            page.screenshot(path='/tmp/posteriq-builder-desktop.png',full_page=True)
            page.set_viewport_size({'width':390,'height':844})
            assert page.evaluate('document.documentElement.scrollWidth <= innerWidth')
            page.screenshot(path='/tmp/posteriq-builder-mobile.png',full_page=True)
            assert not errors, errors
            browser.close()
        print('Builder browser checks passed: guided AI drafting, approvals, template stability, drag, figure upload, local restore, review image, explicit suggestion approval, PNG export and mobile layout.')
    finally:
        server.shutdown();server.server_close()

if __name__=='__main__': main()
