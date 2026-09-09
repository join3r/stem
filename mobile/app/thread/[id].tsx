import { Stack, useLocalSearchParams } from 'expo-router';
import { useCallback, useEffect, useMemo, useRef, useState, type ReactElement } from 'react';
import {
  ActivityIndicator,
  AppState,
  Image,
  FlatList,
  Pressable,
  StyleSheet,
  Text,
  View,
  type NativeScrollEvent,
  type NativeSyntheticEvent
} from 'react-native';
import { activityLabel } from '@shared/activity';
import type { ActivityItem, ChatMessage, TurnAttachment } from '@shared/types';
import { messageToResend } from '../../src/chat/resend';
import { useChatPersonas } from '../../src/hooks/useChatPersonas';
import { useThread } from '../../src/hooks/useThread';
import { useTransport } from '../../src/transport/provider';
import { MdxActionContext } from '../../src/mdx/actions';
import { AgentMarkdown } from '../../src/ui/AgentMarkdown';
import { ConnectionBadge } from '../../src/ui/ConnectionBadge';
import { DraftComposer, type DraftComposerHandle } from '../../src/ui/DraftComposer';
import { useDraft } from '../../src/drafts/useDraft';
import { PersonaChips } from '../../src/ui/PersonaChips';
import { useKeyboardInset } from '../../src/ui/keyboard';
import { isPinnedToBottom, type ScrollMetrics } from '../../src/ui/scroll';
import { useTheme, type Theme } from '../../src/ui/theme';

