import test from 'node:test';
import assert from 'node:assert/strict';
import {
  toolDeclarations,
  executeAgentTool,
} from '../src/ai/tools/agent-tools.js';

const unauthorizedContext = {
  isOwner: false,
  isMinecraftAdmin: false,
};

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
