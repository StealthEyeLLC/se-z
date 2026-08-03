#!/usr/bin/env python3
# Provenance: exact pinned source and transformation are recorded in vendor/baby-provenance/file-map.json.
import argparse
from pathlib import Path

SITE_HEADER = "se-z.stealtheye.io {"


def brace_delta(line: str) -> int:
    quoted = False
    escaped = False
    delta = 0
    for char in line:
        if escaped:
            escaped = False
            continue
        if char == "\\" and quoted:
            escaped = True
            continue
        if char == '"':
            quoted = not quoted
            continue
        if char == "#" and not quoted:
            break
        if not quoted:
            if char == "{":
                delta += 1
            elif char == "}":
                delta -= 1
    return delta


def replace_site(config: str, fragment: str) -> str:
    lines = config.splitlines(keepends=True)
    starts = [index for index, line in enumerate(lines) if line.strip() == SITE_HEADER]
    if len(starts) > 1:
        raise SystemExit("multiple se-z Caddy site blocks exist")
    replacement = fragment.rstrip() + "\n"
    if not starts:
        prefix = config.rstrip()
        return (prefix + "\n\n" if prefix else "") + replacement
    start = starts[0]
    depth = 0
    end = None
    for index in range(start, len(lines)):
        depth += brace_delta(lines[index])
        if index == start and depth <= 0:
            raise SystemExit("se-z Caddy site block is malformed")
        if depth == 0:
            end = index + 1
            break
        if depth < 0:
            raise SystemExit("se-z Caddy site block has unbalanced braces")
    if end is None:
        raise SystemExit("se-z Caddy site block is unterminated")
    before = "".join(lines[:start]).rstrip()
    after = "".join(lines[end:]).lstrip("\n")
    result = (before + "\n\n" if before else "") + replacement
    if after:
        result += "\n" + after
    return result


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--config", required=True)
    parser.add_argument("--fragment", required=True)
    parser.add_argument("--output", required=True)
    args = parser.parse_args()
    config_path = Path(args.config)
    fragment_path = Path(args.fragment)
    output_path = Path(args.output)
    content = replace_site(config_path.read_text(encoding="utf-8"), fragment_path.read_text(encoding="utf-8"))
    output_path.write_text(content, encoding="utf-8")


if __name__ == "__main__":
    main()
