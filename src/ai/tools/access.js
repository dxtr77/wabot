// The registry applies these rules both when exposing and executing a tool.
export function permissionError(access, ctx) {
  if (access === 'owner' && !ctx.isOwner) return 'Owner authorization required.';
  if (access === 'minecraft-admin' && !ctx.isOwner && !ctx.isMinecraftAdmin) {
    return 'Owner or Minecraft-admin authorization required.';
  }
  if (access === 'group-context' && (!ctx.isGroup || ctx.contextEnabled === false)) {
    return 'Chat context capture is not enabled in this group.';
  }
  return '';
}
