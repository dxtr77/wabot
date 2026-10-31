# Remove instrumental music from a WhatsApp video

Send a video with `!nomusic` in its caption, or reply to an existing video with
`!nomusic`. `!vocals` is an alias. The normal bot private-chat and enabled-group
access rules apply; no music processing happens merely because a video is shared.

This uses exactly the downloader's existing Demucs `htdemucs` two-stem vocals
pipeline. It extracts audio with ffmpeg, separates vocals from accompaniment,
then copies the original video stream into an MP4 with the vocal audio track.
Separation is approximate: speech and singing may both remain, and some music or
artifacts can remain too. This is not a mute-all-audio command.

The result is sent without a caption as a video, or as `vocals-only.mp4` when it
exceeds `DL_VIDEO_MB`. The command accepts at most 100 MB (or `DL_MAX_MB` when
smaller) and 10 minutes. Actual streamed bytes and ffprobe metadata are checked;
WhatsApp's advertised size/duration do not bypass those limits. Silent videos,
corrupt files and files without video tracks receive an error.

Processing uses the same queue as URL downloads (`DL_CONCURRENCY`) and permits
up to four attached-video requests waiting/running. Duplicate requests for the
same video within the same chat are suppressed while active and for 30 seconds
after sending. If an upload's acknowledgement is lost, the bot asks the user to
check the chat and briefly suppresses retries rather than sending another copy.

Each request uses its own private temporary directory. Downloaded source video,
extracted audio, Demucs stems and processed video are removed after the send
promise settles, including failed downloads, validation, separation and upload.
Cleanup is awaited before the processing slot is released. This deletes local
temporary files; it does not delete the incoming or outgoing WhatsApp message.
An abrupt OS/process termination can leave temporary files, as with other bot
media processing; orderly success and failure paths always run cleanup.

Dependencies are the existing ffmpeg/ffprobe installation and Demucs environment
at `~/voice-separation/venv/bin/python`. Demucs may download its model weights on
first use if they have not already been cached. No new external API or key is
needed.

Implementation: `src/commands/nomusic.js`, `src/media/video-input.js`, and shared
`src/media/vocals.js`. The downloader supplies its existing process runner and
Python path to the shared separator and exposes its processing slot wrapper.
