import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from scripts import download_youtube as downloader


class DownloadYouTubeTests(unittest.TestCase):
    def test_requested_mobile_profile_and_authenticated_profile_are_separate(self):
        with tempfile.TemporaryDirectory() as directory:
            cookies = Path(directory) / "cookies.txt"
            cookies.write_text("# synthetic fixture, not credentials")
            mobile = downloader.build_options(directory, mobile_clients=True)
            self.assertEqual(mobile["extractor_args"], {"youtube": {"player_client": ["android", "ios"]}})
            self.assertNotIn("cookiefile", mobile)
            authenticated = downloader.build_options(directory, mobile_clients=True, cookies=cookies)
            self.assertEqual(authenticated["extractor_args"], {})
            self.assertEqual(authenticated["cookiefile"], str(cookies.resolve()))

    def test_default_clients_and_real_sdk_option_structure(self):
        with tempfile.TemporaryDirectory() as directory:
            options = downloader.build_options(directory)
            self.assertEqual(options["extractor_args"], {})
            self.assertTrue(options["noplaylist"])
            with downloader.yt_dlp.YoutubeDL(options) as ydl:
                self.assertEqual(ydl.params["js_runtimes"], options["js_runtimes"])

    def test_authenticated_retry_uses_cookie_file_without_mobile_clients(self):
        with tempfile.TemporaryDirectory() as directory:
            cookies = Path(directory) / "cookies.txt"
            cookies.write_text("# synthetic fixture, not credentials")
            with patch.object(downloader.yt_dlp, "YoutubeDL") as factory:
                factory.return_value.__enter__.return_value.download.side_effect = [
                    downloader.DownloadError("This members-only video requires channel access"), 0,
                ]
                downloader.download_video("https://youtu.be/abcdefghijk", directory, cookies, True)
                self.assertEqual(factory.call_count, 2)
                first = factory.call_args_list[0].args[0]
                second = factory.call_args_list[1].args[0]
                self.assertNotIn("cookiefile", first)
                self.assertEqual(second["extractor_args"], {})
                self.assertEqual(second["cookiefile"], str(cookies.resolve()))

    def test_unavailable_video_does_not_retry_with_cookies(self):
        with tempfile.TemporaryDirectory() as directory:
            with patch.object(downloader.yt_dlp, "YoutubeDL") as factory:
                factory.return_value.__enter__.return_value.download.side_effect = downloader.DownloadError("Video unavailable")
                with self.assertRaises(downloader.DownloadError):
                    downloader.download_video("https://youtu.be/abcdefghijk", directory, "/not-read")
                self.assertEqual(factory.call_count, 1)

    def test_public_video_does_not_need_a_broken_cookie_file(self):
        with tempfile.TemporaryDirectory() as directory:
            with patch.object(downloader.yt_dlp, "YoutubeDL") as factory:
                factory.return_value.__enter__.return_value.download.return_value = 0
                downloader.download_video("https://youtu.be/abcdefghijk", directory, "/not-read")
                self.assertNotIn("cookiefile", factory.call_args.args[0])

    def test_invalid_urls_are_rejected_before_using_the_sdk(self):
        with patch.object(downloader.yt_dlp, "YoutubeDL") as factory:
            for url in ["file:///etc/passwd", "https://youtube.com.evil.test/watch?v=abcdefghijk", "https://youtube.com/watch?v=short"]:
                with self.assertRaises(ValueError):
                    downloader.download_video(url)
            factory.assert_not_called()


if __name__ == "__main__":
    unittest.main()
