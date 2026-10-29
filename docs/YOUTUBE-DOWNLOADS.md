# YouTube downloads and cookies

The bot runs the yt-dlp CLI from `commands/download.js` and
`commands/youtube-summary.js`. There was no custom Python downloader in this
repository. A complete standalone Python implementation is now available in
`scripts/download_youtube.py`.

## Complete Python setup

The Python module and yt-dlp executable can have different versions. This host's
system Python had yt-dlp 2024.04.09 while its executable was 2026.08.19. The new
isolated environment avoids changing system Python or the Demucs environment.

```bash
python3 -m venv .venv-youtube
.venv-youtube/bin/python -m pip install -U -r scripts/requirements-youtube.txt

# Recommended: automatic client selection, no account cookies initially
.venv-youtube/bin/python scripts/download_youtube.py 'https://youtu.be/VIDEO_ID'

# Requested Android/iOS configuration, for an anonymous attempt
.venv-youtube/bin/python scripts/download_youtube.py 'https://youtu.be/VIDEO_ID' --mobile-clients

# If the video requires sign-in, permit one authenticated retry
.venv-youtube/bin/python scripts/download_youtube.py 'https://youtu.be/VIDEO_ID' --cookies /path/to/cookies.txt

npm run test:python
```

Install ffmpeg and a supported JavaScript runtime as well. This server already
has ffmpeg, Deno and Node. For a Python installation, the `yt-dlp[default]`
dependency includes the matching EJS solver package; Deno is recommended and
enabled by default. The script also enables Node when available. Keep yt-dlp
and EJS compatible by updating them together through that dependency group.
See the official [EJS setup guide](https://github.com/yt-dlp/yt-dlp/wiki/EJS).

The exact Python option is included inside `ydl_opts`:

```python
"extractor_args": {
    "youtube": {"player_client": ["android", "ios"]}
} if mobile_clients and not cookies else {},
```

`--mobile-clients` selects this configuration. The default uses yt-dlp's automatic
client selection. Account-cookie retries deliberately use automatic compatible
clients; Android/iOS do not support account cookies. The script validates and
normalizes one YouTube video URL, downloads at up to 720p, merges audio/video with
ffmpeg, and reports errors. It does not fetch playlists.

## Bot behavior

`src/downloads/youtube-access.js` is shared by video inspection, actual downloads
and caption retrieval. YouTube requests start without account or browser cookies,
ignoring hidden yt-dlp configuration files. A broken/expired cookie-file setting
cannot prevent an otherwise accessible public video or caption request.

Only a sign-in, age or bot-verification failure triggers one retry using the
existing `YTDLP_COOKIES` setting. The file is checked for readability at that
point. Mobile client overrides are removed for the authenticated retry. Missing
videos, unavailable formats, missing binaries and unrelated HTTP failures are
not retried using account credentials.

To explicitly try mobile clients for bot video lookup/download, set:

```dotenv
YTDLP_YOUTUBE_CLIENTS=android,ios
```

Leave it empty to use automatic clients. Other valid client names can be chosen
when an operator has configured their requirements. This override does not force
mobile clients for caption retrieval, where compatible automatic selection is
used. Non-YouTube extractors retain their configured cookie behavior. No cookie
contents are logged by the new access policy.

## What changing clients does not solve

Client selection is not a universal cookie/verification bypass. YouTube may
require Proof of Origin tokens for Android/iOS and other clients, restrict access
by session/IP, or require account access for restricted videos. Updating a
different Python installation does not update the CLI binary used by the bot.

The official [YouTube extractor guide](https://github.com/yt-dlp/yt-dlp/wiki/Extractors#youtube)
recommends default clients initially, and `mweb` with a PO-token provider when
defaults fail. The [PO-token guide](https://github.com/yt-dlp/yt-dlp/wiki/PO-Token-Guide)
documents the current client requirements and supported provider approach. Tokens
can be bound to each video; hard-coding an old token is not a durable fix.
For account-required content, export a fresh session using the official cookie
instructions. No credentials or third-party provider were installed automatically.

Validation uses offline behavior tests and metadata-only anonymous probes; it
does not download a sample video or send cookies during diagnostics. On
2026-10-29, both automatic-client and Android/iOS metadata probes from this host
hit YouTube's server-side bot check, including with the updated Python module.
The client override therefore was not a successful verification bypass here.
