"""Login to Gemini through a residential proxy and save cookies for that exit IP.

Google binds the web session to the IP, so cookies must be issued for the same
IP the bridge uses. Opens a real Chrome window via the proxy; log in with the
Pro account, then this script writes cookies.json automatically.

Run: GEMINI_PROXY="socks5h://user:pass@host:port" uv run --with playwright python scripts/login_via_proxy.py
"""

import asyncio
import json
import os
import re
import sys
from urllib.parse import urlparse

from playwright.async_api import async_playwright

PROFILE_DIR = os.environ.get("GEMINI_LOGIN_PROFILE", "/tmp/gemini-proxy-profile")


def parse_proxy(url: str) -> dict:
    u = urlparse(url)
    scheme = "socks5" if u.scheme.startswith("socks5") else "http"
    return {
        "server": f"{scheme}://{u.hostname}:{u.port}",
        "username": u.username or "",
        "password": u.password or "",
    }


async def main() -> None:
    proxy_url = os.environ.get("GEMINI_PROXY")
    if not proxy_url:
        print("Set GEMINI_PROXY (socks5h://user:pass@host:port)")
        sys.exit(1)
    proxy = parse_proxy(proxy_url)

    async with async_playwright() as p:
        ctx = await p.chromium.launch_persistent_context(
            user_data_dir=PROFILE_DIR,
            headless=False,
            proxy=proxy,
            args=["--disable-blink-features=AutomationControlled"],
        )
        page = ctx.pages[0] if ctx.pages else await ctx.new_page()
        await page.goto("https://gemini.google.com/")
        print(">>> Log in to Gemini (Pro account) in the opened Chrome window.", flush=True)
        print(">>> Waiting for authenticated session (up to 5 min)...", flush=True)

        for _ in range(150):
            await asyncio.sleep(2)
            try:
                cookies = await ctx.cookies("https://gemini.google.com")
            except Exception:
                continue
            ck = {c["name"]: c["value"] for c in cookies}
            url = page.url
            # authenticated: on the app page with a session cookie present
            if ck.get("__Secure-1PSID") and "gemini.google.com/app" in url:
                out = {
                    "__Secure-1PSID": ck["__Secure-1PSID"],
                    "__Secure-1PSIDTS": ck.get("__Secure-1PSIDTS", ""),
                }
                with open("cookies.json", "w") as f:
                    json.dump(out, f, indent=2)
                print(">>> cookies.json written for proxy exit IP. Done.", flush=True)
                await ctx.close()
                return
        print(">>> Timed out waiting for login.", flush=True)
        await ctx.close()
        sys.exit(1)


if __name__ == "__main__":
    asyncio.run(main())