export {
  a,
  argsProblem,
  dispatchLocal,
  hasLocalHandler,
  ipcArgSpecs,
  registerServer,
  serverChannels,
  type ArgSpec,
  type Caller,
  type CallerContext
} from './guard';
export type { IpcDeps } from './deps';
export { registerAuthIpc } from './auth';
export { registerChatsIpc } from './chats';
export { registerDevicesIpc } from './devices';
export { registerMcpIpc } from './mcp';
export { registerMemoryIpc } from './memory';
export { registerPersonasIpc } from './personas';
export { registerWorkspaceIpc } from './workspace';