export default function ThreadScreen(): ReactElement {
  // `persona` arrives from the new-chat screen, so a conversation started as a
  // persona keeps talking to it here rather than silently reverting to Stem.
  const { id, persona: personaParam } = useLocalSearchParams<{ id: string; persona?: string }>();
  const threadId = String(id ?? '');
  const theme = useTheme();
  const thread = useThread(threadId);
  const [draftEmpty, setDraftEmpty] = useState(false);
  const composerInput = useRef<DraftComposerHandle>(null);
  const draftStore = useDraft(`chat:${threadId}`);
  // Who the next send runs as. Screen-local and per-send on the wire — the
  // server pins nothing to the thread, so the desk (or a later visit) sending
  // plain into the same thread is normal, exactly like scheduled persona runs.
  const personas = useChatPersonas();
  const storedPersona = draftStore.draft.metadata.personaId;
  const personaId =
    typeof storedPersona === 'string'
      ? storedPersona || null
      : typeof personaParam === 'string'
        ? personaParam
        : null;
  const setPersonaId = (value: string | null) => draftStore.setMetadata({ personaId: value ?? '' });

  // Opening is what marks a thread read — the desktop's rule (see openChat in
  // src/renderer/App.tsx), applied here on mount and again each time a turn
  // settles while the screen is up, so a reply you watched arrive can't leave
  // the thread bold behind you. Skipped while backgrounded: a turn that settles
  // under a locked screen was not read, and the row should say so. Best-effort —
  // a stamp that doesn't land just leaves the dot for the next open.
  const { connection, status } = useTransport();
  useEffect(() => {
    if (!threadId || !status.paired || thread.running) return;
    if (AppState.currentState !== 'active') return;
    connection.rpc('inbox:setRead', [threadId], true).catch(() => undefined);
  }, [connection, status.paired, thread.running, threadId]);

  const list = useRef<FlatList<ChatMessage>>(null);
  // Refs, not state: these are read inside scroll handlers that fire many times
  // a second and re-rendering the transcript to record them would be absurd.
  const pinned = useRef(true);
  // Whether the scroll events arriving right now were caused by a finger — a
  // drag, or the momentum one left behind. Only those may change the pinning
  // decision: scrollToEnd below reports through onScroll too, and when it lands
  // short (FlatList estimates the height of rows it has not measured yet, which
  // is most of them right after the transcript hydrates) that programmatic
  // landing must not unpin the view it was trying to pin. Left unpinned, nothing
  // retries and a freshly opened thread sits stuck mid-transcript.
  const dragging = useRef(false);

  const metricsOf = (e: NativeSyntheticEvent<NativeScrollEvent>): ScrollMetrics => ({
    offsetY: e.nativeEvent.contentOffset.y,
    layoutHeight: e.nativeEvent.layoutMeasurement.height,
    contentHeight: e.nativeEvent.contentSize.height
  });

  const onScroll = useCallback((e: NativeSyntheticEvent<NativeScrollEvent>) => {
    if (dragging.current) pinned.current = isPinnedToBottom(metricsOf(e));
  }, []);
  const onDragBegin = useCallback(() => {
    dragging.current = true;
  }, []);
  // End-of-drag and end-of-momentum both settle the decision; momentum-begin
  // re-opens it for the flick that follows a released drag. scrollToEnd with
  // animated: false fires none of these three.
  const onDragEnd = useCallback((e: NativeSyntheticEvent<NativeScrollEvent>) => {
    pinned.current = isPinnedToBottom(metricsOf(e));
    dragging.current = false;
  }, []);
  const onMomentumBegin = useCallback(() => {
    dragging.current = true;
  }, []);
  const onMomentumEnd = useCallback((e: NativeSyntheticEvent<NativeScrollEvent>) => {
    pinned.current = isPinnedToBottom(metricsOf(e));
    dragging.current = false;
  }, []);

  // Fires for content growing (a token, a hydration, a later row getting its
  // real height) and for the viewport resizing (the keyboard). Both re-assert
  // the pin, and the repeated calls are the convergence: each landing mounts
  // more rows, whose measured heights fire this again, until short stops being
  // short.
  const onGrew = useCallback(() => {
    if (pinned.current) list.current?.scrollToEnd({ animated: false });
  }, []);

  const sendTurn = thread.send;
  const submit = useCallback(
    async (text: string, attachments?: TurnAttachment[]) => {
      pinned.current = true;
      await sendTurn(text, personaId, attachments);
    },
    [personaId, sendTurn]
  );
  const resend = messageToResend(thread.state.messages);
  const canRestore = !!resend && draftEmpty && !thread.running && !thread.sending;
  const restoreMessage = useCallback(() => {
    if (resend && canRestore) composerInput.current?.restore(resend.content);
  }, [canRestore, resend]);
  const draftChanged = useCallback(
    (body: string, hasAttachments: boolean) => setDraftEmpty(!body && !hasAttachments),
    []
  );

  // What a <Quiz> or <Form> in a reply may do: exactly what the composer does,
  // and only when the composer itself could. `running` is the flag those
  // components disable their own send button on, so it carries every reason a
  // send would not land — a turn in flight, and the connection being unable to
  // carry one at all — rather than only the first.
  const sendMessage = thread.send;
  const mdxActions = useMemo(
    () => ({
      // A <Quiz>/<Form> reply is a send like any other, so it goes to whoever
      // the composer is currently talking to.
      submit: (text: string) => {
        void sendMessage(text, personaId).catch(() => undefined);
      },
      running: thread.running || thread.sending || thread.blocked !== null
    }),
    [personaId, sendMessage, thread.blocked, thread.running, thread.sending]
  );

  // The keyboard's measured cover of the window, as bottom padding — see
  // src/ui/keyboard.ts for why this replaced KeyboardAvoidingView here.
  const keyboardInset = useKeyboardInset();

  return (
    <View style={[styles.screen, { backgroundColor: theme.bg, paddingBottom: keyboardInset }]}>
      <Stack.Screen
        options={{ title: thread.title || 'Chat', headerRight: () => <ConnectionBadge /> }}
      />
      {thread.error ? (
        <Pressable onPress={thread.reload} style={[styles.banner, { borderColor: theme.line }]}>
          <Text style={[styles.bannerText, { color: theme.bad }]}>
            {thread.error} — tap to retry
          </Text>
        </Pressable>
      ) : null}
      {/* A context provider is transparent to the native layout tree, so the
          FlatList is still the padded screen view's own child. */}
      <MdxActionContext.Provider value={mdxActions}>
        <FlatList
          ref={list}
          data={thread.state.messages}
          keyExtractor={(message) => message.id}
          contentContainerStyle={styles.transcript}
          onScroll={onScroll}
          onScrollBeginDrag={onDragBegin}
          onScrollEndDrag={onDragEnd}
          onMomentumScrollBegin={onMomentumBegin}
          onMomentumScrollEnd={onMomentumEnd}
          scrollEventThrottle={64}
          onContentSizeChange={onGrew}
          onLayout={onGrew}
          keyboardDismissMode="interactive"
          ListEmptyComponent={
            thread.loading ? (
              <ActivityIndicator style={styles.loading} color={theme.dim} />
            ) : (
              <Text style={[styles.empty, { color: theme.dim }]}>Nothing in this chat yet.</Text>
            )
          }
          ListFooterComponent={
            <LiveActivity
              theme={theme}
              running={thread.running}
              streaming={thread.state.streamingId !== null}
              label={thread.state.activity}
              activities={thread.state.activities}
            />
          }
          renderItem={({ item }) => (
            <Bubble
              message={item}
              theme={theme}
              streaming={item.id === thread.state.streamingId}
              onRestore={
                resend && item.id === thread.state.messages.at(-1)?.id ? restoreMessage : undefined
              }
              canRestore={canRestore}
            />
          )}
        />
      </MdxActionContext.Provider>
      <DraftComposer
        ref={composerInput}
        draftKey={`chat:${threadId}`}
        onSend={submit}
        running={thread.running}
        onStop={thread.interrupt}
        disabledReason={thread.blocked}
        onDraftChange={draftChanged}
        header={
          <PersonaChips
            personas={personas}
            selected={personaId}
            onSelect={setPersonaId}
            theme={theme}
          />
        }
      />
    </View>
  );
}

