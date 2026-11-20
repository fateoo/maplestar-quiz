#!/usr/bin/env python3
"""Stamp the next MapleStar Quiz release before committing it."""

import re
import subprocess
from datetime import datetime
from pathlib import Path
from zoneinfo import ZoneInfo


VERSION = re.compile(r'(<span id="release-version">網頁版本 )v(\d+)\.(\d+)\.(\d+)(</span>)')
RELEASE_TIME = re.compile(r'<time id="release-time" datetime="[^"]*">[^<]*</time>')


def main():
    root = Path(__file__).resolve().parents[2]
    previous = subprocess.check_output(
        ['git', 'show', 'HEAD:index.html'], cwd=root, encoding='utf-8',
    )
    previous_version = VERSION.findall(previous)
    if len(previous_version) != 1:
        raise SystemExit('The committed page must contain exactly one release version.')

    _, major, minor, patch, _ = previous_version[0]
    version = f'v{major}.{minor}.{int(patch) + 1}'
    now = datetime.now(ZoneInfo('Asia/Shanghai'))
    display_time = now.strftime('%Y-%m-%d %H:%M:%S')
    timestamp = now.isoformat(timespec='seconds')

    page = root / 'index.html'
    html, version_count = VERSION.subn(lambda match: f'{match[1]}{version}{match[5]}', page.read_text(encoding='utf-8'))
    release_time = f'<time id="release-time" datetime="{timestamp}">{display_time}</time>'
    html, time_count = RELEASE_TIME.subn(release_time, html)
    if (version_count, time_count) != (1, 1):
        raise SystemExit('The page must contain exactly one release version and release time.')

    page.write_text(html, encoding='utf-8')
    print(f'{version} · {display_time} UTC+8')


if __name__ == '__main__':
    main()
