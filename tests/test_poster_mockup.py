import copy
import json
import unittest
from unittest.mock import patch
from types import SimpleNamespace

import azure.functions as func
import pymupdf

import function_app
from poster_mockup import prepare_mockup, _numeric_tokens


def fixture():
    document = pymupdf.open()
    page = document.new_page(width=600, height=400)
    original = "We enrolled 120 participants. The response rate was 80%."
    page.insert_textbox(pymupdf.Rect(60, 80, 290, 180), original, fontsize=14)
    # Original figures must remain untouched by the browser preview.
    page.draw_rect(pymupdf.Rect(350, 80, 550, 250), color=(0, 0.3, 0.5), fill=(0, 0.3, 0.5))
    pdf = document.tobytes()
    document.close()
    structure = {
        "pages": [{"page_number": 1, "width": 600, "height": 400, "unit": "pixel"}],
        "content_blocks": [{"block_id": 3, "content": original, "role": None,
                            "location": {"page_number": 1, "polygon": [60, 80, 290, 80, 290, 180, 60, 180]}}],
        "tables": [],
    }
    finding = {
        "kind": "issue", "confidence": "high", "category": "readability", "priority": "medium",
        "finding": "The enrollment sentence can be more concise.",
        "impact": "A shorter sentence makes the study size easier to find.",
        "recommendation": "State enrollment concisely.",
        "evidence": {"description": original, "block_ids": [3], "evidence_type": "text", "section": "Results", "page_number": 1},
        "guidance": {"type": "general_suggestion", "source": None, "section": None, "reference_id": None},
    }
    review = {
        "schema_version": "1.1", "poster_id": "test",
        "summary": {"overview": "A legible poster.", "strengths": [], "top_priorities": [], "assessment_limitations": []},
        "findings": [finding],
        "mockup_changes": [{"finding_index": 0, "block_id": 3,
                            "suggested_text": "Enrollment: 120 participants. Response rate: 80%.",
                            "font_scale": 1.1, "improve_contrast": False, "reason": "Keep the data and reduce wording."}],
    }
    return pdf, structure, review


