"""Capture the real Argon model header from the Gemini web UI.

Uses the authenticated proxy profile, selects Argon in the model picker, sends
a prompt, and intercepts the StreamGenerate request's model header
(x-goog-ext-525001261-jspb) to learn Argon's exact hex id / category.

Run: GEMINI_PROXY="socks5://127.0.0.1:10800" uv run --with playwright python scripts/capture_argon_header.py
"""

import asyncio
import json
import os
import sys

from playwright.async_api import async_playwright

PROFILE_DIR = os.environ.get("GEMINI_LOGIN_PROFILE", "/tmp/gemini-proxy-profile")
MODEL_HEADER = "x-goog-ext-525001261-jspb"
captured = []


def parse_proxy(url):
    from urllib.parse import urlparse
    u = urlparse(url)
    scheme = "socks5" if u.scheme.startswith("socks5") else "http"
    return {"server": f"{scheme}://{u.hostname}:{u.port}", "username": u.username or "", "password": u.password or ""}


async def main():
    proxy = parse_proxy(os.environ["GEMINI_PROXY"])
    async with async_playwright() as p:
        ctx = await p.chromium.launch_persistent_context(
            PROFILE_DIR, headless=False, proxy=proxy,
            args=["--disable-blink-features=AutomationControlled"],
        )
        page = ctx.pages[0] if ctx.pages else await ctx.new_page()

        def on_request(req):
            if "StreamGenerate" in req.url or "batchexecute" in req.url:
                h = req.headers.get(MODEL_HEADER)
                if h:
                    captured.append({"url": req.url[:60], "header": h})
        page.on("request", on_request)

        await page.goto("https://gemini.google.com/app")
        await page.wait_for_timeout(4000)

        # open model picker and choose Argon
        try:
            picker = page.locator("button[aria-label*='mode picker'], button[aria-label*='picker']").first
            await picker.click(timeout=8000)
            await page.wait_for_timeout(1000)
            argon = page.get_by_text("Argon", exact=False).first
            await argon.click(timeout=8000)
            await page.wait_for_timeout(1000)
            print(">>> selected Argon", flush=True)
        except Exception as e:
            print(">>> picker interaction failed:", str(e)[:120], flush=True)

        # send a prompt
        try:
            box = page.locator("div[contenteditable='true'], textarea").first
            await box.click(timeout=8000)
            await box.fill("Say OK")
            await page.keyboard.press("Enter")
            print(">>> prompt sent, waiting for request...", flush=True)
        except Exception as e:
            print(">>> prompt failed:", str(e)[:120], flush=True)

        for _ in range(30):
            await asyncio.sleep(1)
            if captured:
                break
        print(">>> captured headers:", flush=True)
        for c in captured[:6]:
            print(c["url"], "|", c["header"], flush=True)
        with open("/tmp/argon-headers.json", "w") as f:
            json.dump(captured, f, indent=2)
        await ctx.close()


if __name__ == "__main__":
    asyncio.run(main())