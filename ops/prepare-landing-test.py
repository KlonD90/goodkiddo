import importlib.util
from pathlib import Path
from tempfile import TemporaryDirectory
import unittest

spec = importlib.util.spec_from_file_location("prepare_landing", Path(__file__).with_name("prepare-landing.py"))
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)


class LandingTests(unittest.TestCase):
    def test_persistent_owner_config_survives_every_release(self):
        with TemporaryDirectory() as folder:
            base = Path(folder).resolve()
            target = base / "shared/posthog/analytics-config.js"
            for release in ("first", "second"):
                landing = base / "releases" / release / "payload/landing"
                landing.mkdir(parents=True)
                (landing / "index.html").write_text("analytics-config.js analytics.js")
                (landing / "analytics.js").write_text("schema_version: 2")
                (landing / "analytics-config.js").write_text("release default")
                if release == "second":
                    target.write_text("synthetic-owner-public-config")
                    before = target.stat()
                module.prepare(base, landing)
                self.assertTrue((landing / "analytics-config.js").is_symlink())
                self.assertEqual((landing / "analytics-config.js").resolve(), target)
                if release == "second":
                    self.assertEqual(target.read_text(), "synthetic-owner-public-config")
                    self.assertEqual(target.stat().st_mtime_ns, before.st_mtime_ns)
                    self.assertEqual(target.stat().st_mode, before.st_mode)
                else:
                    self.assertIn("projectKey: ''", target.read_text())

    def test_refuse_unrelated_landing_or_old_analytics(self):
        with TemporaryDirectory() as folder:
            base = Path(folder).resolve()
            with self.assertRaises(ValueError):
                module.prepare(base, base / "unrelated")
            landing = base / "releases/old/payload/landing"
            landing.mkdir(parents=True)
            (landing / "index.html").write_text("analytics-config.js analytics.js")
            (landing / "analytics.js").write_text("old schema")
            with self.assertRaises(ValueError):
                module.prepare(base, landing)
            self.assertFalse((base / "shared").exists())


if __name__ == "__main__":
    unittest.main()