function Bubble({
  message,
  theme,
  streaming,
  onRestore,
  canRestore
}: {
  message: ChatMessage;
  theme: Theme;
  streaming: boolean;
  onRestore?: () => void;
  canRestore: boolean;
}): ReactElement {
  if (message.role === 'user') {
    return (
      <View
        style={[styles.userBubble, { backgroundColor: theme.accentSoft, borderColor: theme.line }]}
      >
        <Text style={[styles.userText, { color: theme.text }]}>{message.content}</Text>
        {message.attachments?.map((attachment, index) =>
          attachment.kind === 'image' && attachment.dataUrl ? (
            <Image
              key={index}
              source={{ uri: attachment.dataUrl }}
              accessibilityLabel={attachment.name ?? 'Attached image'}
              style={{ width: 200, height: 150, borderRadius: 10, marginTop: 8 }}
              resizeMode="contain"
            />
          ) : (
            <Text key={index} style={{ color: theme.dim, marginTop: 8 }}>
              {attachment.name ?? 'Attachment'}
            </Text>
          )
        )}
        {message.sendFailed ? (
          <Text style={[styles.failed, { color: theme.bad }]}>Not sent</Text>
        ) : null}
      </View>
    );
  }
  if (message.role === 'system') {
    return (
      <View style={[styles.systemBubble, { borderColor: theme.line }]}>
        <Text style={[styles.systemText, { color: theme.bad }]}>{message.content}</Text>
        {onRestore ? (
          <Pressable
            onPress={onRestore}
            disabled={!canRestore}
            accessibilityRole="button"
            style={styles.restore}
          >
            <Text style={{ color: canRestore ? theme.accent : theme.dim }}>Edit and resend</Text>
          </Pressable>
        ) : null}
      </View>
    );
  }
  return (
    <View style={styles.agentBubble}>
      {message.activity?.length ? <ActivityRows rows={message.activity} theme={theme} /> : null}
      {/* The bubble still arriving takes the incremental renderer, which parses
          only the growing tail; the settled ones take the exact full parse that
          heals any block-split artifact it left behind. */}
      <AgentMarkdown text={message.content} theme={theme} streaming={streaming} />
    </View>
  );
}

/** The turn's tool calls, one line each, kept with the bubble they belong to. */
function ActivityRows({ rows, theme }: { rows: ActivityItem[]; theme: Theme }): ReactElement {
  return (
    <View style={styles.activityBlock}>
      {rows.map((row) => (
        <View key={row.id} style={styles.activityRow}>
          <View
            style={[
              styles.activityDot,
              {
                backgroundColor:
                  row.status === 'error'
                    ? theme.bad
                    : row.status === 'running'
                      ? theme.warn
                      : theme.line
              }
            ]}
          />
          <Text numberOfLines={1} style={[styles.activityText, { color: theme.dim }]}>
            {activityLabel(row.type, row.name, row.detail)}
          </Text>
        </View>
      ))}
    </View>
  );
}

/**
 * The working line, shown between "sent" and the first token. It disappears once
 * text is streaming because the text itself is then the evidence — two live
 * indicators for one turn is one too many.
 */
function LiveActivity({
  theme,
  running,
  streaming,
  label,
  activities
}: {
  theme: Theme;
  running: boolean;
  streaming: boolean;
  label: string | null;
  activities: ActivityItem[];
}): ReactElement | null {
  if (!running || streaming) return null;
  return (
    <View style={styles.live}>
      <ActivityIndicator size="small" color={theme.dim} />
      <Text numberOfLines={1} style={[styles.liveText, { color: theme.dim }]}>
        {label ?? (activities.length ? 'Working…' : 'Thinking…')}
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1 },
  banner: {
    paddingHorizontal: 16,
    paddingVertical: 10,
    borderBottomWidth: StyleSheet.hairlineWidth
  },
  bannerText: { fontSize: 13 },
  transcript: { paddingHorizontal: 16, paddingVertical: 12, gap: 14 },
  loading: { paddingVertical: 40 },
  empty: { fontSize: 14, textAlign: 'center', paddingVertical: 48 },
  userBubble: {
    alignSelf: 'flex-end',
    maxWidth: '86%',
    borderWidth: StyleSheet.hairlineWidth,
    borderRadius: 14,
    paddingHorizontal: 12,
    paddingVertical: 9
  },
  userText: { fontSize: 16, lineHeight: 22 },
  failed: { fontSize: 12, marginTop: 4 },
  agentBubble: { alignSelf: 'stretch' },
  systemBubble: {
    alignSelf: 'stretch',
    borderWidth: StyleSheet.hairlineWidth,
    borderRadius: 10,
    paddingHorizontal: 12,
    paddingVertical: 9
  },
  systemText: { fontSize: 14, lineHeight: 20 },
  restore: { alignSelf: 'flex-start', paddingVertical: 12 },
  activityBlock: { gap: 3, marginBottom: 8 },
  activityRow: { flexDirection: 'row', alignItems: 'center', gap: 7 },
  activityDot: { width: 6, height: 6, borderRadius: 3 },
  activityText: { fontSize: 12, flex: 1 },
  live: { flexDirection: 'row', alignItems: 'center', gap: 8, paddingVertical: 6 },
  liveText: { fontSize: 13, flex: 1 }
});
