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
  // A conversation a server feature answers (the memory check) runs no turns:
  // there is no work to show, and no "unavailable" rows to invent for it.
  if (!conversation || conversation.owner) return { groups: [] };
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
  // A scheduled run's mail names the thread it ran in (`runThreadId`): one
  // thread per firing, shared by every notification that firing sent. Each
  // thread is recovered once, against the mails that came out of it. Mail from
  // before runs had threads of their own carries none and falls through to the
  // "unavailable" row below. The sender is the persona the task runs as today;
  // a task since deleted reads as the plain task sender.
  const taskMails = items.filter((i) => i.taskId && i.runThreadId && !groups.some((g) => g.notificationItemId === i.id));
  if (taskMails.length) {
    const tasks = await readTasks();
    const byThread = new Map<string, MailItem[]>();
    for (const item of taskMails) byThread.set(item.runThreadId!, [...(byThread.get(item.runThreadId!) ?? []), item]);
    for (const [threadId, mails] of byThread) {
      const task = tasks.find((t) => t.id === mails[0].taskId);
      const personaId = task?.runsAs.kind === 'persona' ? task.runsAs.personaId : `task:${mails[0].taskId}`;
      await recover(threadId, personaId, mails);
    }
  }
  // Every source is represented, including legacy runs whose sessions no longer exist.
  // A progress question answered on the spot started no work, so it has none to show.
  for (const item of items.filter((i) => (i.from === 'user' && !i.statusQuery) || i.taskId)) {
    if (groups.some((g) => g.sourceItemId === item.id || g.notificationItemId === item.id)) continue;
    groups.push({ id: `unavailable:${item.id}`, conversationId,
      ...(item.from === 'user' ? { sourceItemId: item.id } : { notificationItemId: item.id }),
      historical: true, gaps: ['No reliably linked work records are available for this mail.'], runs: [] });
  }
  return { groups: groups.sort((a,b) => (a.runs[0]?.startedAt ?? 0) - (b.runs[0]?.startedAt ?? 0)) };
}
