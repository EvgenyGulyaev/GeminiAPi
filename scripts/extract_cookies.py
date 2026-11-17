"""Extract Gemini cookies from Chrome into cookies.json (values never printed).

Run: uv run python scripts/extract_cookies.py
macOS: approve the Keychain "Chrome Safe Storage" dialog when it appears.
"""

import json
import sys

import browser_cookie3 as bc3

WANT = {"__Secure-1PSID", "__Secure-1PSIDTS"}


def main() -> None:
    try:
        jar = bc3.chrome(domain_name="google.com")
    except Exception as e:  # noqa: BLE001
        print(f"Chrome cookie read failed: {type(e).__name__}: {e}")
        sys.exit(1)
    got = {c.name: c.value for c in jar if c.name in WANT and not c.is_expired()}
    if "__Secure-1PSID" not in got:
        print("No __Secure-1PSID — log in to https://gemini.google.com in Chrome first.")
        sys.exit(1)
    with open("cookies.json", "w") as f:
        json.dump(
            {"__Secure-1PSID": got["__Secure-1PSID"],
             "__Secure-1PSIDTS": got.get("__Secure-1PSIDTS", "")},
            f, indent=2,
        )
    print("cookies.json written:", {k: len(v) for k, v in got.items()})


if __name__ == "__main__":
    main()