"""실행: cd backend && python -m unittest tests.test_netem -v"""
import http.server
import asyncio
import socketserver
import subprocess
import threading
import time
import unittest
import httpx

from fastapi import FastAPI
from fastapi.testclient import TestClient

from netem import Conditions, TcController, effective_vod_rate_kbps, vod_router
from netem.shaping import tc_apply_commands
from netem.vod_proxy import shaper

PAYLOAD = b"x" * 100_000


class Handler(http.server.BaseHTTPRequestHandler):
    def do_GET(self):
        body = b"#EXTM3U\n" if self.path.endswith(".m3u8") else PAYLOAD
        self.send_response(200)
        self.send_header("Content-Type", "application/octet-stream")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, *a):
        pass


class ShapingTests(unittest.TestCase):
    def test_clear_distinguishes_missing_rules_from_failure(self):
        def runner_for(message):
            def runner(argv):
                if argv[1] == "inspect":
                    return subprocess.CompletedProcess(argv, 0, "true\n", "")
                return subprocess.CompletedProcess(argv, 2, "", message)
            return runner

        self.assertTrue(TcController("c1", runner_for("Error: Cannot delete qdisc with handle of zero.")).clear().ok)
        failed = TcController("c1", runner_for("RTNETLINK answers: Operation not permitted")).clear()
        self.assertFalse(failed.ok)
        self.assertIn("Operation not permitted", failed.detail)

    def test_validation(self):
        with self.assertRaises(ValueError):
            Conditions(0, 0, 0)
        with self.assertRaises(ValueError):
            Conditions(1000, -1, 0)
        with self.assertRaises(ValueError):
            Conditions(1000, 0, 101)

    def test_mathis_caps_throughput_as_loss_grows(self):
        base = effective_vod_rate_kbps(Conditions(50_000, 0, 0))
        low = effective_vod_rate_kbps(Conditions(50_000, 0, 1))
        high = effective_vod_rate_kbps(Conditions(50_000, 0, 5))
        self.assertEqual(base, 50_000)
        self.assertLess(high, low)
        self.assertLess(low, base)

    def test_tc_commands_target_only_webrtc_udp(self):
        cmds = tc_apply_commands(Conditions(1500, 30, 2.5), "eth0", 8189)
        flat = [" ".join(c) for c in cmds]
        self.assertIn("netem delay 30ms loss 2.5% rate 1500kbit", flat[1])
        self.assertIn("match ip protocol 17 0xff", flat[2])
        self.assertIn("match ip sport 8189 0xffff", flat[2])

    def test_controller_with_fake_runner(self):
        calls = []

        def runner(argv):
            calls.append(argv)
            out = "true\n" if argv[1] == "inspect" else ""
            return subprocess.CompletedProcess(argv, 0, out, "")

        res = TcController("c1", runner).apply(Conditions(1500, 30, 2))
        self.assertTrue(res.ok)
        self.assertEqual(calls[0][:3], ["docker", "inspect", "-f"])
        self.assertTrue(all(c[:3] == ["docker", "exec", "c1"] for c in calls[1:]))
        self.assertEqual(len(calls) - 1, 4)  # del + qdisc add x2 + filter add

    def test_controller_reports_tc_failure_and_cleans_up(self):
        def runner(argv):
            if argv[1] == "inspect":
                return subprocess.CompletedProcess(argv, 0, "true\n", "")
            if "netem" in argv:
                return subprocess.CompletedProcess(argv, 2, "", "Specified qdisc not found")
            return subprocess.CompletedProcess(argv, 0, "", "")

        res = TcController("c1", runner).apply(Conditions(1500, 30, 2))
        self.assertFalse(res.ok)
        self.assertIn("qdisc not found", res.detail)

    def test_controller_container_not_running(self):
        def runner(argv):
            return subprocess.CompletedProcess(argv, 1, "", "No such object")

        res = TcController("c1", runner).apply(Conditions(1500, 30, 2))
        self.assertFalse(res.ok)
        self.assertIn("docker compose up", res.detail)


class ProxyTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        socketserver.TCPServer.allow_reuse_address = True
        cls.srv = socketserver.ThreadingTCPServer(("127.0.0.1", 0), Handler)
        cls.port = cls.srv.server_address[1]
        threading.Thread(target=cls.srv.serve_forever, daemon=True).start()
        app = FastAPI()
        app.include_router(vod_router)
        cls.client = TestClient(app)

    @classmethod
    def tearDownClass(cls):
        cls.srv.shutdown()
        cls.srv.server_close()

    def url(self, name="master.m3u8"):
        return f"http://127.0.0.1:{self.port}/vod/team/{name}"

    def test_rejects_when_not_configured(self):
        shaper.reset()
        self.assertEqual(self.client.get("/api/vod-proxy/seg.ts").status_code, 409)

    def test_bandwidth_limit_slows_download(self):
        path = shaper.configure(Conditions(800, 0, 0), self.url())  # 800kbps = 100KB/s
        self.assertEqual(path, "/api/vod-proxy/master.m3u8")
        t = time.monotonic()
        r = self.client.get("/api/vod-proxy/segment-000.ts")
        took = time.monotonic() - t
        self.assertEqual(r.status_code, 200)
        self.assertEqual(r.headers["Timing-Allow-Origin"], "*")
        self.assertEqual(r.content, PAYLOAD)
        self.assertGreater(took, 0.8)  # 100KB / (100KB/s) ~ 1s

    def test_delay_applies(self):
        shaper.configure(Conditions(100_000, 400, 0), self.url())
        t = time.monotonic()
        self.client.get("/api/vod-proxy/master.m3u8")
        self.assertGreater(time.monotonic() - t, 0.38)

    def test_full_loss_rejects(self):
        shaper.configure(Conditions(100_000, 0, 100), self.url())
        self.assertEqual(self.client.get("/api/vod-proxy/segment-000.ts").status_code, 503)
        self.assertEqual(shaper.stats()["rejected"], 1)

    def test_path_traversal_blocked(self):
        shaper.configure(Conditions(100_000, 0, 0), self.url())
        self.assertEqual(self.client.get("/api/vod-proxy/a/%2e%2e/b").status_code, 400)

    def test_bad_url(self):
        with self.assertRaises(ValueError):
            shaper.configure(Conditions(1000, 0, 0), "ftp://x/y.m3u8")
        with self.assertRaises(ValueError):
            shaper.configure(Conditions(1000, 0, 0), "http://x/dir/")


class ProxySessionBoundaryTests(unittest.IsolatedAsyncioTestCase):
    async def test_clear_after_request_starts_does_not_read_reset_origin(self):
        app = FastAPI()
        app.include_router(vod_router)
        shaper.configure(Conditions(1000, 300, 0), "http://localhost/test/master.m3u8")
        async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://test") as client:
            pending = asyncio.create_task(client.get("/api/vod-proxy/segment.ts"))

            async def request_started():
                while not shaper.stats()["requests"]:
                    await asyncio.sleep(0)

            await asyncio.wait_for(request_started(), timeout=1)
            shaper.reset()
            response = await pending
            self.assertEqual(response.status_code, 409)
            self.assertEqual(shaper.stats(), {"requests": 0, "bytesSent": 0, "rejected": 0})


if __name__ == "__main__":
    unittest.main()
