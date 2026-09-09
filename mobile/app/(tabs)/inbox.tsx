import { Stack, useRouter } from 'expo-router';
import { useEffect, useState } from 'react';
import { Alert, FlatList, Pressable, RefreshControl, ScrollView, Text, View, useWindowDimensions } from 'react-native';
import { nextWakeAt } from '@shared/inbox';
import { mailPreviewText } from '@shared/mail-subject';
import {
  MAIL_FOLDERS,
  mailName,
  mailPreview,
  mailSections,
  mailSubject,
  mailUnread,
  statusLabel,
  type MailFolder
} from '../../src/mail/list';
import { useMail } from '../../src/mail/useMail';
import { chooseSnooze, confirmMailDelete, mailAction } from '../../src/mail/actions';
import { useTransport } from '../../src/transport/provider';
import { SwipeRow } from '../../src/ui/SwipeRow';
import { useTheme } from '../../src/ui/theme';
import { relativeTime } from '../../src/ui/time';

export default function Inbox() {
  const theme = useTheme();
  const router = useRouter();
  const { status } = useTransport();
  const api = useMail();
  const { fontScale } = useWindowDimensions();
  const [pulling, setPulling] = useState(false);
  const [folder, setFolder] = useState<MailFolder>('inbox');
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const next = nextWakeAt(api.mail.conversations.map(mailSubject), api.mail.inbox, now);
    if (next === null) return;
    const timer = setTimeout(
      () => setNow(Date.now()),
      Math.min(2_147_483_647, Math.max(1, next - Date.now()))
    );
    return () => clearTimeout(timer);
  }, [api.mail, now]);
  const sections = mailSections(api.mail, now);
  return (
    <View style={{ flex: 1, backgroundColor: theme.bg }}>
      <Stack.Screen
        options={{
          title: 'Inbox',
          headerRight: () => (
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="New mail"
              onPress={() => router.push('/mail/new')}
              style={{ padding: 12 }}
            >
              <Text style={{ color: theme.accent, fontWeight: '600' }}>Compose</Text>
            </Pressable>
          )
        }}
      />
      <View style={{ paddingHorizontal: 20, paddingTop: 12 }}>
        <Text style={{ color: theme.accent, fontSize: 12, fontWeight: '700', letterSpacing: 2 }}>
          STEM MAIL
        </Text>
        <Text style={{ color: theme.dim, marginTop: 6 }}>Conversations with your personas</Text>
      </View>
      <ScrollView
        horizontal
        // Reserve the full scaled line plus padding; the list must not shrink
        // this horizontal viewport below its labels' intrinsic height.
        style={{ flexGrow: 0, flexShrink: 0, height: Math.max(44, Math.ceil(20 * fontScale) + 20), marginVertical: 12 }}
        contentContainerStyle={{ paddingHorizontal: 16, gap: 8, alignItems: 'center' }}
        contentInsetAdjustmentBehavior="never"
        automaticallyAdjustContentInsets={false}
        showsHorizontalScrollIndicator={false}
      >
        {MAIL_FOLDERS.map((value) => (
          <Pressable
            key={value}
            accessibilityRole="tab"
            accessibilityState={{ selected: folder === value }}
            onPress={() => {
              setFolder(value);
              setNow(Date.now());
            }}
            style={{
              paddingHorizontal: 14,
              paddingVertical: 10,
              minHeight: 44,
              justifyContent: 'center',
              borderRadius: 18,
              backgroundColor: folder === value ? theme.accent : theme.card
            }}
          >
            <Text
              style={{
                color: folder === value ? theme.bg : theme.text,
                fontSize: 14,
                lineHeight: 20,
                fontWeight: '600',
                textTransform: 'capitalize'
              }}
            >
              {value}
              {value === 'inbox' && sections.inbox.length ? ` · ${sections.inbox.length}` : ''}
            </Text>
          </Pressable>
        ))}
      </ScrollView>
      {api.error && (
        <Pressable
          accessibilityRole="button"
          onPress={() => void api.refresh()}
          style={{ padding: 16 }}
        >
          <Text style={{ color: theme.bad }}>{api.error} · Tap to retry</Text>
        </Pressable>
      )}
      <FlatList
        data={sections[folder]}
        keyExtractor={(c) => c.id}
        contentInsetAdjustmentBehavior="never"
        automaticallyAdjustContentInsets={false}
        refreshControl={
          <RefreshControl
            // Background/focus sync must never activate UIRefreshControl: iOS
            // can retain its top inset when the tab is detached mid-refresh.
            refreshing={pulling}
            tintColor={theme.accent}
            onRefresh={() => {
              setPulling(true);
              setNow(Date.now());
              void api.refresh().finally(() => setPulling(false));
            }}
          />
        }
        ListEmptyComponent={
          <View style={{ padding: 32, gap: 12 }}>
            <Text style={{ color: theme.text, fontSize: 23, fontWeight: '600' }}>
              {api.loading
                ? 'Loading mail…'
                : folder === 'inbox'
                  ? 'You’re all caught up'
                  : `No ${folder} mail`}
            </Text>
            <Text style={{ color: theme.dim }}>
              {status.paired
                ? 'Compose a mail to give a persona something to work on.'
                : 'Pair with your Stem server in Settings to read mail.'}
            </Text>
          </View>
        }
        renderItem={({ item: c }) => {
          const unread = mailUnread(c, api.mail);
          const preview = mailPreview(api.mail, c.id);
          const archive = () => mailAction(() => api.archive([c.id], folder !== 'archived'));
          const snooze = () =>
            chooseSnooze(
              (until) => api.snooze([c.id], until),
              api.mail.inbox.entries[c.id]?.snoozedUntil
            );
          const read = () => mailAction(() => api.setRead([c.id], !unread));
          const menu = () =>
            Alert.alert(c.subject || 'Mail', undefined, [
              { text: 'Cancel', style: 'cancel' },
              { text: unread ? 'Mark read' : 'Mark unread', onPress: read },
              { text: folder === 'archived' ? 'Move to Inbox' : 'Archive', onPress: archive },
              { text: 'Snooze', onPress: snooze },
              {
                text: 'Delete',
                style: 'destructive',
                onPress: () => confirmMailDelete(() => api.remove(c.id))
              }
            ]);
          return (
            <SwipeRow
              backgroundColor={theme.bg}
              onLeft={[
                {
                  label: folder === 'archived' ? 'Unarchive' : 'Archive',
                  color: theme.accent,
                  onPress: archive
                },
                { label: 'Snooze', color: theme.warn, onPress: snooze }
              ]}
              onRight={[{ label: unread ? 'Read' : 'Unread', color: theme.live, onPress: read }]}
            >
              <Pressable
                accessibilityRole="button"
                accessibilityLabel={`${c.subject}, ${unread ? 'unread, ' : ''}${statusLabel(c)}`}
                accessibilityActions={[{ name: 'showMenu', label: 'Mail actions' }]}
                onAccessibilityAction={menu}
                onLongPress={menu}
                onPress={() => router.push({ pathname: '/mail/[id]', params: { id: c.id } })}
                style={{
                  padding: 18,
                  borderBottomWidth: 1,
                  borderColor: theme.line,
                  backgroundColor: theme.bg,
                  gap: 5
                }}
              >
                <View style={{ flexDirection: 'row', gap: 8, alignItems: 'center' }}>
                  <View
                    style={{
                      width: 7,
                      height: 7,
                      borderRadius: 4,
                      backgroundColor: unread ? theme.accent : 'transparent'
                    }}
                  />
                  <Text style={{ color: theme.accent, flex: 1, fontWeight: '600' }}>
                    {preview
                      ? mailName(api.personas, preview.from)
                      : c.participants.map((id) => mailName(api.personas, id)).join(', ')}
                  </Text>
                  <Text style={{ color: theme.dim, fontSize: 12 }}>
                    {relativeTime(c.updatedAt / 1000)}
                  </Text>
                  <Pressable
                    accessibilityRole="button"
                    accessibilityLabel={`Actions for ${c.subject}`}
                    onPress={menu}
                    hitSlop={8}
                    style={{ padding: 8 }}
                  >
                    <Text style={{ color: theme.dim }}>•••</Text>
                  </Pressable>
                </View>
                <Text
                  numberOfLines={2}
                  style={{ color: theme.text, fontSize: 17, fontWeight: unread ? '700' : '500' }}
                >
                  {c.subject || 'No subject'}
                </Text>
                <Text numberOfLines={2} style={{ color: theme.dim }}>
                  {mailPreviewText(preview?.body ?? '') ||
                    (preview?.attachments?.length ? 'Attachment' : 'No messages yet')}
                </Text>
                {!!statusLabel(c) && (
                  <Text
                    style={{
                      color: c.status === 'failed' ? theme.bad : theme.accent,
                      fontSize: 12
                    }}
                  >
                    {statusLabel(c)}
                  </Text>
                )}
                {folder === 'snoozed' && (
                  <Text style={{ color: theme.dim, fontSize: 12 }}>
                    Until{' '}
                    {new Date(api.mail.inbox.entries[c.id]?.snoozedUntil ?? 0).toLocaleString()}
                  </Text>
                )}
              </Pressable>
            </SwipeRow>
          );
        }}
      />
    </View>
  );
}
