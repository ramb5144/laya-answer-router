import unittest

from laya_worker import route_with, sanitize_context


class FakeAgent:
    def predict(self, state, questions):
        self.state = state
        self.questions = questions
        return {
            "answers": {
                "route": {
                    "choice": "fast",
                    "confidence": 0.6,
                    "probabilities": {"fast": 0.51, "deep": 0.49},
                },
                "context_scope": {
                    "choice": "nearby",
                    "confidence": 0.8,
                },
            }
        }


class WorkerTests(unittest.TestCase):
    def test_sanitize_bounds_context(self):
        value = sanitize_context({"question": "q" * 9_000, "nearbyText": "n" * 9_000})
        self.assertEqual(len(value["question"]), 8_000)
        self.assertEqual(len(value["nearby_text"]), 8_000)

    def test_full_bound_tab_context_is_preferred_for_routing(self):
        value = sanitize_context({"question": "q", "pageText": "selected frame", "fullPageContext": "all frames"})
        self.assertEqual(value["page_text"], "all frames")

    def test_near_tie_prefers_deep_lane(self):
        result = route_with(FakeAgent(), {"question": "What is this?"})
        self.assertEqual(result["choice"], "fast")
        self.assertEqual(result["lane"], "deep")
        self.assertEqual(result["contextChoice"], "nearby")


if __name__ == "__main__":
    unittest.main()
