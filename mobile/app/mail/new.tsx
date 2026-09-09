import { Stack, useRouter } from 'expo-router';
import { useEffect, useRef } from 'react';
import { Pressable, ScrollView, Switch, Text, TextInput, View } from 'react-native';
import { useKeyboardInset } from '../../src/ui/keyboard';
import { useMail } from '../../src/mail/useMail';
import { useDraft } from '../../src/drafts/useDraft';
import { DraftComposer } from '../../src/ui/DraftComposer';
import { useTheme } from '../../src/ui/theme';
import { useTransport } from '../../src/transport/provider';

const DRAFT_KEY = 'mail:new';
export default function NewMail() {
  const theme = useTheme();
  const router = useRouter();
  const api = useMail();
  const { status, pairing } = useTransport();
  const account = useRef(pairing?.deviceId);
  account.current = pairing?.deviceId;
  const { draft, ready, error: draftError, setMetadata, sending } = useDraft(DRAFT_KEY);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  const keyboardInset = useKeyboardInset();
  let to: string[] = ['normal'];
  try {
    const parsed: unknown = JSON.parse(String(draft.metadata.to ?? '["normal"]'));
    if (Array.isArray(parsed)) to = parsed.filter((v): v is string => typeof v === 'string');
  } catch {
    /* An invalid optional preference uses Stem as the recipient. */
  }
  const subject = String(draft.metadata.subject ?? '');
  const isPrivate = draft.metadata.private === true;
  const header = (
    <View style={{ gap: 16, paddingBottom: 14 }}>
      <Text style={{ color: theme.accent, fontSize: 12, fontWeight: '700', letterSpacing: 2 }}>
        STEM MAIL
      </Text>
      <Text style={{ color: theme.text, fontWeight: '600' }}>To</Text>
      <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8 }}>
        {api.personas.map((p) => (
          <Pressable
            key={p.id}
            accessibilityRole="checkbox"
            accessibilityState={{ checked: to.includes(p.id) }}
            disabled={!ready || sending}
            onPress={() =>
              setMetadata({
                ...draft.metadata,
                to: JSON.stringify(
                  to.includes(p.id) ? to.filter((id) => id !== p.id) : [...to, p.id]
                )
              })
            }
            style={{
              padding: 12,
              borderRadius: 18,
              backgroundColor: to.includes(p.id) ? theme.accent : theme.card
            }}
          >
            <Text style={{ color: to.includes(p.id) ? theme.bg : theme.text }}>
              {p.name}
              {to[0] === p.id ? ' · lead' : ''}
            </Text>
          </Pressable>
        ))}
      </View>
      <Text style={{ color: theme.dim, fontSize: 12 }}>
        The first selected persona leads the conversation. An empty To list sends to Stem.
      </Text>
      {draftError && <Text style={{ color: theme.bad }}>{draftError}</Text>}
      {api.error && <Text style={{ color: theme.bad }}>{api.error}</Text>}
      <TextInput
        accessibilityLabel="Subject"
        placeholder="Subject (optional)"
        placeholderTextColor={theme.dim}
        value={subject}
        editable={ready && !sending}
        onChangeText={(value) => setMetadata({ ...draft.metadata, subject: value })}
        style={{
          color: theme.text,
          backgroundColor: theme.card,
          borderRadius: 12,
          padding: 14,
          fontSize: 17
        }}
      />
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 12 }}>
        <View style={{ flex: 1 }}>
          <Text style={{ color: theme.text }}>Private conversation</Text>
          <Text style={{ color: theme.dim, fontSize: 12 }}>
            Excluded from Recall and persona memory
          </Text>
        </View>
        <Switch
          accessibilityLabel="Private conversation"
          disabled={!ready || sending}
          value={isPrivate}
          onValueChange={(value) => setMetadata({ ...draft.metadata, private: value })}
          trackColor={{ true: theme.accent }}
        />
      </View>
    </View>
  );
  return (
    <View style={{ flex: 1, backgroundColor: theme.bg, paddingBottom: keyboardInset }}>
      <Stack.Screen options={{ title: 'New mail' }} />
      <ScrollView keyboardShouldPersistTaps="handled" contentContainerStyle={{ padding: 18 }}>
        {header}
      </ScrollView>
      <DraftComposer
        draftKey={DRAFT_KEY}
        placeholder="Write your mail…"
        submitLabel="Send mail"
        disabledReason={
          !status.reachable
            ? 'Offline — your draft is saved. Send when connected.'
            : !ready
              ? 'Loading draft…'
              : undefined
        }
        onSend={async (body, attachments) => {
          const sendingAccount = account.current;
          const result = await api.compose({ to, subject, body, private: isPrivate, attachments });
          // compose returns the atomic snapshot whose last item is our new mail.
          const last = result.items[result.items.length - 1];
          const created =
            last?.from === 'user'
              ? result.conversations.find((c) => c.id === last.conversationId)
              : undefined;
          if (!mounted.current || account.current !== sendingAccount) return;
          if (created) router.replace({ pathname: '/mail/[id]', params: { id: created.id } });
          else router.replace('/inbox');
        }}
      />
    </View>
  );
}
