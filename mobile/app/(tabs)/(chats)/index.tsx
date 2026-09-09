import { Link, Redirect, useFocusEffect } from 'expo-router';
import { SymbolView } from 'expo-symbols';
import { useCallback, useEffect, useMemo, useState } from 'react';
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
import { isUnread, emptyInboxState } from '@shared/inbox';
import type { ChatSummary } from '@shared/types';
import { useChatList } from '../../../src/hooks/useChatList';
import { useLiveTurns } from '../../../src/hooks/useLiveTurns';
import { useTransport } from '../../../src/transport/provider';
import { ConnectionBadge } from '../../../src/ui/ConnectionBadge';
import { SwipeRow } from '../../../src/ui/SwipeRow';
import { useTheme } from '../../../src/ui/theme';
import { relativeTime } from '../../../src/ui/time';
import { acknowledgeSubmittedThread } from '../../../src/chat/submitted';

export default function ChatsScreen() {
  const { connection, pairing } = useTransport();
  const theme = useTheme();
  const { list, loading, error, refresh, revalidate, replace } = useChatList();
  const live = useLiveTurns();
  const [pulling, setPulling] = useState(false);
  const [previewLines, setPreviewLines] = useState<0 | 1 | 2>(1);
  useEffect(() => {
    if (!loading) setPulling(false);
  }, [loading]);
  useFocusEffect(
    useCallback(() => {
      revalidate();
      void connection
        .rpc('settings:get')
        .then((value) => setPreviewLines(value.chats.previewLines))
        .catch(() => undefined);
    }, [connection, revalidate])
  );
  // Chats mirror the desktop tree: archive and snooze are Mail concepts.
  const rows = useMemo(
    () => [...(list?.chats ?? [])].sort((a, b) => b.updatedAt - a.updatedAt),
    [list]
  );
  const inbox = list?.inbox ?? emptyInboxState();
  const showError = (e: unknown) =>
    Alert.alert('That didn’t go through', String((e as Error)?.message ?? e));
  const toggleRead = async (chat: ChatSummary, unread: boolean) => {
    try {
      replace(await connection.rpc('inbox:setRead', [chat.threadId], unread));
    } catch (e) {
      showError(e);
    }
  };
  const deleteChat = (chat: ChatSummary) => {
    if (live.has(chat.threadId)) {
      Alert.alert('This chat is working', 'Open it and stop the reply before deleting it.');
      return;
    }
    Alert.alert(
      'Delete chat?',
      `“${chat.subject ?? chat.title}” and its files will be permanently deleted from Stem on all devices.`,
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Delete',
          style: 'destructive',
          onPress: () => {
            void (async () => {
              try {
                await connection.rpc('chats:delete', chat.threadId);
                acknowledgeSubmittedThread(chat.threadId);
                replace(await connection.rpc('chats:list'));
              } catch (e) {
                showError(e);
                revalidate();
              }
            })();
          }
        }
      ]
    );
  };
  if (pairing === undefined)
    return (
      <View style={styles.center}>
        <ActivityIndicator color={theme.accent} />
      </View>
    );
  if (pairing === null) return <Redirect href="/pair" />;
  return (
    <View style={[styles.screen, { backgroundColor: theme.bg }]}>
      <View style={[styles.intro, { borderBottomColor: theme.line }]}>
        <Text style={[styles.subtitle, { color: theme.dim }]}>Your conversations with Stem</Text>
        <ConnectionBadge />
      </View>
      <FlatList
        data={rows}
        keyExtractor={(chat) => chat.threadId}
        contentInsetAdjustmentBehavior="never"
        contentContainerStyle={{ paddingBottom: 96, flexGrow: rows.length ? undefined : 1 }}
        refreshControl={
          <RefreshControl
            refreshing={pulling}
            onRefresh={() => {
              setPulling(true);
              refresh();
            }}
            tintColor={theme.accent}
          />
        }
        ItemSeparatorComponent={() => (
          <View style={[styles.separator, { backgroundColor: theme.line }]} />
        )}
        ListHeaderComponent={
          error || list?.offline ? (
            <Text style={[styles.banner, { color: error ? theme.bad : theme.dim }]}>
              {error ?? 'Showing a saved copy — reconnect to get the latest conversations.'}
            </Text>
          ) : null
        }
        ListEmptyComponent={
          loading ? (
            <ActivityIndicator style={styles.empty} color={theme.accent} />
          ) : (
            <View style={styles.center}>
              <SymbolView name="bubble.left.and.bubble.right" size={44} tintColor={theme.accent} />
              <Text style={[styles.emptyTitle, { color: theme.text }]}>
                Start something with Stem
              </Text>
              <Text style={[styles.emptyText, { color: theme.dim }]}>
                Ask a question, explore an idea, or get something done.
              </Text>
            </View>
          )
        }
        renderItem={({ item: chat }) => {
          const unread = isUnread(chat, inbox, live.has(chat.threadId));
          const readAction = () => void toggleRead(chat, unread);
          return (
            <SwipeRow
              onLeft={[{ label: 'Delete', color: '#a93232', onPress: () => deleteChat(chat) }]}
              onRight={[
                {
                  label: unread ? 'Mark read' : 'Mark unread',
                  color: '#9a6230',
                  onPress: readAction
                }
              ]}
            >
              <Link href={{ pathname: '/thread/[id]', params: { id: chat.threadId } }} asChild>
                <Pressable
                  accessibilityRole="button"
                  accessibilityLabel={`${chat.subject ?? chat.title}${unread ? ', unread' : ''}`}
                  accessibilityActions={[
                    { name: 'delete', label: 'Delete chat' },
                    { name: 'read', label: unread ? 'Mark read' : 'Mark unread' }
                  ]}
                  onAccessibilityAction={(event) =>
                    event.nativeEvent.actionName === 'delete' ? deleteChat(chat) : readAction()
                  }
                  onLongPress={() =>
                    Alert.alert(chat.subject ?? chat.title, undefined, [
                      { text: unread ? 'Mark read' : 'Mark unread', onPress: readAction },
                      { text: 'Delete', style: 'destructive', onPress: () => deleteChat(chat) },
                      { text: 'Cancel', style: 'cancel' }
                    ])
                  }
                  style={styles.row}
                >
                  <View style={[styles.avatar, { backgroundColor: theme.accentSoft }]}>
                    <SymbolView name="bubble.left" size={22} tintColor={theme.accent} />
                  </View>
                  <View style={styles.rowText}>
                    <View style={styles.rowHeading}>
                      <Text
                        numberOfLines={1}
                        style={[
                          styles.title,
                          { color: theme.text, fontWeight: unread ? '700' : '500' }
                        ]}
                      >
                        {chat.subject ?? chat.title}
                      </Text>
                      <Text style={[styles.time, { color: theme.dim }]}>
                        {relativeTime(chat.updatedAt)}
                      </Text>
                    </View>
                    {chat.preview && previewLines > 0 ? (
                      <Text
                        numberOfLines={previewLines}
                        style={[styles.preview, { color: theme.dim }]}
                      >
                        {chat.preview}
                      </Text>
                    ) : null}
                  </View>
                  {live.has(chat.threadId) || unread ? (
                    <View
                      style={[
                        styles.dot,
                        { backgroundColor: live.has(chat.threadId) ? theme.live : theme.accent }
                      ]}
                    />
                  ) : null}
                </Pressable>
              </Link>
            </SwipeRow>
          );
        }}
      />
      <Link href="/new" asChild>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="New chat"
          style={{ ...styles.fab, backgroundColor: theme.accent }}
        >
          <SymbolView name="square.and.pencil" size={25} tintColor={theme.accentText} />
          <Text style={{ color: theme.accentText, fontWeight: '600', fontSize: 15 }}>New chat</Text>
        </Pressable>
      </Link>
    </View>
  );
}
const styles = StyleSheet.create({
  screen: { flex: 1 },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: 28, gap: 12 },
  intro: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 20,
    paddingBottom: 14,
    borderBottomWidth: StyleSheet.hairlineWidth
  },
  subtitle: { fontSize: 13 },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    paddingHorizontal: 18,
    paddingVertical: 17,
    minHeight: 80
  },
  avatar: {
    width: 42,
    height: 42,
    borderRadius: 14,
    alignItems: 'center',
    justifyContent: 'center'
  },
  rowText: { flex: 1, gap: 5 },
  rowHeading: { flexDirection: 'row', gap: 8, alignItems: 'center' },
  title: { fontSize: 16, flex: 1 },
  preview: { fontSize: 14, lineHeight: 20 },
  time: { fontSize: 11 },
  dot: { width: 7, height: 7, borderRadius: 4 },
  separator: { height: StyleSheet.hairlineWidth, marginLeft: 72 },
  banner: { padding: 16, fontSize: 13 },
  empty: { padding: 40 },
  emptyTitle: { fontSize: 22, fontWeight: '600', textAlign: 'center' },
  emptyText: { fontSize: 15, lineHeight: 23, textAlign: 'center', maxWidth: 280 },
  fab: {
    position: 'absolute',
    bottom: 20,
    right: 20,
    minHeight: 52,
    borderRadius: 26,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    paddingHorizontal: 20
  }
});
