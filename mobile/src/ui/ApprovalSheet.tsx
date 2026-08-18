// The blocking sheet: something the agent wants to do is waiting on an answer.
//
// Blocking is the point, and it is why this is mounted above the router rather
// than on a screen. A tool call is held open server-side until some client
// answers; until then the turn that asked for it is stopped. Anything that let
// the user keep browsing past the question would be an app where a turn silently
// hangs because a card scrolled off a list.
//
// One at a time, oldest first. Parallel tool calls produce several at once and
// the order they were asked in is the only order that means anything — "1 of 3"
// says how many are behind this one so the user knows they are answering a
// queue, not looping.
//
// Approving from a phone is not the same act as approving at the desk and the
// copy says so where it matters: an exec card shows the command and the working
// directory verbatim, because "yes" here runs a shell command on a machine that
// is not in the room.

import type { ReactElement, ReactNode } from 'react';
import { Modal, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { approvalTitle, type PendingApproval } from '../approvals/queue';
import { useApprovals } from '../hooks/useApprovals';
import { useTheme, type Theme } from './theme';

export function ApprovalSheet(): ReactElement | null {
  const approvals = useApprovals();
  const theme = useTheme();
  const item = approvals.current;

  // An answer that landed after its card had gone. The sheet stays up for it:
  // the user tapped "Run once" and nothing ran, and a phone that closes without
  // a word leaves them believing it did.
  if (approvals.missed) {
    return (
      <Modal visible transparent animationType="slide" onRequestClose={approvals.dismissMissed}>
        <View style={styles.scrim}>
          <View style={[styles.sheet, { backgroundColor: theme.bg, borderColor: theme.line }]}>
            <View style={styles.header}>
              <Text style={[styles.title, { color: theme.text }]}>That answer came too late</Text>
            </View>
            <ScrollView style={styles.body} contentContainerStyle={styles.bodyContent}>
              <Mono theme={theme}>{approvals.missed}</Mono>
              <Text style={[styles.text, { color: theme.dim }]}>
                Nobody answered in time, so this was not run — and the assistant was told exactly
                that, not that you refused. Ask it again if you still want it.
              </Text>
            </ScrollView>
            <View style={styles.actions}>
              <Action label="OK" tone={theme.accent} filled onPress={approvals.dismissMissed} theme={theme} />
            </View>
          </View>
        </View>
      </Modal>
    );
  }

  if (!item) return null;

  return (
    <Modal visible transparent animationType="slide" onRequestClose={() => approvals.respond(item, false)}>
      <View style={styles.scrim}>
        <View style={[styles.sheet, { backgroundColor: theme.bg, borderColor: theme.line }]}>
          <View style={styles.header}>
            <Text style={[styles.title, { color: theme.text }]}>{approvalTitle(item)}</Text>
            {approvals.queue.length > 1 ? (
              <Text style={[styles.count, { color: theme.dim }]}>1 of {approvals.queue.length}</Text>
            ) : null}
          </View>
          <ScrollView style={styles.body} contentContainerStyle={styles.bodyContent}>
            <ApprovalBody item={item} theme={theme} />
          </ScrollView>
          {approvals.error ? (
            <Text style={[styles.error, { color: theme.bad }]}>{approvals.error}</Text>
          ) : null}
          <View style={styles.actions}>
            <Action
              label="Deny"
              tone={theme.bad}
              disabled={approvals.busy}
              onPress={() => approvals.respond(item, false)}
              theme={theme}
            />
            {/* "Always allow" persists the learnable prefix server-side, and only
                exists when the command has one — a chained command with shell
                semantics tier 1 can never match arrives with an empty list. */}
            {item.kind === 'exec' && item.request.prefixes.length ? (
              <Action
                label="Always"
                tone={theme.accent}
                disabled={approvals.busy}
                onPress={() => approvals.respond(item, true, 'alwaysAllow')}
                theme={theme}
              />
            ) : null}
            <Action
              label={item.kind === 'exec' ? 'Run once' : 'Approve'}
              tone={theme.accent}
              filled
              disabled={approvals.busy}
              onPress={() => approvals.respond(item, true, 'allowOnce')}
              theme={theme}
            />
          </View>
        </View>
      </View>
    </Modal>
  );
}

function ApprovalBody({ item, theme }: { item: PendingApproval; theme: Theme }): ReactElement {
  switch (item.kind) {
    case 'exec':
      return (
        <>
          <Mono theme={theme}>{item.request.command}</Mono>
          <Field theme={theme} label="in">
            {item.request.cwd}
          </Field>
          {item.request.deviceLabel ? (
            <Field theme={theme} label="runs on">
              {item.request.deviceLabel}
            </Field>
          ) : null}
          {item.request.judgeReason ? (
            <Field theme={theme} label="why you're being asked">
              {item.request.judgeReason}
            </Field>
          ) : null}
        </>
      );
    case 'mcp':
      return (
        <Field theme={theme} label={item.proposal.action === 'add' ? 'server to connect' : 'server to remove'}>
          {item.proposal.name ?? item.proposal.input?.name ?? 'unnamed server'}
        </Field>
      );
    case 'instructions':
      return (
        <>
          {item.proposal.action === 'clear' ? (
            <Text style={[styles.text, { color: theme.text }]}>
              Your standing instructions would be emptied.
            </Text>
          ) : (
            <Mono theme={theme}>{item.proposal.incomingText}</Mono>
          )}
          <Field theme={theme} label="applies to">
            {(item.proposal.suggestedSurface ?? 'main') === 'main' ? 'every chat' : 'Quick Chat only'}
          </Field>
        </>
      );
    case 'skill':
      return (
        <>
          <Field theme={theme} label="name">
            {item.proposal.name}
          </Field>
          <Text style={[styles.text, { color: theme.text }]}>{item.proposal.description}</Text>
          <Mono theme={theme}>{item.proposal.body}</Mono>
        </>
      );
  }
}

function Mono({ theme, children }: { theme: Theme; children: ReactNode }): ReactElement {
  return (
    <View style={[styles.mono, { backgroundColor: theme.card, borderColor: theme.line }]}>
      <Text style={[styles.monoText, { color: theme.text }]}>{children}</Text>
    </View>
  );
}

function Field({ theme, label, children }: { theme: Theme; label: string; children: ReactNode }): ReactElement {
  return (
    <View style={styles.field}>
      <Text style={[styles.fieldLabel, { color: theme.dim }]}>{label}</Text>
      <Text style={[styles.text, { color: theme.text }]}>{children}</Text>
    </View>
  );
}

function Action({
  label,
  tone,
  filled,
  disabled,
  onPress,
  theme
}: {
  label: string;
  tone: string;
  filled?: boolean;
  disabled?: boolean;
  onPress: () => void;
  theme: Theme;
}): ReactElement {
  return (
    <Pressable
      onPress={onPress}
      disabled={disabled}
      style={[
        styles.action,
        { borderColor: tone, backgroundColor: filled ? tone : 'transparent', opacity: disabled ? 0.5 : 1 }
      ]}
    >
      <Text style={[styles.actionText, { color: filled ? theme.bg : tone }]}>{label}</Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  scrim: { flex: 1, justifyContent: 'flex-end', backgroundColor: 'rgba(0,0,0,0.45)' },
  sheet: {
    borderTopLeftRadius: 18,
    borderTopRightRadius: 18,
    borderTopWidth: StyleSheet.hairlineWidth,
    paddingHorizontal: 18,
    paddingTop: 16,
    paddingBottom: 28,
    maxHeight: '82%',
    gap: 12
  },
  header: { flexDirection: 'row', alignItems: 'baseline', gap: 10 },
  title: { fontSize: 18, fontWeight: '700', flex: 1 },
  count: { fontSize: 12 },
  body: { maxHeight: 380 },
  bodyContent: { gap: 12 },
  text: { fontSize: 15, lineHeight: 21 },
  field: { gap: 2 },
  fieldLabel: { fontSize: 11, textTransform: 'uppercase', letterSpacing: 0.6 },
  mono: { borderWidth: StyleSheet.hairlineWidth, borderRadius: 10, padding: 11 },
  monoText: { fontSize: 13, lineHeight: 19, fontFamily: 'Menlo' },
  error: { fontSize: 13 },
  actions: { flexDirection: 'row', gap: 8, justifyContent: 'flex-end' },
  action: { borderWidth: 1, borderRadius: 20, paddingHorizontal: 18, paddingVertical: 10 },
  actionText: { fontSize: 15, fontWeight: '600' }
});
