"""Local-only fixture contract checks; no production services or credentials."""

import json
import runpy
import threading
import unittest
from datetime import datetime, timezone
from pathlib import Path
from urllib.error import HTTPError
from urllib.parse import quote
from urllib.request import Request, urlopen


FIXTURES = runpy.run_path(str(Path(__file__).resolve().parents[1] / "serve-simulator-poc-vault"))


class QuietHandler(FIXTURES["Handler"]):
    def log_message(self, *_args):
        pass


class SimulatorReviewFixtureTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        # Use a fresh ephemeral loopback port, leaving the screenshot server alone.
        cls.server = FIXTURES["SimulatorVaultServer"](("127.0.0.1", 0), QuietHandler)
        cls.worker = threading.Thread(target=cls.server.serve_forever, daemon=True)
        cls.worker.start()
        cls.base_url = f"http://127.0.0.1:{cls.server.server_port}"

    @classmethod
    def tearDownClass(cls):
        cls.server.shutdown()
        cls.server.server_close()
        cls.worker.join(timeout=2)

    def setUp(self):
        with self.server.fixture_lock:
            self.server.handoff_job_id = None
            self.server.approval_pending = True
            self.server.approval_resolution = None

    def request(self, path, *, method="GET", body=None, headers=None):
        data = json.dumps(body).encode() if body is not None else None
        request_headers = {"Content-Type": "application/json", **(headers or {})}
        request = Request(self.base_url + path, data=data, method=method, headers=request_headers)
        try:
            response = urlopen(request, timeout=3)
        except HTTPError as error:
            response = error
        with response:
            return response.status, response.headers, response.read()

    def get_json(self, path):
        status, _, payload = self.request(path)
        self.assertEqual(status, 200, path)
        return json.loads(payload)

    def test_artifact_and_workspace_file_have_the_same_sample_bytes(self):
        job = self.get_json("/v1/codex/jobs/sim-job-linear")
        self.assertEqual([artifact["id"] for artifact in job["artifacts"]], ["artifact-002"])
        artifact = job["artifacts"][0]
        self.assertEqual(artifact["filename"], "launch-checklist.html")
        status, headers, preview = self.request(artifact["previewURL"])
        self.assertEqual(status, 200)
        self.assertTrue(headers["Content-Type"].startswith("text/html"))
        self.assertEqual(len(preview), artifact["bytes"])
        self.assertIn(b"Interactive sample output", preview)
        self.assertEqual(self.request(artifact["rawURL"])[2], preview)
        file_path = quote("/srv/codex-workspaces/poc-vault/launch-checklist.html", safe="")
        status, headers, file_bytes = self.request("/v1/codex/fs/file?path=" + file_path)
        self.assertEqual(status, 200)
        self.assertTrue(headers["Content-Disposition"].startswith("attachment"))
        self.assertEqual(file_bytes, preview)

    def test_legacy_image_endpoint_is_preserved_but_not_listed_as_checklist_output(self):
        status, headers, image = self.request("/v1/codex/jobs/sim-job-linear/artifacts/artifact-001/raw")
        self.assertEqual(status, 200)
        self.assertEqual(headers["Content-Type"], "image/png")
        self.assertTrue(image.startswith(b"\x89PNG\r\n\x1a\n"))

    def test_workspace_listing_and_readme_explain_the_sample(self):
        listing = self.get_json("/v1/codex/fs/list?path=poc-vault")
        names = {entry["name"] for entry in listing["entries"]}
        self.assertTrue({"launch-checklist.html", "readme.md", "assets", "logs", ".env"} <= names)
        self.assertIn(b"Representative local sample project", self.request("/v1/codex/fs/file?path=poc-vault/readme.md")[2])
        self.assertEqual(self.request("/v1/codex/fs/file?path=poc-vault/.env")[0], 403)
        status, headers, content = self.request("/v1/codex/fs/file?path=poc-vault/logs/build.log", headers={"Range": "bytes=10-19"})
        self.assertEqual(status, 206)
        self.assertEqual(len(content), 10)
        self.assertTrue(headers["Content-Range"].startswith("bytes 10-19/"))

    def test_handoff_continues_with_consistent_provider_job_and_thread(self):
        handoff = self.get_json("/v1/handoffs")["handoffs"][0]
        status, _, payload = self.request(f"/v1/handoffs/{handoff['id']}/continue", method="POST")
        self.assertEqual(status, 202)
        created = json.loads(payload)
        job = self.get_json("/v1/codex/jobs/" + created["id"])
        self.assertEqual(job, created["job"])
        self.assertEqual(job["provider"], handoff["provider"])
        self.assertEqual(job["workspaceId"], handoff["workspaceId"])
        self.assertEqual(self.get_json("/v1/handoffs")["handoffs"][0]["lastJobId"], job["id"])
        thread = self.get_json("/v1/codex/threads/" + job["sessionId"])
        self.assertEqual(thread["thread"]["provider"], "claude")
        self.assertEqual(thread["jobs"][0]["id"], job["id"])
        self.assertIn(job["id"], {item["id"] for item in self.get_json("/v1/codex/jobs")["jobs"]})

    def test_preview_lease_has_future_expiry_and_returns_the_same_sample(self):
        for source in ["http://localhost:4317/lab", "http://127.0.0.1:4317/lab"]:
            status, _, payload = self.request("/v1/codex/previews", method="POST", body={"jobId": "sim-job-linear", "url": source})
            self.assertEqual(status, 201)
            lease = json.loads(payload)
            expires_at = datetime.fromisoformat(lease["expiresAt"].replace("Z", "+00:00"))
            seconds_remaining = (expires_at - datetime.now(timezone.utc)).total_seconds()
            self.assertGreater(seconds_remaining, 1700)
            self.assertLessEqual(seconds_remaining, 1800)
            self.assertEqual(self.request(lease["url"])[2], FIXTURES["_SIM_LIVE_PREVIEW"])

    def test_preview_rejects_unknown_jobs_and_non_fixture_addresses(self):
        status, _, _ = self.request("/v1/codex/previews", method="POST", body={"jobId": "missing", "url": "http://localhost:4317/lab"})
        self.assertEqual(status, 404)
        invalid = [
            "https://example.com/", "http://localhost:4317.evil.test/lab",
            "http://localhost:43170/lab", "http://user@localhost:4317/lab",
            "http://localhost:4317/unreported", "http://localhost:4317/lab?token=example",
            "http://localhost:4317/lab#fragment", "https://localhost:4317/lab",
            "\nhttp://localhost:4317/lab", "http://[invalid", None,
        ]
        for source in invalid:
            with self.subTest(source=source):
                status, _, _ = self.request("/v1/codex/previews", method="POST", body={"jobId": "sim-job-linear", "url": source})
                self.assertEqual(status, 400)


if __name__ == "__main__":
    unittest.main()
