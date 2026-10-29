export function createMinecraftTools(mc) {
  return [
    {
      declaration: {
        name: 'get_minecraft_status',
        description:
          'Check whether the Minecraft server responds to a status ping. ' +
          'Returns online/offline information, player count, and version.',
        parameters: {
          type: 'OBJECT',
          properties: {},
        },
      },
      execute: async () => ({ ok: true, result: await mc.aiStatusSummary(false) }),
    },
    {
      declaration: {
        name: 'get_minecraft_players',
        description:
          'Check how many players are online and retrieve player names when available.',
        parameters: {
          type: 'OBJECT',
          properties: {},
        },
      },
      execute: async () => ({ ok: true, result: await mc.aiStatusSummary(true) }),
    },
    {
      declaration: {
        name: 'start_minecraft_server',
        description:
          'Start Minecraft when explicitly requested by the owner or a Minecraft admin. ' +
          'Do not start a second instance if a Fabric server process already exists.',
        parameters: {
          type: 'OBJECT',
          properties: {},
        },
      },
      access: 'minecraft-admin',
      execute: async () => mc.aiStartServer({ detailed: true }),
    },
    {
      declaration: {
        name: 'stop_minecraft_server',
        description:
          'Gracefully stop Minecraft when explicitly requested by the owner or a Minecraft admin.',
        parameters: {
          type: 'OBJECT',
          properties: {},
        },
      },
      access: 'minecraft-admin',
      execute: async () => mc.aiStopServer({ detailed: true }),
    }
  ];
}
