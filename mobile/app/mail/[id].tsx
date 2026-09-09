import { Stack, useFocusEffect, useLocalSearchParams, useRouter } from 'expo-router';
import { useCallback, useEffect, useMemo, useRef } from 'react';
import { Alert, AppState, Image, Pressable, ScrollView, Text, View } from 'react-native';
import { useKeyboardInset } from '../../src/ui/keyboard';
import { useMail } from '../../src/mail/useMail';
import { useMailWork } from '../../src/mail/useMailWork';
import { WorkSection } from '../../src/mail/WorkSection';
import { partitionMailWork } from '../../src/mail/work';
import { createMailReadTracker } from '../../src/mail/reads';
import { mailName, statusLabel } from '../../src/mail/list';
import { chooseSnooze, confirmMailDelete, mailAction } from '../../src/mail/actions';
import { AgentMarkdown } from '../../src/ui/AgentMarkdown';
import { DraftComposer } from '../../src/ui/DraftComposer';
import { useTheme } from '../../src/ui/theme';
import { useTransport } from '../../src/transport/provider';

export default function MailConversation() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const theme = useTheme();
  const router = useRouter();
  const api = useMail();
  const work = useMailWork(id);
  const { status } = useTransport();
  const keyboardInset = useKeyboardInset();
  const c = api.mail.conversations.find((value) => value.id === id);
  const items = api.mail.items.filter((item) => item.conversationId === id).sort((a, b) => a.at - b.at);
  const workSections = partitionMailWork(work.groups, items);
  const apiRef = useRef(api);
  apiRef.current = api;
  const readTracker = useMemo(() => createMailReadTracker((conversationId) => apiRef.current.setRead([conversationId], true)), []);
  useFocusEffect(useCallback(() => {
    readTracker.focus(id);
    readTracker.update(apiRef.current.mail, AppState.currentState === 'active');
    return () => readTracker.blur();
  }, [id, readTracker]));
  useEffect(() => {
    readTracker.update(api.mail, AppState.currentState === 'active');
  }, [api.mail, readTracker]);
  useEffect(() => {
    const subscription = AppState.addEventListener('change', (state) => {
      readTracker.update(apiRef.current.mail, state === 'active');
    });
    return () => subscription.remove();
  }, [readTracker]);
  const menu = () => {
    if (!c) return;
    Alert.alert(c.subject || 'Mail', undefined, [
      { text: 'Cancel', style: 'cancel' },
      {
        text: 'Mark unread',
        onPress: () =>
          mailAction(async () => {
            readTracker.preserveUnread();
            await api.setRead([id], false);
            router.replace('/inbox');
          })
      },
      {
        text: 'Archive',
        onPress: () =>
          mailAction(async () => {
            await api.archive([id], true);
            router.replace('/inbox');
          })
      },
      {
        text: 'Snooze',
        onPress: () =>
          chooseSnooze((until) => api.snooze([id], until), api.mail.inbox.entries[id]?.snoozedUntil)
      },
      {
        text: 'Add participant',
        onPress: () =>
          Alert.alert('Add a persona', undefined, [
            { text: 'Cancel', style: 'cancel' },
            ...api.personas
              .filter((p) => !c.participants.includes(p.id))
              .map((p) => ({
                text: p.name,
                onPress: () => mailAction(() => api.addParticipant(id, p.id))
              }))
          ])
      },
      {
        text: 'Delete',
        style: 'destructive',
        onPress: () =>
          confirmMailDelete(async () => {
            await api.remove(id);
            router.replace('/inbox');
          })
      }
    ]);
  };
  return (
    <View style={{ flex: 1, backgroundColor: theme.bg, paddingBottom: keyboardInset }}>
      <Stack.Screen
        options={{
          title: c?.subject || 'Mail',
          headerRight: () => (
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="Mail actions"
              onPress={menu}
              style={{ padding: 12 }}
            >
              <Text style={{ color: theme.accent }}>•••</Text>
            </Pressable>
          )
        }}
      />
      <ScrollView
        keyboardShouldPersistTaps="handled"
        contentContainerStyle={{ padding: 16, gap: 16 }}
      >
        {api.error && (
          <Pressable accessibilityRole="button" onPress={() => void api.refresh()}>
            <Text style={{ color: theme.bad }}>{api.error} · Tap to retry</Text>
          </Pressable>
        )}
        {!c ? (
          <Text style={{ color: theme.dim }}>
            {api.loading
              ? 'Loading mail…'
              : api.error
                ? 'Connect to read this conversation.'
                : 'This mail conversation is no longer available.'}
          </Text>
        ) : (
          <>
            <View style={{ gap: 8 }}>
              <Text
                style={{ color: theme.accent, fontWeight: '700', letterSpacing: 2, fontSize: 12 }}
              >
                STEM MAIL{c.private ? ' · PRIVATE' : ''}
              </Text>
              <Text style={{ color: theme.text, fontSize: 24, fontWeight: '600' }}>
                {c.subject || 'No subject'}
              </Text>
              <Text style={{ color: theme.dim }}>
                You · {c.participants.map((p) => mailName(api.personas, p)).join(' · ')}
              </Text>
            </View>
            {items.map((item) => (
                <View
                  key={item.id}
                  style={{
                    padding: 16,
                    gap: 12,
                    borderRadius: 16,
                    borderWidth: 1,
                    borderColor: theme.line,
                    backgroundColor: theme.card
                  }}
                >
                  <View style={{ gap: 5 }}>
                    <Text style={{ color: theme.accent, fontWeight: '700' }}>
                      {mailName(api.personas, item.from)}
                    </Text>
                    <Text style={{ color: theme.dim, fontSize: 12 }}>
                      To {item.to.map((p) => mailName(api.personas, p)).join(', ')} ·{' '}
                      {new Date(item.at).toLocaleString()}
                    </Text>
                  </View>
                  {item.stale && (
                    <Text style={{ color: theme.warn }}>Reply to an earlier message</Text>
                  )}
                  {item.subject && (
                    <Text selectable style={{ color: theme.text, fontSize: 17, fontWeight: '600' }}>
                      {item.subject}
                    </Text>
                  )}
                  {item.from === 'user' ? (
                    <Text selectable style={{ color: theme.text, fontSize: 16, lineHeight: 24 }}>
                      {item.body}
                    </Text>
                  ) : (
                    <AgentMarkdown text={item.body} theme={theme} />
                  )}
                  {item.result && (
                    <View style={{ borderTopWidth: 1, borderTopColor: theme.line, paddingTop: 12 }}>
                      <AgentMarkdown text={item.result} theme={theme} />
                    </View>
                  )}
                  {item.attachments?.map((a, index) =>
                    a.kind === 'image' && a.dataUrl ? (
                      <Image
                        key={index}
                        source={{ uri: a.dataUrl }}
                        accessibilityLabel={a.name || 'Attached image'}
                        resizeMode="contain"
                        style={{ width: '100%', height: 200, borderRadius: 8 }}
                      />
                    ) : (
                      <Text key={index} style={{ color: theme.dim }}>
                        Attachment · {a.name || 'File'}
                      </Text>
                    )
                  )}
                  <WorkSection groups={workSections.byItem.get(item.id) ?? []} personas={api.personas} />
                </View>
              ))}
            <WorkSection groups={workSections.unanchored} personas={api.personas} />
            {work.error && (
              <Pressable accessibilityRole="button" onPress={work.refresh} style={{ minHeight: 44, justifyContent: 'center' }}>
                <Text style={{ color: theme.bad }}>Work history: {work.error} · Tap to retry</Text>
              </Pressable>
            )}
            {!!statusLabel(c) && (
              <View style={{ flexDirection: 'row', gap: 16, alignItems: 'center' }}>
                <Text style={{ flex: 1, color: c.status === 'failed' ? theme.bad : theme.accent }}>
                  {statusLabel(c)}
                </Text>
                {c.status === 'working' && (
                  <Pressable
                    accessibilityRole="button"
                    onPress={() => mailAction(() => api.stop(id))}
                    style={{ padding: 14, borderRadius: 20, backgroundColor: theme.card }}
                  >
                    <Text style={{ color: theme.bad }}>Stop</Text>
                  </Pressable>
                )}
              </View>
            )}
          </>
        )}
      </ScrollView>
      {c && (
        <DraftComposer
          draftKey={`mail:${id}`}
          placeholder="Reply…"
          submitLabel="Reply"
          disabledReason={
            !status.reachable ? 'Offline — your draft is saved. Send when connected.' : undefined
          }
          onSend={async (body, attachments) => {
            await api.reply(id, body, attachments);
          }}
        />
      )}
    </View>
  );
}
