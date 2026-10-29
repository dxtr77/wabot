export function createServiceTools(checkKatimsdService) {
  return [
    {
      declaration: {
        name: 'check_katimsd_service',
        description: 'Check KATIMSD/Bankak service availability for iPhone, Android or both; does not access accounts or make payments.',
        parameters: { type: 'OBJECT', properties: {
          platform: { type: 'STRING', enum: ['both', 'iphone', 'android'], description: 'Platform to check; defaults to both.' },
        } },
      },
      execute: async (args) => {
        const platform = args.platform ?? 'both';
        if (!['both', 'iphone', 'android'].includes(platform)) {
          return { ok: false, error: 'Platform must be both, iphone or android.' };
        }
        return { ok: true, result: await checkKatimsdService(platform) };
      },
    }
  ];
}
