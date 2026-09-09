import type { ChatBackend } from '../backend/types';
import type { MailItem, MailWorkGroup, MailWorkResult } from '../../shared/types';
import { readMail } from '../workspace/mail';
import { readTasks } from '../workspace/tasks';
import { readRecordedWork } from './work';
import type { HistoricalWorkRun } from './work-history';
import { readHarnessActivities } from '../harness/activities';

/** Recover only exact identities or unambiguous original request matches. */
export async function getMailWork(runtime: ChatBackend, conversationId: string): Promise<MailWorkResult> {
  const mail = await readMail();
  const conversation = mail.conversations.find((c) => c.id === conversationId);
  if (!conversation) return { groups: [] };
  const items = mail.items.filter((i) => i.conversationId === conversationId);
  const recorded = await readRecordedWork(conversationId);
  const groups = recorded.flatMap((g) => g.notificationItemIds?.length
    ? g.notificationItemIds.map((id) => ({ ...g, id: `${g.id}:${id}`, notificationItemId: id }))
    : [g]);
  const known = new Set(groups.flatMap((g) => g.runs.flatMap((r) => [r.id, r.turnId].filter(Boolean))));
  const user = items.filter((i) => i.from === 'user');
  const exactSource = (run: HistoricalWorkRun): MailItem | undefined => {
    const text = run.sourceRequest ?? run.request;
    if (!text?.trim()) return undefined;
    const candidates = user.filter((i) => i.body.trim() === text.trim() && i.at <= run.startedAt);
    return candidates.length === 1 ? candidates[0] : undefined;
  };
  const recover = async (threadId: string, personaId: string, notifications: MailItem[] = []) => {
    if (!runtime.readWorkHistory) return;
    let history: HistoricalWorkRun[];
    try { history = await runtime.readWorkHistory(threadId); }
    catch {
      // quiet: the Work section displays the missing-session error below.
      groups.push({ id: `missing:${threadId}`, conversationId, historical: true,
        gaps: ['The saved session could not be read. Its work history is unavailable.'], runs: [] });
      return;
    }
    const inner = await readHarnessActivities({ threadId });
    for (const raw of history) {
      if (known.has(raw.id) || (raw.turnId && known.has(raw.turnId))) continue;
      const matches = notifications.filter((i) => raw.notifications?.includes(i.body) &&
        notifications.filter((other) => other.body === i.body).length === 1 &&
        history.filter((r) => r.notifications?.includes(i.body)).length === 1);
      if (notifications.length && !matches.length) continue;
      for (const target of matches.length ? matches : [undefined]) {
      const notification = target ? [target] : [];
      const source = notifications.length ? undefined : exactSource(raw);
      const group: MailWorkGroup = { id: `history:${threadId}:${raw.id}${target ? `:${target.id}` : ''}`, conversationId,
        ...(source ? { sourceItemId: source.id } : {}),
        ...(notification[0] ? { notificationItemId: notification[0].id } : {}), historical: true,
        gaps: ['Recovered from saved records. Unrecorded activity and exact timings cannot be reconstructed.',
          ...(!source && !notification.length ? ['This run could not be linked confidently to one mail.'] : [])],
        runs: [{ ...raw, activities: [...raw.activities], personaId }] };
      // An old coding-agent call may still have an exact inner activity record.
      const ids = new Set(raw.activities.map((a) => a.id));
      for (const a of inner) if (a.itemId && ids.has(a.itemId)) group.runs[0].activities.push({
        id: `harness:${a.runId}:${a.id}`, kind: a.kind === 'tool' ? 'tool' : 'progress', label: a.title,
        at: Date.parse(a.startedAt), ...(a.status !== 'running' ? { endedAt: Date.parse(a.updatedAt) } : {}),
        status: a.status === 'running' ? 'error' : a.status === 'completed' ? 'ok' : 'error',
        parentId: a.itemId, input: a.input, output: a.output
      });
      const shared = groups.find((g) => (source && g.sourceItemId === source.id) || (notification[0] && g.notificationItemId === notification[0].id));
      if (shared) {
        shared.runs.push(...group.runs);
        shared.gaps = [...new Set([...(shared.gaps ?? []), ...(group.gaps ?? [])])];
      } else groups.push(group);
      }
      known.add(raw.id);
      if (raw.turnId) known.add(raw.turnId);
    }
  };
  const missingSources = user.some((i) => !groups.some((g) => g.sourceItemId === i.id));
  if (missingSources) await Promise.all(Object.entries(conversation.sessions).map(([persona, thread]) => recover(thread, persona)));
  const taskMails = items.filter((i) => i.taskId && !groups.some((g) => g.notificationItemId === i.id));
  if (taskMails.length) {
    const tasks = await readTasks();
    for (const task of tasks.filter((t) => taskMails.some((i) => i.taskId === t.id))) {
      await recover(task.threadId, task.personaId ?? `task:${task.id}`, taskMails.filter((i) => i.taskId === task.id));
    }
  }
  // Every source is represented, including legacy runs whose sessions no longer exist.
  for (const item of items.filter((i) => i.from === 'user' || i.taskId)) {
    if (groups.some((g) => g.sourceItemId === item.id || g.notificationItemId === item.id)) continue;
    groups.push({ id: `unavailable:${item.id}`, conversationId,
      ...(item.from === 'user' ? { sourceItemId: item.id } : { notificationItemId: item.id }),
      historical: true, gaps: ['No reliably linked work records are available for this mail.'], runs: [] });
  }
  return { groups: groups.sort((a,b) => (a.runs[0]?.startedAt ?? 0) - (b.runs[0]?.startedAt ?? 0)) };
}
