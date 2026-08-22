// The chat list, with the Inbox on it.
//
// Three sections rather than one list, because that is what the shared inbox
// module already says a thread can be — in the Inbox, snoozed, or archived — and
// the phone is where triage actually happens. A row is bold until it is read,
// long-press files it, and the section it lands in is derived from timestamps
// nobody has to keep in sync (see ../src/inbox/list.ts).
//
// The mutators all answer with the fresh ChatListResult, so acting on a row
// replaces the list with the server's version of it instead of guessing and
// re-fetching. That matters more here than on a desk: a phone acts on one row at
// a time and each act would otherwise cost a round trip plus a full list read.
//
// One timer, not a poll: a snoozed thread reappears the instant its wake time
// passes, and `msUntilNextWake` says when the earliest of those is.
//
// The FlatList is the screen's first child and the error banner and filter
// pills ride inside it as the list header. That is what lets the native large
// title collapse and the navigation bar go to glass as rows pass under it —
// the scroll view has to be the thing the screen is made of, not a sibling.

import { Link, Redirect, Stack } from 'expo-router';
import { useCallback, useEffect, useMemo, useState, type ReactElement } from 'react';
import {
  ActivityIndicator,
  Alert,
  FlatList,
  Pressable,
  RefreshControl,
  StyleSheet,
  Text,
  View
} from 'react-native';
import { SNOOZE_PRESETS, emptyInboxState } from '@shared/inbox';
import type { ChatSummary } from '@shared/types';
import { useChatList } from '../../../src/hooks/useChatList';
import { useLiveTurns } from '../../../src/hooks/useLiveTurns';
import { inboxRows, inboxUnreadCount, msUntilNextWake, type InboxFilter } from '../../../src/inbox/list';
import { useTransport } from '../../../src/transport/provider';
import { ConnectionBadge } from '../../../src/ui/ConnectionBadge';
import { useTheme, type Theme } from '../../../src/ui/theme';
import { relativeTime } from '../../../src/ui/time';

const FILTERS: { id: InboxFilter; label: string }[] = [
  { id: 'inbox', label: 'Inbox' },
  { id: 'snoozed', label: 'Snoozed' },
  { id: 'archived', label: 'Archived' }
];

export default function ChatsScreen(): ReactElement {
  const { connection, pairing } = useTransport();
  const theme = useTheme();
  const { list, loading, error, refresh, replace } = useChatList();
  const live = useLiveTurns();
  const [filter, setFilter] = useState<InboxFilter>('inbox');
  // Re-derives placement when a snooze expires. Bumped by the timer below and by
  // nothing else — every other change to the list arrives as a new `list`.
  const [now, setNow] = useState(() => Date.now());

  const chats = useMemo(() => list?.chats ?? [], [list]);
  const inbox = list?.inbox ?? emptyInboxState();
  // A working thread's row stays quiet (the green dot says why) until the turn
  // settles — mid-turn file writes must not paint it bold; see @shared/inbox.
  const running = useMemo(() => new Set(live.keys()), [live]);
  const rows = useMemo(
    () => inboxRows(chats, inbox, filter, now, running),
    [chats, inbox, filter, now, running]
  );
  const unread = useMemo(
    () => inboxUnreadCount(chats, inbox, now, running),
    [chats, inbox, now, running]
  );

  useEffect(() => {
    const delay = msUntilNextWake(chats, inbox, now);
    if (delay === null) return;
    const timer = setTimeout(() => setNow(Date.now()), delay);
    return () => clearTimeout(timer);
  }, [chats, inbox, now]);

  const act = useCallback(
    async (run: () => Promise<Parameters<typeof replace>[0]>) => {
      try {
        replace(await run());
      } catch (e) {
        Alert.alert('That didn’t go through', String((e as Error)?.message ?? e));
      }
    },
    [replace]
  );

  const menu = useCallback(
    (chat: ChatSummary, archived: boolean, unreadRow: boolean) => {
      Alert.alert(chat.subject ?? chat.title, undefined, [
        {
          text: archived ? 'Move to Inbox' : 'Archive',
          onPress: () => void act(() => connection.rpc('inbox:setArchived', [chat.threadId], !archived))
        },
        {
          text: unreadRow ? 'Mark read' : 'Mark unread',
          onPress: () => void act(() => connection.rpc('inbox:setRead', [chat.threadId], unreadRow))
        },
        ...SNOOZE_PRESETS.map((preset) => ({
          text: `Snooze — ${preset.label}`,
          onPress: () =>
            void act(() =>
              connection.rpc('inbox:snooze', [chat.threadId], preset.at(new Date()).getTime())
            )
        })),
        { text: 'Cancel', style: 'cancel' as const }
      ]);
    },
    [act, connection]
  );

  if (pairing === undefined) {
    return (
      <View style={[styles.center, { backgroundColor: theme.bg }]}>
        <ActivityIndicator color={theme.dim} />
      </View>
    );
  }
  if (pairing === null) return <Redirect href="/pair" />;

  return (
    <View style={[styles.screen, { backgroundColor: theme.bg }]}>
      <Stack.Screen
        options={{
          title: 'Chats',
          // Separate slots on purpose: iOS 26 renders each header item as its
          // own glass capsule, so the dot beside the + would look — and tap —
          // like one button.
          headerLeft: () => <ConnectionBadge />,
          headerRight: () => (
            <Link href="/new" asChild>
              <Pressable hitSlop={8}>
                <Text style={[styles.compose, { color: theme.accent }]}>+</Text>
              </Pressable>
            </Link>
          )
        }}
      />
      <FlatList
        data={rows}
        keyExtractor={(row) => row.chat.threadId}
        contentInsetAdjustmentBehavior="automatic"
        refreshControl={
          <RefreshControl refreshing={loading && list !== null} onRefresh={refresh} tintColor={theme.dim} />
        }
        ItemSeparatorComponent={() => <View style={[styles.separator, { backgroundColor: theme.line }]} />}
        ListHeaderComponent={
          <View>
            {error ? (
              <View style={[styles.banner, { backgroundColor: theme.card, borderColor: theme.line }]}>
                <Text style={[styles.bannerText, { color: theme.bad }]}>{error}</Text>
              </View>
            ) : null}
            <View style={[styles.filters, { borderColor: theme.line }]}>
              {FILTERS.map((f) => (
                <Pressable
                  key={f.id}
                  onPress={() => setFilter(f.id)}
                  style={[styles.filter, filter === f.id && { backgroundColor: theme.card, borderColor: theme.line }]}
                >
                  <Text style={[styles.filterText, { color: filter === f.id ? theme.text : theme.dim }]}>
                    {f.label}
                    {f.id === 'inbox' && unread ? ` · ${unread}` : ''}
                  </Text>
                </Pressable>
              ))}
            </View>
          </View>
        }
        ListEmptyComponent={
          loading ? null : (
            <Text style={[styles.empty, { color: theme.dim }]}>
              {filter === 'inbox'
                ? 'Nothing waiting. Start a chat with the + above, or at the desk.'
                : `Nothing ${filter}.`}
            </Text>
          )
        }
        ListFooterComponent={
          filter === 'inbox' && unread ? (
            <View style={styles.footer}>
              <Pressable onPress={() => void act(() => connection.rpc('inbox:markAllRead'))} hitSlop={8}>
                <Text style={[styles.footerAction, { color: theme.accent }]}>Mark all read</Text>
              </Pressable>
            </View>
          ) : null
        }
        renderItem={({ item }) => (
          <ChatRow
            chat={item.chat}
            theme={theme}
            unread={item.unread}
            wakeAt={item.wakeAt}
            working={live.has(item.chat.threadId)}
            onLongPress={() => menu(item.chat, filter === 'archived', item.unread)}
          />
        )}
      />
    </View>
  );
}

