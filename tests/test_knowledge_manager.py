import copy
import json
import time
import unittest
from types import SimpleNamespace
from unittest.mock import patch

import azure.functions as func
from azure.core import MatchConditions
from azure.core.exceptions import HttpResponseError, ResourceExistsError
from cryptography.hazmat.primitives.asymmetric import rsa
import jwt

import function_app
import knowledge_auth
from knowledge_manager import KnowledgeError, KnowledgeStore, INTERNAL_FILE, INTERNAL_SOURCE

TENANT = '11111111-1111-1111-1111-111111111111'
API = '22222222-2222-2222-2222-222222222222'
SPA = '33333333-3333-3333-3333-333333333333'
CONFIG = {'POSTERIQ_KNOWLEDGE_ALLOW_ANONYMOUS_WRITES': 'false',
          'POSTERIQ_KNOWLEDGE_TENANT_ID': TENANT,
          'POSTERIQ_KNOWLEDGE_API_CLIENT_ID': API, 'POSTERIQ_KNOWLEDGE_SPA_CLIENT_ID': SPA}


def payload(**changes):
    return dict({'knowledge_file': 'guide.json', 'reference_id': 'RULE-2', 'category': 'readability',
                 'title': 'Readable text', 'text': 'Use short sentences.', 'source_page': 2,
                 'source_section': 'Design', 'applies_to': ['body_text'], 'keywords': ['readable']}, **changes)


def document():
    return {'source_document': {'title': 'Original guide', 'organization': 'Research Office',
                               'date': '2026', 'curation_status': 'curated', 'custom': 'keep'},
            'schema_version': '1.0', 'extra': {'keep': True},
            'guidance_records': [{'reference_id': 'RULE-1', 'category': 'readability',
                                  'guidance': {'title': 'Original', 'text': 'Original standard', 'extra': 'keep'},
                                  'custom_record_field': ['keep'], 'keywords': []}]}


def azure_error(status):
    error = HttpResponseError(message='Storage conflict')
    error.status_code = status
    return error


class FakeContainer:
    def __init__(self, docs=None):
        self.docs = copy.deepcopy(docs if docs is not None else {'guide.json': document()})
        self.versions = {name: 1 for name in self.docs}
        self.locked = False
        self.uploads = []
        self.concurrent_change = False
        self.malformed = False

    def list_blobs(self):
        return [SimpleNamespace(name=name) for name in self.docs]

    def get_blob_client(self, name):
        container = self

        class Blob:
            def download_blob(self):
                return SimpleNamespace(readall=lambda: json.dumps(container.docs[name]).encode(),
                                       properties=SimpleNamespace(etag=f'"v{container.versions[name]}"'))

            def upload_blob(self, content, **options):
                if name == '.knowledge-manager.lock':
                    raise ResourceExistsError('exists')
                container.uploads.append((name, options))
                if container.concurrent_change:
                    raise azure_error(412)
                if options.get('overwrite') is False and name in container.docs:
                    raise ResourceExistsError('exists')
                if options.get('overwrite'):
                    assert options['match_condition'] == MatchConditions.IfNotModified
                    assert options['etag'] == f'"v{container.versions[name]}"'
                container.docs[name] = json.loads(content)
                container.versions[name] = container.versions.get(name, 0) + 1

            def acquire_lease(self, lease_duration):
                assert lease_duration == -1
                if container.locked:
                    raise azure_error(409)
                container.locked = True
                return SimpleNamespace(release=lambda: setattr(container, 'locked', False))
        return Blob()


