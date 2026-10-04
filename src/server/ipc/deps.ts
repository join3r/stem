import type { ChatBackend } from '../backend';
import type { TaskScheduler } from '../scheduler';
import type { ProviderAuth } from '../pi/provider-auth';
import type { EmbedWorkerManager } from '../recall/embed-manager';
import type { RemoteHealthTracker } from '../recall/remote-health';
import type { RuntimeStatus } from '../../shared/types';

/**
 * Late-bound server singletons the per-domain IPC modules need. They are created
 * in the composition root (after registration), so every accessor is a getter —
 * never capture the value at registration time.
 */
export interface IpcDeps {
  /** STEM_E2E: hermetic fake backend; network/browser side effects are scripted. */
  e2e: boolean;
  /** The chat backend. Handlers only run post-bootstrap, when it exists. */
  runtime(): ChatBackend;
  scheduler(): TaskScheduler | null;
  providerAuth(): ProviderAuth | null;
  embedManager(): EmbedWorkerManager | null;
  /** Verdict cache for the user's remote retrieval endpoints (mode === 'remote'). */
  remoteHealth(): RemoteHealthTracker | null;
  /** Push on a client channel; it goes out on the SSE stream to every client
   *  whose role may receive it (see startup/transport.ts). */
  emit(channel: string, payload: unknown): void;
  /** Post-sign-in hook: re-pick the default model, restart pi, start the scheduler. */
  onAuthenticated(): Promise<RuntimeStatus>;
  /** (Re)arm the background memory-rebuild stepper. */
  scheduleMemoryRebuild(): void;
  /** Kick the indexed-connected-folders scan (e.g. right after an index toggle). */
  scheduleFolderIndexScan(delayMs?: number): void;
  /** Kick the folder fact-learning drain (e.g. right after a learn-mode change). */
  scheduleFolderLearn(delayMs?: number): void;
  /** Ask the idle-chat filer for a sweep soon (a folder just asked for older chats). */
  scheduleAutoFile(delayMs?: number): void;
}