class MockupTests(unittest.TestCase):
    def test_source_geometry_style_and_content(self):
        pdf, structure, review = fixture()
        result = prepare_mockup(review, structure, pdf)
        change = result["mockup"]["changes"][0]
        self.assertEqual(change["region"]["left"], 0.1)
        self.assertEqual(change["region"]["top"], 0.2)
        self.assertEqual(change["style"]["background"], "#ffffff")
        self.assertEqual(change["original_text"], structure["content_blocks"][0]["content"])
        self.assertEqual(result["mockup"]["omitted_count"], 0)

    def test_readability_rewrite_wins_over_contrast_for_same_block(self):
        pdf, structure, review = fixture()
        contrast_finding = copy.deepcopy(review["findings"][0])
        contrast_finding["category"] = "accessibility"
        review["findings"].insert(0, contrast_finding)
        rewrite = review["mockup_changes"][0]
        rewrite["finding_index"] = 1
        contrast = {**rewrite, "finding_index": 0,
                    "suggested_text": structure["content_blocks"][0]["content"],
                    "font_scale": 1, "improve_contrast": True}
        review["mockup_changes"].insert(0, contrast)
        result = prepare_mockup(review, structure, pdf)
        self.assertEqual(len(result["mockup"]["changes"]), 1)
        self.assertEqual(result["mockup"]["changes"][0]["finding_index"], 1)
        self.assertEqual(result["mockup"]["changes"][0]["suggested_text"], rewrite["suggested_text"])
        self.assertEqual(result["mockup"]["omitted_count"], 1)

    def test_uncertain_findings_removed_and_indices_remapped(self):
        pdf, structure, review = fixture()
        uncertain = copy.deepcopy(review["findings"][0])
        uncertain["confidence"] = "low"
        review["findings"].insert(0, uncertain)
        review["mockup_changes"][0]["finding_index"] = 1
        result = prepare_mockup(review, structure, pdf)
        self.assertEqual(len(result["findings"]), 1)
        self.assertEqual(result["mockup"]["changes"][0]["finding_index"], 0)
        self.assertEqual(result["summary"]["top_priorities"], ["State enrollment concisely."])

    def test_invalid_edits_are_omitted(self):
        modifications = [
            {"block_id": 999}, {"finding_index": 99}, {"font_scale": 0.5},
            {"suggested_text": "Enrollment: 121 participants. Response rate: 80%."},
            {"suggested_text": "Response rate: 80%."}, {"suggested_text": ""},
        ]
        for modification in modifications:
            with self.subTest(modification=modification):
                pdf, structure, review = fixture()
                review["mockup_changes"][0].update(modification)
                result = prepare_mockup(review, structure, pdf)
                self.assertEqual(result["mockup"]["changes"], [])
                self.assertEqual(len(result["findings"]), 1)

    def test_unlinked_block_cannot_be_replaced(self):
        pdf, structure, review = fixture()
        review["findings"][0]["evidence"]["block_ids"] = []
        self.assertEqual(prepare_mockup(review, structure, pdf)["mockup"]["changes"], [])

    def test_overlapping_text_or_table_regions_are_not_painted(self):
        for mode in ("text", "table"):
            with self.subTest(mode=mode):
                pdf, structure, review = fixture()
                location = {"page_number": 1, "polygon": [65, 85, 200, 85, 200, 120, 65, 120]}
                if mode == "text":
                    structure["content_blocks"].append({"block_id": 4, "content": "Other text", "location": location})
                else:
                    structure["tables"].append({"bounding_regions": [location]})
                self.assertEqual(prepare_mockup(review, structure, pdf)["mockup"]["changes"], [])

    def test_other_pages_and_headers_are_preserved(self):
        for mode in ("page", "header"):
            pdf, structure, review = fixture()
            if mode == "page":
                structure["content_blocks"][0]["location"]["page_number"] = 2
            else:
                structure["content_blocks"][0]["role"] = "title"
            self.assertEqual(prepare_mockup(review, structure, pdf)["mockup"]["changes"], [])

    def test_vector_figure_and_raster_figure_are_preserved(self):
        for mode in ("vector", "raster"):
            with self.subTest(mode=mode):
                pdf, structure, review = fixture()
                with pymupdf.open(stream=pdf, filetype="pdf") as document:
                    box = pymupdf.Rect(80, 125, 110, 145)
                    if mode == "vector":
                        document[0].draw_rect(box, color=(0, 0, 1))
                    else:
                        source = pymupdf.open()
                        source.new_page(width=20, height=20)
                        png = source[0].get_pixmap().tobytes("png")
                        document[0].insert_image(box, stream=png)
                        source.close()
                    pdf = document.tobytes()
                self.assertEqual(prepare_mockup(review, structure, pdf)["mockup"]["changes"], [])

    def test_noop_changes_are_not_presented_as_improvements(self):
        pdf, structure, review = fixture()
        review["mockup_changes"][0].update({"suggested_text": structure["content_blocks"][0]["content"], "font_scale": 1})
        self.assertEqual(prepare_mockup(review, structure, pdf)["mockup"]["changes"], [])

    def test_numeric_signs_and_percentages_are_preserved(self):
        for original, suggested in (("Effect: -1.2", "Effect: 1.2"), ("Rate: 80%", "Rate: 80"),
                                    ("Effect: \u22121.2", "Effect: 1.2"),
                                    ("Effect: \uff0d1.2", "Effect: 1.2"),
                                    ("Effect: 1e\u22123", "Effect: 1e3")):
            pdf, structure, review = fixture()
            structure["content_blocks"][0]["content"] = original
            review["mockup_changes"][0]["suggested_text"] = suggested
            self.assertEqual(prepare_mockup(review, structure, pdf)["mockup"]["changes"], [])

    def test_equivalent_unicode_signs_keep_their_numeric_meaning(self):
        self.assertEqual(_numeric_tokens("Effect: \u22121.2; scale: 1e\u22123"),
                         _numeric_tokens("Effect: -1.2; scale: 1e-3"))
        self.assertNotEqual(_numeric_tokens("Effect: \u22121.2"), _numeric_tokens("Effect: +1.2"))

    def test_high_priorities_are_not_dropped_by_medium_findings(self):
        pdf, structure, review = fixture()
        template = review["findings"][0]
        review["findings"] = [dict(template, recommendation=f"Medium {i}") for i in range(6)]
        review["findings"].extend([
            dict(template, priority="high", recommendation="High A"),
            dict(template, priority="high", recommendation="High B"),
            dict(template, priority="high", confidence="low", recommendation="Uncertain"),
            dict(template, priority="high", kind="optional_refinement", recommendation="Optional"),
        ])
        review["mockup_changes"] = []
        result = prepare_mockup(review, structure, pdf)
        self.assertEqual(result["summary"]["top_priorities"],
                         ["High A", "High B", "Medium 0", "Medium 1", "Medium 2"])

    def test_empty_review_is_valid(self):
        pdf, structure, review = fixture()
        review["findings"] = []
        review["mockup_changes"] = []
        result = prepare_mockup(review, structure, pdf)
        self.assertEqual(result["findings"], [])
        self.assertEqual(result["summary"]["top_priorities"], [])
        self.assertEqual(result["mockup"]["changes"], [])

    def test_optional_refinements_do_not_become_priorities(self):
        pdf, structure, review = fixture()
        review["findings"][0]["kind"] = "optional_refinement"
        self.assertEqual(prepare_mockup(review, structure, pdf)["summary"]["top_priorities"], [])

    def test_unsafe_region_retains_readability_text_draft(self):
        pdf, structure, review = fixture()
        structure["tables"] = [{"bounding_regions": [structure["content_blocks"][0]["location"]]}]
        review["mockup_changes"][0].update(section_name="Abstract", section_purpose="Scope and purpose")
        result = prepare_mockup(review, structure, pdf)
        self.assertEqual(result["mockup"]["changes"], [])
        self.assertEqual(result["mockup"]["manual_drafts"][0]["section_name"], "Abstract")
        self.assertIn("120", result["mockup"]["manual_drafts"][0]["suggested_text"])

    def test_unfaithful_numeric_rewrite_is_not_retained_as_manual_draft(self):
        pdf, structure, review = fixture()
        review["mockup_changes"][0]["suggested_text"] = "Enrollment: 121 participants. Response rate: 80%."
        result = prepare_mockup(review, structure, pdf)
        self.assertEqual(result["mockup"]["manual_drafts"], [])

    def test_editorial_pass_produces_multiple_section_replacements(self):
        _, structure, review = fixture()
        abstract = "This poster describes how primary care can support inclusive clinical trials."
        background = "Fragmented stakeholder workflows can delay identification of eligible participants."
        structure["content_blocks"] = [
            {"block_id": 3, "content": abstract}, {"block_id": 5, "content": background}]
        structure["full_text"] = abstract + "\n" + background
        review["findings"][0]["evidence"]["block_ids"] = [3, 5]
        drafts = [
            {"finding_index": 0, "block_id": 3, "suggested_text": "• Describe primary care's role in inclusive clinical trials.",
             "font_scale": 1, "improve_contrast": False, "reason": "Focus on purpose.",
             "section_name": "Abstract", "section_purpose": "Scope and purpose"},
            {"finding_index": 0, "block_id": 5, "suggested_text": "• Fragmented workflows can delay participant identification.",
             "font_scale": 1, "improve_contrast": False, "reason": "State the problem.",
             "section_name": "Background", "section_purpose": "Problem"}]
        captured = {}
        def complete(**kwargs):
            captured.update(kwargs)
            return SimpleNamespace(choices=[SimpleNamespace(finish_reason="stop",
                message=SimpleNamespace(content=json.dumps({"mockup_changes": drafts})))])
        client = SimpleNamespace(chat=SimpleNamespace(completions=SimpleNamespace(create=complete)))
        with patch.object(function_app, "get_openai_client", return_value=client), patch.dict(
                "os.environ", {"POSTERIQ_OPENAI_DEPLOYMENT": "test"}):
            result = function_app.generate_section_rewrites(review, structure)
        self.assertEqual(result["mockup_changes"], drafts)
        context = json.loads(captured["messages"][1]["content"])
        self.assertEqual(len(context["poster"]["content_blocks"]), 2)
        self.assertEqual(context["rewrite_targets"][0]["evidence"]["block_ids"], [3, 5])

    def test_editorial_failure_preserves_completed_review(self):
        _, structure, review = fixture()
        with patch.object(function_app, "get_openai_client", side_effect=RuntimeError("Unavailable")):
            result = function_app.generate_section_rewrites(review, structure)
        self.assertEqual(len(result["findings"]), 1)
        self.assertTrue(result["summary"]["assessment_limitations"])

    def test_editorial_pass_skips_reviews_without_readability_findings(self):
        _, structure, review = fixture()
        review["findings"][0]["category"] = "accessibility"
        with patch.object(function_app, "get_openai_client") as client:
            function_app.generate_section_rewrites(review, structure)
        client.assert_not_called()

    def test_health_still_works(self):
        response = function_app.health(func.HttpRequest(method="GET", url="/api/health", body=b""))
        self.assertEqual(response.status_code, 200)

    def test_truncated_model_response_is_rejected(self):
        client = SimpleNamespace(chat=SimpleNamespace(completions=SimpleNamespace(
            create=lambda **kwargs: SimpleNamespace(choices=[SimpleNamespace(
                finish_reason="length", message=SimpleNamespace(content='{"findings":')
            )])
        )))
        with patch.object(function_app, "get_openai_client", return_value=client), patch.dict(
            "os.environ", {"POSTERIQ_OPENAI_DEPLOYMENT": "test"}
        ):
            with self.assertRaisesRegex(RuntimeError, "response limit"):
                function_app.generate_poster_review("id", {}, b"png", [])

    def test_review_endpoint_integrates_model_and_authoritative_regions(self):
        pdf, structure, model_review = fixture()
        model_review["poster_id"] = "12345678-1234-4234-8234-123456789abc"
        captured = {}

        def complete(**kwargs):
            if kwargs["response_format"]["json_schema"]["name"] == "posteriq_section_rewrites":
                payload = {"mockup_changes": [dict(model_review["mockup_changes"][0],
                    section_name="Results", section_purpose="Report enrollment and response.")]}
            else:
                captured.update(kwargs)
                payload = model_review
            return SimpleNamespace(choices=[SimpleNamespace(
                finish_reason="stop", message=SimpleNamespace(content=json.dumps(payload))
            )])

        image = function_app.render_poster_image(pdf)["bytes"]
        storage = SimpleNamespace(get_blob_client=lambda **kw: SimpleNamespace(
            exists=lambda: True,
            download_blob=lambda: SimpleNamespace(readall=lambda: pdf if kw["blob"].endswith(".pdf") else image)
        ))
        location = structure["content_blocks"][0]["location"]
        result = SimpleNamespace(
            pages=[SimpleNamespace(**structure["pages"][0])], tables=[],
            paragraphs=[SimpleNamespace(content="")] * 3 + [SimpleNamespace(
                content=structure["content_blocks"][0]["content"], role=None,
                bounding_regions=[SimpleNamespace(**location)]
            )], content=structure["content_blocks"][0]["content"]
        )
        document_client = SimpleNamespace(begin_analyze_document=lambda *a, **kw: SimpleNamespace(result=lambda: result))
        model_client = SimpleNamespace(chat=SimpleNamespace(completions=SimpleNamespace(create=complete)))
        request = func.HttpRequest(method="POST", url="/api/posters/id/review", body=b"",
                                   route_params={"poster_id": model_review["poster_id"]})
        with patch.object(function_app, "get_blob_service_client", return_value=storage), \
             patch.object(function_app, "get_document_intelligence_client", return_value=document_client), \
             patch.object(function_app, "get_openai_client", return_value=model_client), \
             patch.object(function_app, "get_review_guidance", return_value=[]), \
             patch.dict("os.environ", {"POSTERIQ_OPENAI_DEPLOYMENT": "test"}):
            response = function_app.review_poster(request)
        self.assertEqual(response.status_code, 200)
        review = json.loads(response.get_body())
        self.assertEqual(len(review["mockup"]["changes"]), 1)
        self.assertEqual(review["mockup"]["changes"][0]["region"]["left"], 0.1)
        self.assertEqual(review["findings"][0]["evidence"]["locations"][0]["block_id"], 3)
        self.assertEqual(captured["messages"][1]["content"][1]["image_url"]["detail"], "high")
        self.assertEqual(captured["response_format"]["json_schema"]["schema"]["properties"]["schema_version"]["const"], "1.1")


if __name__ == "__main__":
    unittest.main()
