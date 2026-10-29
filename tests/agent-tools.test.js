import test, { mock } from 'node:test';
import assert from 'node:assert/strict';
import {
  toolDeclarations,
  availableToolDeclarations,
  executeAgentTool,
} from '../src/ai/tools/agent-tools.js';

const unauthorizedContext = {
  isOwner: false,
  isMinecraftAdmin: false,
};

test('tool visibility follows the same owner, Minecraft and group access rules as execution', () => {
  const namesFor = (ctx) => new Set(availableToolDeclarations(ctx).map((tool) => tool.name));
  const publicTools = namesFor(unauthorizedContext);
  assert.ok(publicTools.has('get_minecraft_status'));
  assert.ok(!publicTools.has('get_vps_status'));
  assert.ok(!publicTools.has('start_minecraft_server'));
  assert.ok(!publicTools.has('search_chat_history'));
  const adminTools = namesFor({ isMinecraftAdmin: true, isGroup: true, contextEnabled: true });
  assert.ok(adminTools.has('start_minecraft_server'));
  assert.ok(adminTools.has('search_chat_history'));
  assert.ok(!adminTools.has('get_vps_status'));
  assert.ok(namesFor({ isOwner: true }).has('get_vps_status'));
  assert.ok(!namesFor({ isOwner: true, isGroup: true, contextEnabled: false }).has('search_chat_history'));
});

test('unauthorized users cannot start or stop Minecraft through agent tools', async () => {
  for (const name of [
    'start_minecraft_server',
    'stop_minecraft_server',
  ]) {
    const result = await executeAgentTool(
      name,
      {},
      unauthorizedContext,
    );

    assert.equal(result.ok, false, `${name} should be denied`);
    assert.match(result.error, /authorization required/i);
  }
});

test('Minecraft admins without owner privileges cannot access VPS diagnostics', async () => {
  const context = {
    isOwner: false,
    isMinecraftAdmin: true,
  };

  for (const name of [
    'get_vps_status',
    'get_top_processes',
    'run_os_command',
  ]) {
    const result = await executeAgentTool(name, {}, context);

    assert.equal(result.ok, false, `${name} should be denied`);
    assert.match(result.error, /owner authorization required/i);
  }
});

test('unknown agent tools fail closed', async () => {
  const result = await executeAgentTool(
    'unknown_test_tool',
    {},
    unauthorizedContext,
  );

  assert.equal(result.ok, false);
  assert.match(result.error, /unknown tool/i);
});

test('privileged tools remain declared for the model', () => {
  const names = new Set(toolDeclarations.map((tool) => tool.name));

  for (const name of [
    'start_minecraft_server',
    'stop_minecraft_server',
    'get_vps_status',
    'get_top_processes',
    'run_os_command',
  ]) {
    assert.ok(names.has(name), `${name} should remain declared`);
  }
});

test('all owner-only agent tools deny Minecraft admins and ordinary users', async () => {
  for (const context of [
    { isOwner: false, isMinecraftAdmin: false },
    { isOwner: false, isMinecraftAdmin: true },
  ]) {
    for (const name of [
      'get_vps_status',
      'get_top_processes',
      'run_os_command',
    ]) {
      const result = await executeAgentTool(name, {
        command: 'uptime',
      }, context);

      assert.equal(result.ok, false, `${name} should deny non-owners`);
      assert.match(result.error, /owner authorization required/i);
    }
  }
});

test('owner authorization does not permit arbitrary OS commands', async () => {
  const result = await executeAgentTool(
    'run_os_command',
    { command: 'whoami' },
    { isOwner: true, isMinecraftAdmin: false },
  );

  assert.equal(result.ok, false);
  assert.match(result.error, /not on the approved list/i);
});

test('Katimsd service checks are declared with the supported platform enum', () => {
  const declaration = toolDeclarations.find((tool) => tool.name === 'check_katimsd_service');
  assert.ok(declaration, 'the model must see the service tool before it can call it');
  assert.deepEqual(new Set(declaration.parameters.properties.platform.enum), new Set(['both', 'iphone', 'android']));
});

test('Katimsd service tool routes supported platforms, defaults to both, and rejects unsupported values', async (t) => {
  const calls = [];
  mock.module('../src/commands/service.js', { namedExports: {
    checkKatimsdService: async (platform) => {
      calls.push(platform);
      return { service: 'KATIMSD', marker: 'isolated-test-result', platform, operational: true };
    },
  } });
  t.after(() => mock.reset());
  const { executeAgentTool: execute } = await import('../src/ai/tools/agent-tools.js?katimsd-routing-test');
  for (const platform of ['both', 'iphone', 'android']) {
    const result = await execute('check_katimsd_service', { platform }, unauthorizedContext);
    assert.match(JSON.stringify(result), /isolated-test-result/);
  }
  const defaultResult = await execute('check_katimsd_service', {}, unauthorizedContext);
  assert.match(JSON.stringify(defaultResult), /isolated-test-result/);
  assert.deepEqual(calls, ['both', 'iphone', 'android', 'both']);
  for (const platform of ['linux', '../iphone', 123]) {
    const result = await execute('check_katimsd_service', { platform }, unauthorizedContext);
    assert.equal(result.ok, false);
  }
  assert.equal(calls.length, 4, 'invalid platforms must be blocked before the service call');
});

test('Minecraft control tools request detailed outcomes and preserve refusal or failure', async (t) => {
  const calls = [];
  const startResult = { ok: false, status: 'refused', result: 'A Java process already exists.' };
  const stopResult = { ok: false, status: 'unconfirmed', result: 'The server is still responding.' };
  mock.module('../src/commands/minecraft.js', { namedExports: {
    aiStartServer: async (options) => { calls.push(['start', options]); return startResult; },
    aiStopServer: async (options) => { calls.push(['stop', options]); return stopResult; },
  } });
  t.after(() => mock.reset());
  const { executeAgentTool: execute } = await import('../src/ai/tools/agent-tools.js?detailed-minecraft-results');
  const ctx = { isOwner: false, isMinecraftAdmin: true };
  assert.deepEqual(await execute('start_minecraft_server', {}, ctx), startResult);
  assert.deepEqual(await execute('stop_minecraft_server', {}, ctx), stopResult);
  assert.deepEqual(calls, [['start', { detailed: true }], ['stop', { detailed: true }]]);
});
