import json
import unittest
from unittest.mock import patch
import azure.functions as func
import function_app
from types import SimpleNamespace
import pymupdf
from article_import import extract_article, propose_article, figure_regions
from poster_builder import BuilderValidationError


def pdf_fixture():
    doc=pymupdf.open()
    p=doc.new_page()
    p.insert_textbox(pymupdf.Rect(40,40,550,300),'Study purpose: assess response. We enrolled 120 participants. Response was 80%. Estimates are uncertain. This article reports the observed study, not a planned protocol.',fontsize=12)
    p=doc.new_page();p.insert_text((40,50),'Limitations: a small sample limits generalizability.')
    data=doc.tobytes();doc.close();return data


def client(result):
    return SimpleNamespace(chat=SimpleNamespace(completions=SimpleNamespace(create=lambda **kw: SimpleNamespace(choices=[SimpleNamespace(finish_reason='stop',message=SimpleNamespace(content=json.dumps(result)))]))))


class ArticleTests(unittest.TestCase):
    def test_extraction_keeps_page_provenance(self):
        article=extract_article(pdf_fixture(),'paper.pdf')
        self.assertEqual(article['page_count'],2)
        self.assertEqual(article['blocks'][-1]['page'],2)
        self.assertIn('120',article['blocks'][0]['text'])
        self.assertFalse(article['needs_ocr'])

    def test_non_pdf_and_locked_document_fail_cleanly(self):
        with self.assertRaises(BuilderValidationError):extract_article(b'not a PDF','fake.pdf')
        doc=pymupdf.open();doc.new_page()
        encrypted=doc.tobytes(encryption=pymupdf.PDF_ENCRYPT_AES_256,owner_pw='owner',user_pw='reader');doc.close()
        with self.assertRaisesRegex(BuilderValidationError,'unlocked'):extract_article(encrypted,'locked.pdf')

    def test_article_drafts_are_unapproved_and_numerically_grounded(self):
        article=extract_article(pdf_fixture(),'paper.pdf');source=article['blocks'][0]
        response={'title':'Study','authors':'Authors','affiliations':'Institute','citation':'Supplied citation',
                  'sections':[{'title':'Results','purpose':'Report observations','text':'Enrollment: 120 participants. Response: 80%.','source_block_ids':[source['id']]}], 'questions':[],'limitations':[]}
        result=propose_article(client(response),'test',article,{},[])
        self.assertFalse(result['sections'][0]['approved'])
        self.assertEqual(result['sections'][0]['source_excerpts'][0]['page'],1)
        self.assertIn('120',result['sections'][0]['notes'])
        response['sections'][0]['text']='Enrollment: 999 participants.'
        with self.assertRaisesRegex(RuntimeError,'source-supported'):propose_article(client(response),'test',article,{},[])

    def test_embedded_figure_candidates_keep_their_page(self):
        image_doc=pymupdf.open();image_page=image_doc.new_page(width=200,height=100)
        image_page.draw_rect(pymupdf.Rect(20,20,180,80),fill=(0,.5,.4))
        image=image_page.get_pixmap().tobytes('png');image_doc.close()
        doc=pymupdf.open(stream=pdf_fixture(),filetype='pdf')
        doc[1].insert_image(pymupdf.Rect(40,100,440,300),stream=image)
        data=doc.tobytes();doc.close()
        article=extract_article(data,'figures.pdf')
        self.assertEqual(article['figures'][0]['page'],2)
        self.assertTrue(article['figures'][0]['imageData'].startswith('data:image/png;base64,'))

    def test_captioned_vector_panels_are_grouped_as_a_figure(self):
        doc=pymupdf.open();page=doc.new_page(width=600,height=800)
        page.draw_rect(pymupdf.Rect(60,120,260,280),color=(0,0,0))
        page.draw_rect(pymupdf.Rect(280,120,480,280),color=(0,0,0))
        page.insert_text((80,150),'Panel A: response')
        page.insert_text((300,150),'Panel B: survival')
        page.insert_textbox(pymupdf.Rect(45,330,550,400),'Figure 1. Observed response and survival. These observations are uncertain and must be interpreted with the study limitations.',fontsize=12)
        regions=figure_regions(page,page.get_text('blocks',sort=True))
        self.assertEqual(regions[0]['kind'],'captioned figure')
        self.assertTrue(regions[0]['rect'].contains(pymupdf.Rect(60,120,480,280)))
        article=extract_article(doc.tobytes(),'vector.pdf');doc.close()
        self.assertTrue(article['figures'][0]['recommended'])
        self.assertIn('Figure 1.',article['figures'][0]['caption'])

    def test_caption_does_not_claim_a_chart_in_another_column(self):
        doc=pymupdf.open();page=doc.new_page(width=600,height=800)
        page.draw_rect(pymupdf.Rect(340,100,550,270),color=(0,0,0))
        page.insert_text((40,300),'Figure 1. Left column figure.')
        self.assertEqual(figure_regions(page,page.get_text('blocks',sort=True)),[])
        doc.close()

    def test_multipart_article_route_returns_unapproved_source_linked_drafts(self):
        pdf=pdf_fixture();article=extract_article(pdf,'paper.pdf')
        response={'title':'Study','authors':'Authors','affiliations':'Institute','citation':'',
                  'sections':[{'title':'Results','purpose':'Report findings','text':'Enrollment: 120 participants.',
                               'source_block_ids':[article['blocks'][0]['id']]}], 'questions':[],'limitations':[]}
        boundary='posteriq-test-boundary'
        body=(f'--{boundary}\r\nContent-Disposition: form-data; name="file"; filename="paper.pdf"\r\nContent-Type: application/pdf\r\n\r\n'.encode()+pdf+f'\r\n--{boundary}--\r\n'.encode())
        request=func.HttpRequest(method='POST',url='/api/builder/article',body=body,
            headers={'Content-Type':f'multipart/form-data; boundary={boundary}'},route_params={'action':'article'})
        with patch.object(function_app,'get_openai_client',return_value=client(response)), \
             patch.object(function_app,'load_guidance_records',return_value=[]), \
             patch.dict('os.environ',{'POSTERIQ_OPENAI_DEPLOYMENT':'test'}):
            result=function_app.poster_builder_action(request)
        self.assertEqual(result.status_code,200)
        payload=json.loads(result.get_body())
        self.assertEqual(payload['sections'][0]['source_excerpts'][0]['page'],1)
        self.assertFalse(payload['sections'][0]['approved'])

    def test_unknown_source_references_cannot_be_imported(self):
        article=extract_article(pdf_fixture(),'paper.pdf')
        response={'title':'Study','authors':'Authors','affiliations':'Institute','citation':'',
                  'sections':[{'title':'Conclusion','purpose':'Takeaway','text':'Unsupported text','source_block_ids':['fake']}], 'questions':[],'limitations':[]}
        with self.assertRaisesRegex(RuntimeError,'source-supported'):propose_article(client(response),'test',article,{},[])

if __name__=='__main__':unittest.main()
