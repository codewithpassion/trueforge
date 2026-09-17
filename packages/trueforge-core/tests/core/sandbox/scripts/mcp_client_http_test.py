"""Code Mode HTTP bridge tests for src/core/sandbox/scripts/mcp_client.py.

Run inside the sandbox container image, which is where the client's `mcp` and `pydantic`
dependencies live: `pnpm --filter @truefoundry/trueforge test:sandbox-image`.

The client resolves its bridge from the environment at import, so each case imports a fresh copy from a
temporary directory — which also keeps the tools cache it writes out of the source tree.
"""

from __future__ import annotations

import asyncio
import base64
import importlib.util
import json
import os
import shutil
import sys
import tempfile
import threading
import unittest
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from types import ModuleType
from typing import Callable

CLIENT_SOURCE = Path(__file__).resolve().parents[4] / "src" / "core" / "sandbox" / "scripts" / "mcp_client.py"

PING_TOOL = {
    "name": "ping",
    "description": "ping",
    "inputSchema": {"type": "object", "properties": {}},
    "annotations": {"readOnlyHint": True},
}


class RecordingBridge:
    """Stands in for the host: records what arrived and replies with a scripted queue."""

    def __init__(self, replies: list[tuple[int, str]]) -> None:
        self.requests: list[dict[str, object]] = []
        self._replies = list(replies)
        recorder = self

        class Handler(BaseHTTPRequestHandler):
            def do_POST(self) -> None:  # noqa: N802 - BaseHTTPRequestHandler's naming
                length = int(self.headers.get("content-length", "0"))
                recorder.requests.append(
                    {
                        "path": self.path,
                        "body": json.loads(self.rfile.read(length).decode()),
                        "authorization": self.headers.get("authorization"),
                        "content_type": self.headers.get("content-type"),
                        "traceparent": self.headers.get("traceparent"),
                    }
                )
                status, body = recorder._replies.pop(0) if recorder._replies else (500, "no scripted reply")
                encoded = body.encode()
                self.send_response(status)
                self.send_header("content-type", "application/json")
                self.send_header("content-length", str(len(encoded)))
                self.end_headers()
                self.wfile.write(encoded)

            def log_message(self, *_args: object) -> None:
                pass

        self._server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        self._thread = threading.Thread(target=self._server.serve_forever, daemon=True)

    def __enter__(self) -> RecordingBridge:
        self._thread.start()
        return self

    def __exit__(self, *_exc: object) -> None:
        self._server.shutdown()
        self._server.server_close()
        self._thread.join(timeout=5)

    @property
    def url(self) -> str:
        host, port = self._server.server_address[:2]
        return f"http://{host}:{port}/code-mode"


def ok_reply(result: object) -> tuple[int, str]:
    return 200, json.dumps({"ok": True, "result": result})


def error_reply(source: str, message: str) -> tuple[int, str]:
    return 200, json.dumps({"ok": False, "error": message, "source": source})


def load_client(env: dict[str, str], cleanup: Callable[[Callable[[], None]], None]) -> ModuleType:
    """Import a private copy of the client with `env` applied.

    The environment stays applied until the case ends, because the client reads its bridge
    configuration at import and its request timeout on every call.
    """
    directory = tempfile.mkdtemp()
    cleanup(lambda: shutil.rmtree(directory, ignore_errors=True))
    target = Path(directory) / "mcp_client.py"
    shutil.copyfile(CLIENT_SOURCE, target)

    previous = {name: os.environ.get(name) for name in env}

    def restore() -> None:
        for name, value in previous.items():
            if value is None:
                os.environ.pop(name, None)
            else:
                os.environ[name] = value

    cleanup(restore)
    os.environ.update(env)

    name = f"mcp_client_{Path(directory).name}"
    spec = importlib.util.spec_from_file_location(name, target)
    if spec is None or spec.loader is None:
        raise RuntimeError(f"could not load {target}")
    module = importlib.util.module_from_spec(spec)
    sys.modules[name] = module
    cleanup(lambda: sys.modules.pop(name, None))
    spec.loader.exec_module(module)
    return module


def http_env(url: str, **extra: str) -> dict[str, str]:
    return {
        "TFY_CM_HTTP_URL": url,
        "TFY_CM_HTTP_TOKEN": "turn-token-1",
        "TFY_CM_REQUEST_TIMEOUT_SECONDS": "5",
        "TFY_MCP_SERVERS": base64.b64encode(json.dumps({"demo": {"allowed_tools": []}}).encode()).decode(),
        "TFY_NATS_URL": "",
        "TFY_NATS_SUBJECT_PREFIX": "",
        **extra,
    }


