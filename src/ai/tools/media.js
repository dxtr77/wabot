export function createMediaTools({ searchAndSendImages, download }) {
  return [
    {
      declaration: {
        name: 'search_and_send_images',
        description:
          'Search web images using Tavily, with Wikimedia Commons as fallback, and send matching images to the current WhatsApp chat. ' +
          'Use only when the user explicitly asks to find, search for, show, or send images. ' +
          'Default to one image. For multiple images use count in a single call; repeated requests skip recently sent copies in this chat. ' +
          'Images are sent without captions or source links; do not append sources in your reply unless asked. ' +
          'Do not use this tool merely to discuss an image or analyze an attached image.',
        parameters: {
          type: 'OBJECT',
          properties: {
            query: {
              type: 'STRING',
              description: 'Short descriptive search query for the images the user wants.',
            },
            count: {
              type: 'INTEGER',
              description: 'Number of images to send (1 to 5). Use 1 unless the user requests more.',
            },
          },
          required: ['query'],
        },
      },
      execute: async (args, ctx) => searchAndSendImages(ctx, args),
    },
    {
      declaration: {
        name: 'download_media',
        description:
          'Download media only when the current user explicitly asks to download it. ' +
          'Use a URL from the current message or its quoted message. Do not download ' +
          'merely because a URL was shared. Use mode video or audio. Only provide ' +
          'height when the user explicitly requests a specific resolution (480, 720, ' +
          'or 1080). Otherwise omit height so the user can choose from the quality ' +
          'menu showing available resolutions and estimated file sizes.',
        parameters: {
          type: 'OBJECT',
          properties: {
            url: {
              type: 'STRING',
              description: 'The media URL to download.'
            },
            mode: {
              type: 'STRING',
              enum: ['video', 'audio'],
              description: 'Download a video or extract audio as MP3.'
            },
            height: {
              type: 'INTEGER',
              description: 'Maximum video height, preferably 480, 720, or 1080. Ignored for audio.'
            }
          },
          required: ['url', 'mode']
        }
      },
      execute: async (args, ctx) => {
        const url = String(args.url || '').trim();
        const mode = args.mode === 'audio' ? 'audio' : 'video';
        const height = [480, 720, 1080].includes(Number(args.height)) ? Number(args.height) : null;
        if (!url) return { ok: false, error: 'No media URL was provided.' };
        // The downloader validates URLs and enforces its own limits.
        const downloadArgs = mode === 'audio' ? `audio ${url}` : height ? `${height} ${url}` : url;
        const outcome = await download(ctx, downloadArgs, mode);
        return outcome?.status ? outcome : {
          ok: true, status: 'handled',
          result: 'The downloader handled the request. Completion is unconfirmed; check its message for a quality selection or error.'
        };
      },
    }
  ];
}