class KnowledgeStorageTests(unittest.TestCase):
    def setUp(self):
        self.container = FakeContainer()
        self.store = KnowledgeStore(self.container)

    def test_create_preserves_document_source_and_other_records(self):
        original = copy.deepcopy(self.container.docs['guide.json'])
        self.store.mutate('POST', payload())
        saved = self.container.docs['guide.json']
        self.assertEqual(saved['source_document'], original['source_document'])
        self.assertEqual(saved['guidance_records'][0], original['guidance_records'][0])
        self.assertEqual(saved['extra'], original['extra'])
        self.assertEqual(saved['guidance_records'][1]['guidance']['text'], 'Use short sentences.')
        self.assertFalse(self.container.locked)

    def test_internal_guidance_needs_no_publication(self):
        self.store.mutate('POST', payload(knowledge_file='', source_section='', source_page=None))
        self.assertEqual(self.container.docs[INTERNAL_FILE]['source_document'], INTERNAL_SOURCE)
        self.assertEqual(len(self.container.docs['guide.json']['guidance_records']), 1)
        self.assertFalse(self.container.uploads[-1][1]['overwrite'])

    def test_edit_preserves_unknown_fields_and_metadata(self):
        self.store.mutate('PUT', payload(reference_id='RULE-1'), 'RULE-1', '"v1"')
        doc = self.container.docs['guide.json']
        self.assertEqual(doc['source_document']['custom'], 'keep')
        self.assertEqual(doc['guidance_records'][0]['custom_record_field'], ['keep'])
        self.assertEqual(doc['guidance_records'][0]['guidance']['extra'], 'keep')
        self.assertEqual(doc['guidance_records'][0]['guidance']['title'], 'Readable text')

    def test_delete_last_record_keeps_source_document_discoverable(self):
        self.store.mutate('DELETE', reference_id='RULE-1', etag='"v1"', knowledge_file='guide.json')
        records, sources = self.store.snapshot()
        self.assertEqual(records, [])
        self.assertEqual(sources[0]['title'], 'Original guide')
        self.assertEqual(self.container.docs['guide.json']['extra'], {'keep': True})
        self.store.mutate('POST', payload())  # Empty source can receive new guidance.

    def test_duplicate_ids_rejected_globally_case_insensitively(self):
        with self.assertRaises(KnowledgeError) as error:
            self.store.mutate('POST', payload(reference_id='rule-1', knowledge_file=INTERNAL_FILE))
        self.assertEqual(error.exception.status, 409)
        self.assertFalse(self.container.uploads)

    def test_stale_and_missing_versions_cannot_overwrite_or_delete(self):
        for method in ('PUT', 'DELETE'):
            for version, status in ((None, 428), ('*', 428), ('"stale"', 412)):
                with self.subTest(method=method, version=version), self.assertRaises(KnowledgeError) as error:
                    self.store.mutate(method, payload(reference_id='RULE-1') if method == 'PUT' else None,
                                      'RULE-1', version, 'guide.json')
                self.assertEqual(error.exception.status, status)
        self.assertFalse(self.container.uploads)

    def test_blob_etag_conflict_releases_lock_and_keeps_original(self):
        self.container.concurrent_change = True
        original = copy.deepcopy(self.container.docs)
        with self.assertRaises(KnowledgeError) as error:
            self.store.mutate('PUT', payload(reference_id='RULE-1'), 'RULE-1', '"v1"')
        self.assertEqual(error.exception.status, 412)
        self.assertEqual(self.container.docs, original)
        self.assertFalse(self.container.locked)

    def test_busy_lease_blocks_all_writes(self):
        self.container.locked = True
        with self.assertRaises(KnowledgeError) as error:
            self.store.mutate('POST', payload())
        self.assertEqual(error.exception.status, 409)
        self.assertFalse(self.container.uploads)

    def test_validation_and_invalid_source_references_do_not_write(self):
        cases = [[], None, payload(title=''), payload(text=' '), payload(category='invented'),
                 payload(reference_id='../bad'), payload(knowledge_file='missing.json'),
                 payload(knowledge_file='../guide.json'), payload(source_page=True),
                 payload(source_page='2'), payload(source_page=1.5), payload(source_page=-1),
                 payload(applies_to='body'), payload(keywords=[1]), payload(keywords=['']),
                 payload(source_section={}), payload(text='a' * 20001), payload(source_document={})]
        for case in cases:
            with self.subTest(case=str(case)[:80]), self.assertRaises(KnowledgeError):
                self.store.mutate('POST', case)
        self.assertFalse(self.container.uploads)

    def test_edit_cannot_move_source_or_change_id(self):
        for change in ({'knowledge_file': INTERNAL_FILE}, {'reference_id': 'NEW-ID'}):
            with self.assertRaises(KnowledgeError):
                self.store.mutate('PUT', payload(reference_id='RULE-1') | change, 'RULE-1', '"v1"')
        self.assertFalse(self.container.uploads)

    def test_deleted_or_ambiguous_record_is_not_changed(self):
        with self.assertRaises(KnowledgeError) as error:
            self.store.mutate('DELETE', reference_id='missing', etag='"v1"', knowledge_file='guide.json')
        self.assertEqual(error.exception.status, 404)
        self.container.docs['other.json'] = document()
        self.container.versions['other.json'] = 1
        with self.assertRaises(KnowledgeError) as error:
            self.store.mutate('DELETE', reference_id='RULE-1', etag='"v1"', knowledge_file='guide.json')
        self.assertEqual(error.exception.status, 409)

    def test_snapshot_retains_empty_sources_separately_and_returns_versions(self):
        self.container.docs['second.json'] = document()
        self.container.versions['second.json'] = 1
        self.container.docs['empty.json'] = {'source_document': {'title': 'Empty'}, 'guidance_records': []}
        self.container.versions['empty.json'] = 1
        records, sources = self.store.snapshot()
        self.assertEqual(len(sources), 4)  # Includes internal source placeholder.
        self.assertEqual(records[0]['_etag'], '"v1"')

    def test_invalid_stored_document_fails_closed(self):
        self.container.docs['guide.json']['guidance_records'] = None
        with self.assertRaises(KnowledgeError) as error:
            self.store.mutate('POST', payload())
        self.assertEqual(error.exception.status, 503)
        self.assertFalse(self.container.uploads)


class KnowledgeApiTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.private_key = rsa.generate_private_key(public_exponent=65537, key_size=2048)
        cls.other_key = rsa.generate_private_key(public_exponent=65537, key_size=2048)

    def setUp(self):
        self.environment = patch.dict('os.environ', CONFIG)
        self.environment.start()
        self.addCleanup(self.environment.stop)
        self.keys = patch.object(knowledge_auth, 'signing_keys', return_value=SimpleNamespace(
            get_signing_key_from_jwt=lambda token: SimpleNamespace(key=self.private_key.public_key())))
        self.keys.start()
        self.addCleanup(self.keys.stop)
        self.container = FakeContainer()
        self.storage = patch.object(function_app, 'KnowledgeStore', return_value=KnowledgeStore(self.container))
        self.storage_mock = self.storage.start()
        self.addCleanup(self.storage.stop)

    def token(self, changes=None, key=None):
        claims = {'exp': time.time() + 600, 'iat': time.time() - 10, 'nbf': time.time() - 10,
                  'iss': f'https://login.microsoftonline.com/{TENANT}/v2.0', 'aud': API,
                  'tid': TENANT, 'oid': 'editor-id', 'scp': 'Knowledge.Write', 'roles': ['Knowledge.Editor']}
        claims.update(changes or {})
        return jwt.encode(claims, key or self.private_key, algorithm='RS256')

    def request(self, method='POST', body=None, token=None, version='"v1"'):
        headers = {'If-Match': version} if version else {}
        if token is not None:
            headers['Authorization'] = 'Bearer ' + token
        request = func.HttpRequest(method=method, url='/api/knowledge/RULE-1',
                                   body=json.dumps(body if body is not None else payload()).encode(),
                                   headers=headers, params={'knowledge_file': 'guide.json'},
                                   route_params={'reference_id': 'RULE-1'})
        handler = function_app.create_knowledge if method == 'POST' else function_app.change_knowledge
        return handler(request)

    def test_authorized_create_edit_delete(self):
        token = self.token()
        self.assertEqual(self.request(token=token).status_code, 201)
        self.assertEqual(self.request('PUT', payload(reference_id='RULE-1'), token, '"v2"').status_code, 200)
        self.assertEqual(self.request('DELETE', token=token, version='"v3"').status_code, 200)
        self.assertEqual(len(self.container.docs['guide.json']['guidance_records']), 1)

    def test_anonymous_writes_all_rejected_before_storage(self):
        for method in ('POST', 'PUT', 'DELETE'):
            response = self.request(method)
            self.assertEqual(response.status_code, 401)
            self.assertIn('WWW-Authenticate', response.headers)
        self.storage_mock.assert_not_called()

    def test_invalid_tokens_wrong_issuer_audience_expiration_and_signature(self):
        tokens = ['bad-token', self.token({'exp': time.time() - 100}),
                  self.token({'aud': SPA}), self.token({'iss': 'https://evil.invalid'}),
                  self.token({'nbf': time.time() + 300}), self.token(key=self.other_key)]
        for token in tokens:
            with self.subTest(token=token[:10]):
                self.assertEqual(self.request(token=token).status_code, 401)
        self.storage_mock.assert_not_called()

    def test_signed_in_noneditors_and_app_tokens_rejected(self):
        for claims in ({'roles': []}, {'roles': 'Knowledge.Editor'}, {'scp': ''},
                       {'scp': ['Knowledge.Write']}, {'tid': SPA}):
            with self.subTest(claims=claims):
                self.assertEqual(self.request(token=self.token(claims)).status_code, 403)
        self.storage_mock.assert_not_called()

    def test_forged_identity_headers_do_not_authorize(self):
        req = func.HttpRequest(method='POST', url='/api/knowledge', body=b'{}', headers={
            'X-MS-CLIENT-PRINCIPAL': 'fake-admin', 'X-MS-CLIENT-PRINCIPAL-NAME': 'admin'})
        self.assertEqual(function_app.create_knowledge(req).status_code, 401)
        self.storage_mock.assert_not_called()

    def test_missing_configuration_fails_closed(self):
        with patch.dict('os.environ', {'POSTERIQ_KNOWLEDGE_TENANT_ID': ''}):
            self.assertEqual(self.request(token=self.token()).status_code, 503)
        self.storage_mock.assert_not_called()

    def test_http_validation_duplicate_and_stale_errors(self):
        token = self.token()
        self.assertEqual(self.request(body=payload(title=''), token=token).status_code, 400)
        self.assertEqual(self.request(body=payload(reference_id='RULE-1'), token=token).status_code, 409)
        self.assertEqual(self.request('PUT', payload(reference_id='RULE-1'), token, '"stale"').status_code, 412)
        self.assertEqual(self.request('DELETE', token=token, version=None).status_code, 428)
        req = func.HttpRequest(method='POST', url='/api/knowledge', body=b'not json',
                               headers={'Authorization': 'Bearer ' + token})
        self.assertEqual(function_app.create_knowledge(req).status_code, 400)
        req = func.HttpRequest(method='POST', url='/api/knowledge', body=b'x' * 65537,
                               headers={'Authorization': 'Bearer ' + token})
        self.assertEqual(function_app.create_knowledge(req).status_code, 413)

    def test_public_get_returns_versions_sources_and_preserves_read_behavior(self):
        req = func.HttpRequest(method='GET', url='/api/knowledge', body=b'')
        with patch.dict('os.environ', {'POSTERIQ_STORAGE_CONNECTION_STRING': 'configured'}):
            response = function_app.get_knowledge(req)
        data = json.loads(response.get_body())
        self.assertEqual(response.status_code, 200)
        self.assertEqual(data['records'][0]['text'], 'Original standard')
        self.assertEqual(data['records'][0]['etag'], '"v1"')
        self.assertEqual(len(data['sources']), 2)

    def test_explicit_public_mode_allows_create_edit_delete_without_sign_in(self):
        with patch.dict('os.environ', {'POSTERIQ_KNOWLEDGE_ALLOW_ANONYMOUS_WRITES': 'true',
                                     'POSTERIQ_KNOWLEDGE_TENANT_ID': ''}):
            self.assertEqual(self.request().status_code, 201)
            self.assertEqual(self.request('PUT', payload(reference_id='RULE-1'), version='"v2"').status_code, 200)
            self.assertEqual(self.request('DELETE', version='"v3"').status_code, 200)
            req = func.HttpRequest(method='GET', url='/api/knowledge/access', body=b'')
            self.assertEqual(json.loads(function_app.knowledge_access(req).get_body()), {'mode': 'public'})

    def test_public_mode_keeps_validation_and_concurrency_checks(self):
        with patch.dict('os.environ', {'POSTERIQ_KNOWLEDGE_ALLOW_ANONYMOUS_WRITES': 'true'}):
            self.assertEqual(self.request(body=payload(title='')).status_code, 400)
            self.assertEqual(self.request(body=payload(reference_id='RULE-1')).status_code, 409)
            self.assertEqual(self.request('DELETE', version='"stale"').status_code, 412)
            self.assertEqual(self.request('DELETE', version=None).status_code, 428)
        self.assertFalse(self.container.uploads)

    def test_only_explicit_true_enables_public_mode(self):
        for value in ('', 'false', '1', 'yes'):
            with patch.dict('os.environ', {'POSTERIQ_KNOWLEDGE_ALLOW_ANONYMOUS_WRITES': value}):
                self.assertEqual(self.request().status_code, 401)

    def test_public_auth_configuration_has_no_secrets(self):
        req = func.HttpRequest(method='GET', url='/api/knowledge/access', body=b'')
        data = json.loads(function_app.knowledge_access(req).get_body())
        self.assertEqual(set(data), {'tenant_id', 'api_client_id', 'client_id', 'scope'})


if __name__ == '__main__':
    unittest.main()
