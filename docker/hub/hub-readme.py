#!/usr/bin/env python3
"""Rewrite the README's repo-relative links so it survives being rendered off GitHub.

Docker Hub shows the overview on its own domain, so `](docker-compose.yaml)` 404s and the hero
image renders broken at the very top of the page — the first thing anyone sees. GitHub keeps the
relative form, which is correct there; only the copy Hub gets is rewritten.
"""
import re
import sys

REPO = "https://github.com/saratihq/sarati"
RAW = "https://raw.githubusercontent.com/saratihq/sarati/main"
LINK = re.compile(r"(!?)\[([^\]]*)\]\((?!https?://|#|mailto:)([^)]+)\)")


def absolute(match: re.Match[str]) -> str:
    bang, text, target = match.groups()
    anchor = ""
    if "#" in target:
        target, _, anchor = target.partition("#")
        anchor = f"#{anchor}"
    base = RAW if bang else f"{REPO}/blob/main"
    # removeprefix, never lstrip: lstrip strips CHARACTERS, so `.github/…` lost its dot.
    return f"{bang}[{text}]({base}/{target.removeprefix('./')}{anchor})"


def main() -> int:
    source = sys.argv[1] if len(sys.argv) > 1 else "README.md"
    with open(source, encoding="utf-8") as handle:
        sys.stdout.write(LINK.sub(absolute, handle.read()))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
