export function createServerTools(sys) {
  return [
    {
      declaration: {
        name: 'get_vps_status',
        description:
          'Read current VPS CPU utilization, RAM usage, disk usage, and uptime. ' +
          'Owner-only.',
        parameters: {
          type: 'OBJECT',
          properties: {},
        },
      },
      access: 'owner',
      execute: async () => ({ ok: true, result: await sys.statusText() }),
    },
    {
      declaration: {
        name: 'get_top_processes',
        description:
          'List processes using the most CPU and RAM on the VPS. Owner-only.',
        parameters: {
          type: 'OBJECT',
          properties: {},
        },
      },
      access: 'owner',
      execute: async () => ({ ok: true, result: await sys.topText() }),
    },
    {
      declaration: {
        name: 'run_os_command',
        description:
          'Owner-only. Run one approved, read-only VPS diagnostic command. ' +
          'Call this tool multiple times when a request needs several checks. ' +
          'Never use it to change files, stop processes, modify services, or alter configuration.',
        parameters: {
          type: 'OBJECT',
          properties: {
            command: {
              type: 'STRING',
              enum: [
                'uptime',
                'cpu',
                'memory',
                'disk',
                'processes',
                'minecraft_process',
                'ports',
                'service_status',
              ],
              description:
                'Approved diagnostic: uptime, cpu, memory, disk, processes, ' +
                'minecraft_process, ports, or service_status.',
            },
            service: {
              type: 'STRING',
              enum: ['bot'],
              description: 'For service_status only, the approved service name: bot.',
            },
          },
          required: ['command'],
        },
      },
      access: 'owner',
      execute: async (args) => sys.runOsCommand(args.command, args.service),
    }
  ];
}
