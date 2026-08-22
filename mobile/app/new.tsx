// Starting a conversation from the phone.
//
// A composer and nothing else, because the server already knows how to do the
// rest: `backend:startTurn` without a threadId opens a fresh thread implicitly —
// the same path the desktop's main window takes — so there is no draft state to
// migrate and no thread to pre-create. The moment the send lands, this screen is
// *replaced* (not pushed over) by the real thread, which hydrates and follows
// the stream like any other; Back from there is the chat list, not a spent
// compose form.
//
// The one answer that does not become a thread to open is `handled` without a
// threadId — the backend absorbed the input itself (a remembered fact) and there
// is nothing to navigate to, so its reply is shown right here instead.

import { Stack, useRouter } from 'expo-router';
import { useCallback, useState, type ReactElement } from 'react';
import {
  ActivityIndicator,
  KeyboardAvoidingView,
  Platform,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  View
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import type { StartTurnResult } from '@shared/types';
import { useTransport } from '../src/transport/provider';
import { useKeyboardVisible } from '../src/ui/keyboard';
import { useTheme } from '../src/ui/theme';

export default function NewChatScreen(): ReactElement {
  const { connection, status } = useTransport();
  const theme = useTheme();
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const keyboardUp = useKeyboardVisible();

  const [draft, setDraft] = useState('');
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [handled, setHandled] = useState<string | null>(null);

  // The same three reasons the thread composer refuses, for the same reason
  // there is no offline queue: a message accepted here would exist nowhere else.
  const blocked = !status.paired
    ? 'This phone is not paired with a server.'
    : status.unauthorized
      ? 'This phone’s pairing was rejected. Pair it again.'
      : !status.reachable
        ? 'Offline — messages can’t be sent from here.'
        : null;

  const submit = useCallback(async () => {
    const input = draft.trim();
    if (!input || sending) return;
    setSending(true);
    setError(null);
    setHandled(null);
    try {
      const result: StartTurnResult = await connection.rpc('backend:startTurn', { input });
      if (result.threadId) {
        router.replace({ pathname: '/thread/[id]', params: { id: result.threadId } });
        return;
      }
      setDraft('');
      setHandled(result.assistantMessage ?? 'Done — nothing more to show.');
    } catch (e) {
      setError(String((e as Error)?.message ?? e));
    } finally {
      setSending(false);
    }
  }, [connection, draft, router, sending]);

  const canSend = draft.trim().length > 0 && !sending && !blocked;

  return (
    <KeyboardAvoidingView
      style={[styles.screen, { backgroundColor: theme.bg }]}
      behavior={Platform.OS === 'ios' ? 'padding' : undefined}
      keyboardVerticalOffset={Platform.OS === 'ios' ? 96 : 0}
    >
      <Stack.Screen options={{ title: 'New chat' }} />
      <View style={styles.body}>
        <TextInput
          style={[styles.input, { color: theme.text }]}
          value={draft}
          onChangeText={setDraft}
          placeholder={blocked ?? 'What do you want done?'}
          placeholderTextColor={theme.dim}
          editable={!blocked && !sending}
          autoFocus
          multiline
        />
        {handled ? <Text style={[styles.note, { color: theme.dim }]}>{handled}</Text> : null}
        {error ? <Text style={[styles.note, { color: theme.bad }]}>{error}</Text> : null}
      </View>
      <View
        style={[
          styles.footer,
          { borderColor: theme.line },
          { paddingBottom: keyboardUp ? 10 : Math.max(insets.bottom, 12) }
        ]}
      >
        {blocked ? <Text style={[styles.blocked, { color: theme.warn }]}>{blocked}</Text> : null}
        <Pressable
          onPress={() => void submit()}
          disabled={!canSend}
          style={[styles.send, { backgroundColor: canSend ? theme.accent : theme.line }]}
        >
          {sending ? (
            <ActivityIndicator color="#ffffff" />
          ) : (
            <Text style={[styles.sendText, !canSend && { color: theme.dim }]}>Send</Text>
          )}
        </Pressable>
      </View>
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1 },
  body: { flex: 1, paddingHorizontal: 16, paddingTop: 12, gap: 10 },
  input: { flex: 1, fontSize: 17, lineHeight: 24, textAlignVertical: 'top' },
  note: { fontSize: 14, lineHeight: 20, paddingBottom: 8 },
  footer: { borderTopWidth: StyleSheet.hairlineWidth, paddingHorizontal: 12, paddingTop: 8, gap: 6 },
  blocked: { fontSize: 12, paddingHorizontal: 2 },
  send: { borderRadius: 18, paddingVertical: 11, alignItems: 'center' },
  sendText: { fontSize: 15, fontWeight: '600', color: '#ffffff' }
});
