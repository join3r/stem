import type { TurnAttachment } from '@shared/types';
import type { DraftAttachment } from './store';

/** Check account identity after every async upload, before touching the mutable RPC endpoint. */
export async function submitDraft(options: {
  lease: { assertCurrent(): void };
  body: string;
  attachments: DraftAttachment[];
  upload(attachment: DraftAttachment): Promise<TurnAttachment>;
  send(body: string, attachments?: TurnAttachment[]): Promise<void>;
  progress?(message: string): void;
}): Promise<void> {
  const uploaded: TurnAttachment[] = [];
  for (let index = 0; index < options.attachments.length; index++) {
    options.lease.assertCurrent();
    options.progress?.(`Uploading ${index + 1} of ${options.attachments.length}…`);
    uploaded.push(await options.upload(options.attachments[index]));
  }
  options.lease.assertCurrent();
  options.progress?.('Sending…');
  await options.send(options.body.trim(), uploaded.length ? uploaded : undefined);
}
