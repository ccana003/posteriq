import base64
import json
import unittest
from types import SimpleNamespace
from unittest.mock import patch

import azure.functions as func
import function_app
from poster_builder import BuilderGenerationError, BuilderValidationError, draft_section, make_plan, review_document


def document():
    return {'poster_type': 'protocol', 'title': 'A planned study', 'authors': 'A Researcher',
            'sections': [{'id': 's1', 'title': 'Design', 'notes': 'We plan to enroll 120 participants.',
                          'text': 'Planned enrollment: 120 participants.', 'approved': True}]}


def client_for(result, captured=None):
    def complete(**kwargs):
        if captured is not None:
            captured.update(kwargs)
        return SimpleNamespace(choices=[SimpleNamespace(finish_reason='stop', message=SimpleNamespace(content=json.dumps(result)))])
    return SimpleNamespace(chat=SimpleNamespace(completions=SimpleNamespace(create=complete)))


class BuilderTests(unittest.TestCase):
    def test_plan_preserves_real_provenance_and_downgrades_invented_requirements(self):
        result = {'sections': [{'title': 'Design', 'purpose': 'Plan', 'question': 'What is planned?', 'requirement_level': 'required', 'source_reference_ids': ['fake']},
                               {'title': 'Credits', 'purpose': 'Credit', 'question': 'Who contributed?', 'requirement_level': 'required', 'source_reference_ids': ['rule-1']}], 'notes': []}
        records = [{'reference_id': 'rule-1', 'category': 'required_elements', 'source': 'Poster guide', 'guidance': {'text': 'Include credits.'}}]
        plan = make_plan(client_for(result), 'test', {'poster_type': 'protocol'}, records)
        self.assertEqual(plan['sections'][0]['requirement_level'], 'recommended')
        self.assertEqual(plan['sections'][1]['sources'][0]['source'], 'Poster guide')
        self.assertEqual(plan['sections'][1]['requirement_level'], 'required')

    def test_organizer_requirements_need_an_exact_supplied_quote(self):
        section = {'title':'Funding', 'purpose':'Disclose funding', 'question':'Who funded the work?',
                   'requirement_level':'required','source_reference_ids':[],
                   'organizer_requirement_quote':'Include funding disclosures.'}
        payload = {'poster_type':'research','event_requirements':'Include funding disclosures.'}
        result = make_plan(client_for({'sections':[section], 'notes':[]}), 'test', payload, [])
        self.assertEqual(result['sections'][0]['requirement_level'],'required')
        self.assertEqual(result['sections'][0]['sources'][0]['reference_id'],'Organizer instructions')
        section['organizer_requirement_quote']='Include an invented requirement.'
        result = make_plan(client_for({'sections':[section], 'notes':[]}), 'test', payload, [])
        self.assertEqual(result['sections'][0]['requirement_level'],'recommended')

    def test_draft_receives_whole_document_and_cannot_invent_numbers(self):
        captured = {}
        draft = draft_section(client_for({'text': 'Planned enrollment: 120 participants.', 'questions': [], 'editorial_notes': []}, captured), 'test', {'document': document(), 'section_id': 's1'}, [])
        self.assertIn('120', draft['text'])
        context = json.loads(captured['messages'][1]['content'])
        self.assertEqual(context['document']['poster_type'], 'protocol')
        with self.assertRaisesRegex(RuntimeError, 'numerical'):
            draft_section(client_for({'text': 'We enrolled 121 participants.', 'questions': [], 'editorial_notes': []}), 'test', {'document': document(), 'section_id': 's1'}, [])

    def test_missing_source_does_not_call_ai(self):
        doc = document(); doc['sections'][0]['notes'] = ''
        with self.assertRaises(BuilderValidationError):
            draft_section(None, 'test', {'document': doc, 'section_id': 's1'}, [])

    def test_review_uses_rendered_image_and_never_mutates_approved_text(self):
        doc = document(); before = json.dumps(doc)
        image = 'data:image/png;base64,' + base64.b64encode(b'\x89PNG\r\n\x1a\nfixture').decode()
        captured = {}
        result = review_document(client_for({'overview': 'Consistent plan.', 'strengths': ['Purpose'], 'findings': [], 'questions': [], 'limitations': []}, captured), 'test', {'document': doc, 'poster_image': image}, [])
        self.assertEqual(captured['messages'][1]['content'][1]['image_url']['url'], image)
        self.assertEqual(json.dumps(doc), before)
        self.assertEqual(result['findings'], [])

    def test_review_cannot_apply_multi_section_or_new_numeric_content(self):
        issue = {'section_ids': ['s1'], 'issue': 'Claim', 'evidence': '120', 'recommendation': 'Check it', 'suggested_text': 'Enroll 500 participants.', 'source_reference_ids': ['fake']}
        result = review_document(client_for({'overview': 'Review', 'strengths': [], 'findings': [issue], 'questions': [], 'limitations': []}), 'test', {'document': document()}, [])
        self.assertEqual(result['findings'][0]['suggested_text'], '')
        self.assertEqual(result['findings'][0]['source_reference_ids'], [])

    def test_invalid_payload_and_unknown_action_fail_without_model(self):
        request = func.HttpRequest(method='POST',url='/api/builder/nope',body=b'{}',route_params={'action':'nope'})
        self.assertEqual(function_app.poster_builder_action(request).status_code,404)
        request = func.HttpRequest(method='POST',url='/api/builder/plan',body=b'[]',route_params={'action':'plan'})
        self.assertEqual(function_app.poster_builder_action(request).status_code,400)

    def test_rejected_ai_draft_returns_safe_author_facing_explanation(self):
        req = func.HttpRequest(method='POST',url='/api/builder/draft',body=b'{}',route_params={'action':'draft'})
        with patch.object(function_app,'get_openai_client'),patch.object(function_app,'load_guidance_records',return_value=[]), \
             patch.object(function_app,'draft_section',side_effect=BuilderGenerationError('The draft introduced numerical content not present in your notes.')), \
             patch.dict('os.environ',{'POSTERIQ_OPENAI_DEPLOYMENT':'test'}):
            response = function_app.poster_builder_action(req)
        self.assertEqual(response.status_code,502)
        self.assertIn('numerical content',json.loads(response.get_body())['error'])

    def test_ai_failure_is_recoverable_and_does_not_leak_details(self):
        req = func.HttpRequest(method='POST',url='/api/builder/plan',body=b'{"poster_type":"protocol"}',route_params={'action':'plan'})
        with patch.object(function_app,'get_openai_client',side_effect=RuntimeError('SECRET')),patch.object(function_app,'load_guidance_records',return_value=[]):
            response = function_app.poster_builder_action(req)
        self.assertEqual(response.status_code,502)
        self.assertNotIn('SECRET',response.get_body().decode())

if __name__=='__main__': unittest.main()
