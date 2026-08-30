#!/usr/bin/env python3
"""Upload movies directly to azim-studio.onrender.com — no CSV, no localhost.

Prompts you for the boss secret and each movie (title, download URL,
thumbnail URL) and posts it straight to the site's boss upload endpoint.
Repeat until you're done.

Default base URL is the live site. Base URL is read from the .env file
(BASE_URL), falling back to environment variables. The boss secret is
always typed in by you, so it never sits in the code or .env file.

Requires only the Python standard library.
"""

import getpass
import json
import os
import re
import sys
import urllib.parse
import urllib.request

ENDPOINT = "/api/upload/link-item"
LIVE_BASE_URL = "https://azim-studio.onrender.com"


def load_env_file(path=".env"):
    if not os.path.exists(path):
        return {}
    values = {}
    with open(path, encoding="utf-8") as f:
        for line in f:
            m = re.match(r"^\s*([\w.-]+)\s*=\s*(.*)\s*$", line)
            if m and m.group(1) not in values:
                values[m.group(1)] = m.group(2)
    return values


def config_defaults():
    env = load_env_file()
    base_url = os.environ.get("BASE_URL") or env.get("BASE_URL") or LIVE_BASE_URL
    return base_url.rstrip("/")


def upload(base_url, boss_secret, entry):
    url = base_url + ENDPOINT
    data = urllib.parse.urlencode(entry).encode("utf-8")
    for _attempt in range(6):
        req = urllib.request.Request(
            url,
            data=data,
            headers={
                "x-boss-secret": boss_secret,
                "Content-Type": "application/x-www-form-urlencoded",
            },
            method="POST",
        )
        try:
            with urllib.request.urlopen(req, timeout=120) as resp:
                raw = resp.read().decode("utf-8", "replace")
                status = resp.status
        except urllib.error.HTTPError as e:
            if e.code in (301, 302, 303, 307, 308) and e.headers.get("Location"):
                url = urllib.parse.urljoin(url, e.headers["Location"])
                continue
            raw = e.read().decode("utf-8", "replace")
            status = e.code
        except urllib.error.URLError as e:
            return False, f"request error: {e.reason}"
        break
    else:
        return False, "too many redirects"

    try:
        body = json.loads(raw)
    except ValueError:
        body = raw
    if status != 200 or not (isinstance(body, dict) and body.get("success")):
        return False, f"{status} {body}"
    return True, (body.get("item") or {}).get("id", "")


def prompt(label, required=True):
    while True:
        value = input(f"{label}: ").strip()
        if value or not required:
            return value
        print("This field is required.")


def main():
    base_url = config_defaults()
    print(f"Uploading to {base_url}{ENDPOINT}")
    boss_secret = getpass.getpass("Boss secret: ").strip()
    while not boss_secret:
        boss_secret = getpass.getpass("Boss secret: ").strip()
    print()

    ok = failed = 0
    while True:
        title = prompt("Movie title (enter 'q' or Ctrl+X to quit)")
        if title.lower() in ("q", "quit", "exit") or "\x18" in title or " ^x" in title.lower():
            break
        movie_url = prompt("Download URL")
        thumbnail_url = input("Thumbnail URL (optional): ").strip()

        entry = {"title": title, "url": movie_url, "thumbnailUrl": thumbnail_url}
        success, result = upload(base_url, boss_secret, entry)
        print(f"  [{'OK' if success else 'FAIL'}] {result}\n")
        if success:
            ok += 1
        else:
            failed += 1

    print(f"\nDone. Succeeded: {ok}, failed: {failed}")
    sys.exit(0)


if __name__ == "__main__":
    main()