class HttpBridgeTest(unittest.TestCase):
    def load(self, env: dict[str, str]) -> ModuleType:
        return load_client(env, self.addCleanup)

    def test_list_tools_carries_the_turn_token_to_the_configured_url(self) -> None:
        with RecordingBridge([ok_reply({"tools": [PING_TOOL]})]) as bridge:
            client = self.load(http_env(bridge.url))
            tools = asyncio.run(client._fetch_tools("demo"))

        self.assertEqual([tool.name for tool in tools], ["ping"])
        self.assertEqual(len(bridge.requests), 1)
        sent = bridge.requests[0]
        self.assertEqual(sent["path"], "/code-mode")
        self.assertEqual(sent["authorization"], "Bearer turn-token-1")
        self.assertEqual(sent["content_type"], "application/json")
        self.assertEqual(sent["body"], {"op": "list_tools", "server": "demo"})

    def test_call_tool_projects_the_result_and_sends_the_arguments(self) -> None:
        tool_result = {"content": [{"type": "text", "text": '{"pong": true}'}], "isError": False}
        with RecordingBridge([ok_reply({"tools": [PING_TOOL]}), ok_reply(tool_result)]) as bridge:
            client = self.load(http_env(bridge.url))
            value = asyncio.run(client.call_tool("demo", "ping", {"n": 1}))

        self.assertEqual(value, {"pong": True})
        self.assertEqual(bridge.requests[1]["body"], {
            "op": "call_tool",
            "server": "demo",
            "tool": "ping",
            "arguments": {"n": 1},
        })

    def test_forwards_the_trace_context_it_was_given(self) -> None:
        traceparent = "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01"
        with RecordingBridge([ok_reply({"tools": []})]) as bridge:
            client = self.load(http_env(bridge.url, TFY_TRACEPARENT=traceparent))
            asyncio.run(client._fetch_tools("demo"))

        self.assertEqual(bridge.requests[0]["traceparent"], traceparent)

    def test_a_caller_error_reply_names_the_request_as_invalid(self) -> None:
        with RecordingBridge([error_reply("caller", "MCP server 'demo' is not available for this agent")]) as bridge:
            client = self.load(http_env(bridge.url))
            with self.assertRaises(RuntimeError) as raised:
                asyncio.run(client._fetch_tools("demo"))

        self.assertIn("Invalid MCP request", str(raised.exception))
        self.assertIn("is not available for this agent", str(raised.exception))

    def test_a_refused_status_is_reported_once_and_never_retried(self) -> None:
        # Any HTTP status proves the request reached a handler, so a tool may already have run.
        with RecordingBridge([(401, "bad code mode token")]) as bridge:
            client = self.load(http_env(bridge.url))
            with self.assertRaises(RuntimeError) as raised:
                asyncio.run(client._fetch_tools("demo"))

        self.assertEqual(len(bridge.requests), 1)
        self.assertIn("HTTP 401", str(raised.exception))
        self.assertIn("bad code mode token", str(raised.exception))

    def test_a_connection_that_never_opened_is_retried_then_reported(self) -> None:
        with RecordingBridge([]) as bridge:
            closed_url = bridge.url
        client = self.load(http_env(closed_url))

        with self.assertRaises(RuntimeError) as raised:
            asyncio.run(client._fetch_tools("demo"))

        self.assertIn("unreachable after 3 attempts", str(raised.exception))

    def test_a_sandbox_with_no_bridge_configured_says_so(self) -> None:
        client = self.load(
            {
                "TFY_CM_HTTP_URL": "",
                "TFY_CM_HTTP_TOKEN": "",
                "TFY_NATS_URL": "",
                "TFY_NATS_SUBJECT_PREFIX": "",
                "TFY_CM_REQUEST_TIMEOUT_SECONDS": "5",
            }
        )
        with self.assertRaises(RuntimeError) as raised:
            asyncio.run(client._bridge_request({"op": "list_tools", "server": "demo"}))

        self.assertIn("Code Mode bridge setup failed", str(raised.exception))

    def test_half_configured_http_is_refused_at_import(self) -> None:
        with self.assertRaises(RuntimeError) as raised:
            self.load({"TFY_CM_HTTP_URL": "http://code-mode.invalid/", "TFY_CM_HTTP_TOKEN": ""})

        self.assertIn("must be set together", str(raised.exception))

    def test_nats_configuration_still_selects_the_nats_bridge(self) -> None:
        client = self.load(
            {
                "TFY_CM_HTTP_URL": "",
                "TFY_CM_HTTP_TOKEN": "",
                "TFY_NATS_URL": "nats://localhost:4222",
                "TFY_NATS_SUBJECT_PREFIX": "sandbox.bridge.abc",
                "TFY_CM_REQUEST_TIMEOUT_SECONDS": "5",
            }
        )
        self.assertEqual(client._NATS_SUBJECT, "sandbox.bridge.abc.mcp")

        sent: list[tuple[str, dict[str, object]]] = []

        async def fake_nats_request(subject: str, payload: dict[str, object]) -> object:
            sent.append((subject, payload))
            return {"tools": []}

        client._nats_request = fake_nats_request
        asyncio.run(client._bridge_request({"op": "list_tools", "server": "demo"}))
        self.assertEqual(sent, [("sandbox.bridge.abc.mcp", {"op": "list_tools", "server": "demo"})])


if __name__ == "__main__":
    unittest.main()
