"""python3 -m unittest tools/enrich/test_firestore_enrich.py"""
import importlib.util
import pathlib
import unittest

spec = importlib.util.spec_from_file_location("fe", pathlib.Path(__file__).with_name("firestore_enrich.py"))
fe = importlib.util.module_from_spec(spec)
spec.loader.exec_module(fe)

NOW = "2026-10-29T20:00:00Z"


class DetailUpdate(unittest.TestCase):
    def test_sets_only_known_values_and_keeps_other_flags(self):
        current = {"flags": ["over_budget", "commute_approx"], "photos": ["a"], "prediction": {"score": 2}}
        data = {"baths": 2, "sizeSqm": 120, "furnished": "either", "availableFrom": "2026-12-14", "letType": None,
                "deposit": 5192, "agent": "Winkworth - Parsons Green", "photos": ["p1", "p2"], "floorplans": [],
                "keyFeatures": [], "description": "Text", "letAgreed": True}
        u = fe.detail_update(current, data, NOW)
        self.assertEqual(u["baths"], 2)
        self.assertNotIn("letType", u)
        self.assertNotIn("floorplans", u)
        self.assertEqual(u["photos"], ["p1", "p2"])
        self.assertEqual(u["flags"], ["over_budget", "commute_approx", "let_agreed"])
        self.assertEqual(u["predictionError"], fe.RESCORE)
        self.assertEqual(u["detailsFetchedAt"], NOW)

    def test_periodic_let_and_fewer_photos(self):
        current = {"flags": ["periodic_risk", "too_far"], "photos": ["a", "b", "c"], "letType": "unknown"}
        u = fe.detail_update(current, {"letType": "periodic", "photos": ["x"], "letAgreed": False}, NOW)
        self.assertNotIn("photos", u)
        self.assertEqual(u["flags"], ["too_far", "periodic_risk"])
        self.assertIs(u["letAgreed"], False)
        self.assertNotIn("predictionError", u)  # nothing to rescore without a prediction

    def test_value_encoding(self):
        self.assertEqual(fe.to_value([1, "a", None]), {"arrayValue": {"values": [{"integerValue": "1"}, {"stringValue": "a"}, {"nullValue": None}]}})
        self.assertEqual(fe.from_value({"arrayValue": {"values": [{"integerValue": "3"}]}}), [3])


if __name__ == "__main__":
    unittest.main()
