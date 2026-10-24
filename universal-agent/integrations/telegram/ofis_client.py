"""Async client for the Ofis web API, authenticated with OFIS_API_TOKEN."""
from __future__ import annotations

import json
from contextlib import asynccontextmanager
from typing import Any, AsyncIterator

import httpx


class OfisError(Exception):
    """Ofis answered with an error the user should see."""


class OfisBusy(OfisError):
    """The conversation is still working on an earlier message."""


class OfisNotFound(OfisError):
    """The conversation no longer exists (for example it was deleted in the web app)."""


class OfisClient:
    def __init__(self, base_url: str, api_token: str, *, timeout: float = 30.0) -> None:
        if not api_token:
            raise ValueError("OFIS_API_TOKEN is required")
        self._http = httpx.AsyncClient(
            base_url=base_url.rstrip("/"),
            headers={"Authorization": f"Bearer {api_token}"},
            timeout=timeout,
        )

    async def aclose(self) -> None:
        await self._http.aclose()

    async def _request(self, method: str, path: str, **kwargs: Any) -> httpx.Response:
        try:
            response = await self._http.request(method, path, **kwargs)
        except httpx.HTTPError as err:
            raise OfisError(f"Could not reach Ofis: {err}") from err
        if response.status_code == 401:
            raise OfisError("Ofis rejected the API token. Check OFIS_API_TOKEN on both servers.")
        if response.status_code == 404:
            raise OfisNotFound(_error_text(response))
        if response.status_code == 409:
            raise OfisBusy(_error_text(response))
        if response.status_code >= 400:
            raise OfisError(_error_text(response))
        return response

    async def create_conversation(self) -> str:
        return (await self._request("POST", "/api/conversations")).json()["id"]

    async def send_message(self, conversation_id: str, text: str, *, web_search: bool = True, review: bool = True) -> None:
        await self._request(
            "POST",
            f"/api/conversations/{conversation_id}/messages",
            json={"text": text, "webSearch": web_search, "review": review},
        )

    async def decide(self, approval_id: str, approved: bool) -> None:
        await self._request("POST", f"/api/approvals/{approval_id}", json={"approved": approved})

    async def list_files(self) -> list[str]:
        return (await self._request("GET", "/api/files")).json()["files"]

    async def download_file(self, path: str) -> bytes:
        response = await self._request("GET", "/api/files/content", params={"path": path, "download": "1"})
        return response.content

    @asynccontextmanager
    async def events(self, conversation_id: str) -> AsyncIterator[AsyncIterator[dict[str, Any]]]:
        """Open the conversation's live event stream (Server-Sent Events)."""
        # The server sends a heartbeat every 25 s, so a 90 s read timeout means the connection died.
        timeout = httpx.Timeout(30.0, read=90.0)
        try:
            async with self._http.stream("GET", f"/api/conversations/{conversation_id}/events", timeout=timeout) as response:
                if response.status_code == 404:
                    raise OfisNotFound("conversation not found")
                if response.status_code >= 400:
                    raise OfisError(f"Ofis returned HTTP {response.status_code} for the event stream")
                yield _parse_events(response)
        except httpx.HTTPError as err:
            raise OfisError(f"Lost the connection to Ofis: {err}") from err


async def _parse_events(response: httpx.Response) -> AsyncIterator[dict[str, Any]]:
    data: list[str] = []
    async for line in response.aiter_lines():
        if line.startswith("data: "):
            data.append(line[6:])
        elif line == "" and data:
            yield json.loads("\n".join(data))
            data = []


def _error_text(response: httpx.Response) -> str:
    try:
        return response.json().get("error") or f"HTTP {response.status_code}"
    except ValueError:
        return f"HTTP {response.status_code}"
