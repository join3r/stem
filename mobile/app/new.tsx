import { Stack, useRouter } from 'expo-router';
import { SymbolView } from 'expo-symbols';
import { useCallback, useEffect, useRef, useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import type { TurnAttachment, MessageAttachment } from '@shared/types';
import { draftGeneration } from '../src/drafts/store';
import { seedSubmittedThread } from '../src/chat/submitted';
import { useDraft } from '../src/drafts/useDraft';
import { useChatPersonas } from '../src/hooks/useChatPersonas';
import { useTransport } from '../src/transport/provider';
import { DraftComposer } from '../src/ui/DraftComposer';
import { PersonaChips } from '../src/ui/PersonaChips';
import { useKeyboardInset } from '../src/ui/keyboard';
import { useTheme } from '../src/ui/theme';

export default function NewChatScreen() {
  const { connection, status } = useTransport();
  const theme = useTheme();
  const router = useRouter();
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  const keyboardInset = useKeyboardInset();
  const personas = useChatPersonas();
  const draftStore = useDraft('chat:new');
  const personaId =
    typeof draftStore.draft.metadata.personaId === 'string'
      ? draftStore.draft.metadata.personaId
      : null;
  const [handled, setHandled] = useState<{ input: string; reply: string } | null>(null);
  const blocked = !status.paired
    ? 'Pair this phone to send messages.'
    : status.unauthorized
      ? 'This phone’s pairing was rejected. Pair it again.'
      : null;
  const submit = useCallback(
    async (input: string, attachments?: TurnAttachment[]) => {
      const generation = draftGeneration();
      const result = await connection.rpc('backend:startTurn', {
        input,
        ...(personaId ? { personaId } : {}),
        ...(attachments?.length ? { attachments } : {})
      });
      if (generation !== draftGeneration()) return;
      if (result.canceled) throw new Error('The send was canceled. Your draft is saved.');
      if (result.threadId) {
        const display: MessageAttachment[] | undefined = attachments?.map((attachment) => ({
          kind: attachment.mime?.startsWith('image/') ? 'image' : 'file',
          name: attachment.name,
          mime: attachment.mime
        }));
        seedSubmittedThread(result.threadId, input, result.turnId ?? undefined, display);
        if (mounted.current)
          router.replace({
            pathname: '/thread/[id]',
            params: { id: result.threadId, ...(personaId ? { persona: personaId } : {}) }
          });
      } else {
        if (mounted.current) setHandled({ input, reply: result.assistantMessage ?? 'Done.' });
      }
    },
    [connection, personaId, router]
  );
  return (
    <View style={[styles.screen, { backgroundColor: theme.bg, paddingBottom: keyboardInset }]}>
      <Stack.Screen options={{ title: 'New chat' }} />
      <View style={styles.body}>
        {handled ? (
          <>
            <Text style={[styles.prompt, { backgroundColor: theme.accentSoft, color: theme.text }]}>
              {handled.input}
            </Text>
            <Text style={[styles.reply, { color: theme.text }]}>{handled.reply}</Text>
          </>
        ) : (
          <>
            <View style={[styles.mark, { backgroundColor: theme.accentSoft }]}>
              <SymbolView name="leaf" size={38} tintColor={theme.accent} />
            </View>
            <Text style={[styles.title, { color: theme.text }]}>What’s on your mind?</Text>
            <Text style={[styles.subtitle, { color: theme.dim }]}>
              A question, an idea, a task. Start here.
            </Text>
          </>
        )}
      </View>
      <DraftComposer
        draftKey="chat:new"
        onSend={submit}
        disabledReason={blocked}
        header={
          <PersonaChips
            personas={personas}
            selected={personaId}
            onSelect={(value) => draftStore.setMetadata({ personaId: value ?? '' })}
            theme={theme}
          />
        }
      />
    </View>
  );
}
const styles = StyleSheet.create({
  screen: { flex: 1 },
  body: { flex: 1, justifyContent: 'center', alignItems: 'center', padding: 24, gap: 16 },
  mark: { width: 78, height: 78, borderRadius: 25, alignItems: 'center', justifyContent: 'center' },
  title: { fontSize: 27, fontWeight: '600', textAlign: 'center' },
  subtitle: { fontSize: 16, lineHeight: 24, textAlign: 'center' },
  prompt: { alignSelf: 'flex-end', padding: 14, borderRadius: 18, fontSize: 16 },
  reply: { alignSelf: 'stretch', fontSize: 16, lineHeight: 24 }
});
