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
export { chatListOf, registerChatsIpc } from './chats';
export { registerDevicesIpc } from './devices';
export { registerMcpIpc } from './mcp';
export { registerMailIpc } from './mail';
export { registerMemoryIpc } from './memory';
export { registerPersonasIpc } from './personas';
export { registerPinsIpc } from './pins';
export { registerWorkspaceIpc } from './workspace';
