#!/usr/bin/env python3
"""Download one YouTube video; use --mobile-clients to try Android/iOS."""
import argparse
import os
import re
import shutil
from pathlib import Path
from urllib.parse import parse_qs, urlparse

import yt_dlp
from yt_dlp.utils import DownloadError
from yt_dlp.version import __version__


def build_options(output_dir, mobile_clients=False, cookies=None):
    ydl_opts = {
        "format": "bv*[height<=720]+ba/b[height<=720]",
        "outtmpl": str(Path(output_dir) / "%(title).100B [%(id)s].%(ext)s"),
        "merge_output_format": "mp4",
        "noplaylist": True,
        "restrictfilenames": True,
        "socket_timeout": 20,
        "retries": 3,
        "fragment_retries": 3,
        "js_runtimes": {"deno": {}, "node": {}},
        "extractor_args": {
            "youtube": {"player_client": ["android", "ios"]}
        } if mobile_clients and not cookies else {},
    }
    if cookies:
        cookie_path = Path(cookies).expanduser().resolve()
        if not cookie_path.is_file() or not os.access(cookie_path, os.R_OK):
            raise ValueError("The cookie file is missing or unreadable.")
        ydl_opts["cookiefile"] = str(cookie_path)
    return ydl_opts


def normalize_url(value):
    parsed = urlparse(value)
    host = (parsed.hostname or "").lower().removeprefix("www.")
    if parsed.scheme not in ("http", "https") or host not in {
        "youtube.com", "m.youtube.com", "music.youtube.com", "youtu.be", "youtube-nocookie.com"
    }:
        raise ValueError("Provide a YouTube video URL.")
    if host == "youtu.be":
        video_id = parsed.path.strip("/").split("/")[0]
    else:
        video_id = parse_qs(parsed.query).get("v", [""])[0]
        if not video_id:
            match = re.match(r"^/(?:shorts|embed|live)/([A-Za-z0-9_-]{11})(?:/|$)", parsed.path)
            video_id = match.group(1) if match else ""
    if not re.fullmatch(r"[A-Za-z0-9_-]{11}", video_id):
        raise ValueError("The URL needs a valid YouTube video ID.")
    return f"https://www.youtube.com/watch?v={video_id}"


def download_video(url, output_dir="downloads", cookies=None, mobile_clients=False):
    url = normalize_url(url)
    Path(output_dir).mkdir(parents=True, exist_ok=True)

    def attempt(options):
        with yt_dlp.YoutubeDL(options) as ydl:
            if ydl.download([url]):
                raise DownloadError("yt-dlp reported an unsuccessful download.")

    try:
        attempt(build_options(output_dir, mobile_clients))
    except DownloadError as error:
        needs_auth = re.search(
            r"sign[ -]?in|log[ -]?in|not a bot|bot verification|age[- ]restricted|confirm your age|private video|members[- ]only|authentication required",
            str(error), re.I,
        )
        if not cookies or not needs_auth:
            raise
        # Mobile clients do not support account cookies. Use automatic client
        # selection for the one authenticated retry.
        attempt(build_options(output_dir, cookies=cookies))


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("url")
    parser.add_argument("--output", default="downloads")
    parser.add_argument("--cookies", help="Optional Netscape cookie file, used only if sign-in is required")
    parser.add_argument("--mobile-clients", action="store_true", help="Try Android/iOS instead of automatic clients")
    args = parser.parse_args()
    version = re.match(r"^(\d+)\.(\d+)\.(\d+)", __version__)
    if not version or tuple(map(int, version.groups())) < (2026, 8, 19):
        parser.exit(2, f"Python imported outdated yt-dlp {__version__}. Use the updated .venv-youtube environment.\n")
    if not shutil.which("ffmpeg"):
        parser.exit(2, "ffmpeg is required for merging video and audio.\n")
    try:
        download_video(args.url, args.output, args.cookies, args.mobile_clients)
    except (DownloadError, ValueError, OSError) as error:
        parser.exit(1, f"Download failed: {error}\n")


if __name__ == "__main__":
    main()