function ChatRow({
  chat,
  theme,
  unread,
  wakeAt,
  working,
  onLongPress
}: {
  chat: ChatSummary;
  theme: Theme;
  unread: boolean;
  wakeAt: number | null;
  working: boolean;
  onLongPress: () => void;
}): ReactElement {
  return (
    <Link href={{ pathname: '/thread/[id]', params: { id: chat.threadId } }} asChild>
      <Pressable onLongPress={onLongPress} style={styles.row}>
        {unread ? <View style={[styles.unreadDot, { backgroundColor: theme.accent }]} /> : <View style={styles.unreadGap} />}
        <View style={styles.rowText}>
          <Text numberOfLines={1} style={[styles.title, { color: theme.text }, unread && styles.titleUnread]}>
            {chat.subject ?? chat.title}
          </Text>
          {chat.preview ? (
            <Text numberOfLines={1} style={[styles.preview, { color: theme.dim }]}>
              {chat.preview}
            </Text>
          ) : null}
        </View>
        {working ? <View style={[styles.working, { backgroundColor: theme.live }]} /> : null}
        <Text style={[styles.time, { color: theme.dim }]}>
          {wakeAt === null ? relativeTime(chat.updatedAt) : '💤'}
        </Text>
      </Pressable>
    </Link>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1 },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center' },
  banner: { paddingHorizontal: 16, paddingVertical: 10, borderBottomWidth: StyleSheet.hairlineWidth },
  bannerText: { fontSize: 13 },
  // A glyph, not an icon set: this is the app's only header action.
  compose: { fontSize: 28, fontWeight: '400', lineHeight: 30 },
  filters: { flexDirection: 'row', gap: 6, paddingHorizontal: 12, paddingVertical: 8, borderBottomWidth: StyleSheet.hairlineWidth },
  filter: { paddingHorizontal: 12, paddingVertical: 6, borderRadius: 14, borderWidth: StyleSheet.hairlineWidth, borderColor: 'transparent' },
  filterText: { fontSize: 13, fontWeight: '600' },
  row: { flexDirection: 'row', alignItems: 'center', gap: 10, paddingHorizontal: 16, paddingVertical: 14 },
  unreadDot: { width: 7, height: 7, borderRadius: 4 },
  unreadGap: { width: 7 },
  rowText: { flex: 1, gap: 3 },
  title: { fontSize: 16, fontWeight: '500' },
  titleUnread: { fontWeight: '700' },
  preview: { fontSize: 13 },
  working: { width: 7, height: 7, borderRadius: 4 },
  time: { fontSize: 12, minWidth: 34, textAlign: 'right' },
  separator: { height: StyleSheet.hairlineWidth, marginLeft: 33 },
  empty: { fontSize: 14, textAlign: 'center', paddingHorizontal: 32, paddingVertical: 48, lineHeight: 20 },
  footer: { alignItems: 'center', paddingVertical: 24 },
  footerAction: { fontSize: 14 }
});
