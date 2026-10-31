# Image search

The `search_and_send_images` AI tool now uses **Tavily web images first** and
Wikimedia Commons as a fallback. It sends one image unless the user requests
more, with a maximum of five. Ask the bot, for example: “Send me a photo of an
orange Maine Coon cat.” An image search is not image generation.

Tavily searches beyond Commons and uses the existing `TAVILY_API_KEY` and
`TAVILY_ENABLED` settings. No new account, dependency, or key is required if web
search already works. With Tavily disabled or unconfigured, Commons still works.
Fallback also runs when Tavily fails, has no results, or its images cannot be
downloaded. Commons itself can be unavailable or overloaded.

## Free usage

[Tavily's free plan](https://www.tavily.com/pricing) includes **1,000 credits per
month**, shared with the bot's other Tavily searches. Image searches explicitly
use `basic` search, costing one credit per uncached request. Automatic parameter
selection is off, so the API cannot upgrade a search to advanced depth.
The bot does not change your billing plan or enable paid usage. If your account
already has paid usage enabled, its existing billing settings still apply.

Repeated queries share results for one hour in a bounded, in-memory cache.
Simultaneous identical queries share one API call; failures and empty results
are not cached. Restarting the bot clears the cache. This is free within the
provider's allowance, not an unlimited free service.

## Results and delivery

- Preserve the user's subject and provider relevance order. Use precise names
  and visual details in queries; no automatic unrelated stock-photo fallback.
- Request SafeSearch and image metadata from Tavily. Preserve the provider's
  ranking; metadata is not verified pixel analysis.
- Deduplicate URLs and image contents, including near-identical resized or
  recompressed copies. Skip broken files and try the next result; fill remaining
  requested slots from Commons. If unique results run out, report the shortfall.
- Remember the last 60 images per chat for one hour, across queries and follow-up
  requests. Serialize concurrent image requests in the same chat to avoid races.
  History is held in memory, bounded to 200 chats, and resets on restart.
- Send images without captions, titles, source links, creator credits or license
  text. Source metadata remains internal to the provider; the AI tool result
  omits source URLs so the assistant does not append them in its response.
- Download only public HTTPS destinations on the standard port. Check DNS
  answers and every redirect, pin each connection to validated addresses, and
  reject private/local addresses and credentialed URLs.
- Limit redirects, time and streamed bytes (8 MiB), then decode real image
  pixels with Sharp. Strip metadata and normalize to JPEG, at most 1600 pixels
  per side. Animated inputs become a static frame.
- Stop after an uncertain WhatsApp upload instead of sending replacements that
  could create duplicate messages. Report partial sends accurately.

## Other providers considered

[Openverse](https://api.openverse.org/v1/) supports anonymous searches and
aggregates openly licensed images, but repeated live API checks from this server
timed out during this change. [Pexels](https://www.pexels.com/api/documentation/)
is free with a separate key and primarily offers stock photography. Neither was
chosen as the default for this bot's general web-image requests.

Reference: [Tavily Search API](https://docs.tavily.com/documentation/api-reference/endpoint/search).
