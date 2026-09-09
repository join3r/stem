import {
  forwardRef,
  useEffect,
  useImperativeHandle,
  useRef,
  useState,
  type ReactNode
} from 'react';
import { Alert, Pressable, ScrollView, Text, TextInput, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { SymbolView } from 'expo-symbols';
import * as DocumentPicker from 'expo-document-picker';
import * as ImagePicker from 'expo-image-picker';
import type { TurnAttachment } from '@shared/types';
import { submitDraft } from '../drafts/send';
import { useDraft } from '../drafts/useDraft';
import { useTransport } from '../transport/provider';
import { uploadAttachment } from '../transport/upload';
import { useTheme } from './theme';
import { useKeyboardVisible } from './keyboard';

export interface DraftComposerHandle {
  restore(text: string): void;
  focus(): void;
}
export interface DraftComposerProps {
  draftKey: string;
  onSend(body: string, attachments?: TurnAttachment[]): Promise<void>;
  placeholder?: string;
  disabledReason?: string | null;
  header?: ReactNode;
  submitLabel?: string;
  running?: boolean;
  onStop?: () => void;
  onSendingChange?: (sending: boolean) => void;
  onDraftChange?: (body: string, hasAttachments: boolean) => void;
}
export const DraftComposer = forwardRef<DraftComposerHandle, DraftComposerProps>(
  function DraftComposer(
    {
      draftKey,
      onSend,
      placeholder = 'Message Stem',
      disabledReason,
      header,
      submitLabel = 'Send',
      running,
      onStop,
      onDraftChange,
      onSendingChange
    },
    ref
  ) {
    const theme = useTheme();
    const insets = useSafeAreaInsets();
    const keyboardVisible = useKeyboardVisible();
    const { pairing, status } = useTransport();
    const store = useDraft(draftKey);
    const { draft } = store;
    const input = useRef<TextInput>(null);
    const sendLock = useRef(false);
    const [localSending, setSending] = useState(false);
    const sending = localSending || store.sending;
    const [progress, setProgress] = useState('');
    const [error, setError] = useState<string | null>(null);
    const alive = useRef(true);
    useEffect(() => {
      alive.current = true;
      return () => {
        alive.current = false;
      };
    }, []);
    useEffect(() => {
      onDraftChange?.(draft.body, draft.attachments.length > 0);
    }, [draft.body, draft.attachments.length, onDraftChange]);
    useImperativeHandle(ref, () => ({
      restore(text) {
        if (!draft.body && !draft.attachments.length) store.setBody(text);
        input.current?.focus();
      },
      focus() {
        input.current?.focus();
      }
    }));
    const reason =
      disabledReason ||
      (!status.reachable ? 'Offline — your draft is saved. Send when connected.' : null);
    const [picking, setPicking] = useState(false);
    const pickerLock = useRef(false);
    const canSend =
      store.ready &&
      !store.error &&
      !sending &&
      !picking &&
      !running &&
      !reason &&
      (!!draft.body.trim() || draft.attachments.length > 0);
    async function pick(kind: 'photo' | 'file') {
      if (pickerLock.current || sending) return;
      pickerLock.current = true; setPicking(true);
      try {
        if (kind === 'photo') {
          const result = await ImagePicker.launchImageLibraryAsync({
            mediaTypes: ['images'],
            allowsMultipleSelection: true,
            quality: 1
          });
          if (!result.canceled)
            for (const asset of result.assets)
              await store.addAttachment({
                uri: asset.uri,
                name: asset.fileName ?? `photo-${Date.now()}.jpg`,
                mime: asset.mimeType ?? 'image/jpeg',
                size: asset.fileSize
              });
        } else {
          const result = await DocumentPicker.getDocumentAsync({
            multiple: true,
            copyToCacheDirectory: true
          });
          if (!result.canceled)
            for (const asset of result.assets)
              await store.addAttachment({
                uri: asset.uri,
                name: asset.name,
                mime: asset.mimeType,
                size: asset.size
              });
        }
      } catch (e) {
        if (alive.current) setError(e instanceof Error ? e.message : 'The attachment could not be added.');
      } finally { pickerLock.current = false; if (alive.current) setPicking(false); }
    }
    async function send() {
      if (!canSend || !pairing || sendLock.current || pickerLock.current) return;
      sendLock.current = true;
      onSendingChange?.(true);
      let lease: ReturnType<typeof store.beginSend>;
      try {
        lease = store.beginSend();
      } catch {
        sendLock.current = false;
        onSendingChange?.(false);
        return;
      }
      setSending(true);
      setError(null);
      try {
        await submitDraft({
          lease,
          body: draft.body,
          attachments: draft.attachments,
          upload: (attachment) => uploadAttachment(pairing, attachment),
          send: onSend,
          progress: (message) => {
            if (alive.current) setProgress(message);
          }
        });
        try {
          lease.finish(true);
        } catch {
          if (alive.current)
            setError(
              'Sent successfully, but the local draft could not be cleared. Discard it before composing again.'
            );
        }
      } catch (e) {
        if (alive.current)
          setError(e instanceof Error ? e.message : 'Send was not confirmed. Your draft is saved.');
      } finally {
        lease.finish(false);
        sendLock.current = false;
        onSendingChange?.(false);
        if (alive.current) setSending(false);
      }
    }
    return (
      <View
        style={{
          padding: 12,
          paddingBottom: keyboardVisible ? 12 : Math.max(12, insets.bottom),
          gap: 8,
          backgroundColor: theme.bg,
          borderTopWidth: 1,
          borderTopColor: theme.line
        }}
      >
        {header}
        {!!draft.attachments.length && (
          <ScrollView horizontal contentContainerStyle={{ gap: 8 }}>
            {draft.attachments.map((attachment) => (
              <Pressable
                key={attachment.id}
                disabled={sending || picking}
                accessibilityRole="button"
                accessibilityLabel={`Remove attachment ${attachment.name}`}
                onPress={() => store.removeAttachment(attachment.id)}
                style={{ padding: 10, backgroundColor: theme.card, borderRadius: 12 }}
              >
                <Text style={{ color: theme.text }}>{attachment.name} ×</Text>
              </Pressable>
            ))}
          </ScrollView>
        )}
        <View style={{ flexDirection: 'row', alignItems: 'flex-end', gap: 8 }}>
          <Pressable
            disabled={sending || picking || !store.ready || !!store.error}
            accessibilityRole="button"
            accessibilityLabel="Add attachment"
            onPress={() =>
              Alert.alert('Add attachment', undefined, [
                { text: 'Photos', onPress: () => void pick('photo') },
                { text: 'Files', onPress: () => void pick('file') },
                { text: 'Cancel', style: 'cancel' }
              ])
            }
            style={{
              minWidth: 44,
              minHeight: 44,
              alignItems: 'center',
              justifyContent: 'center',
              borderRadius: 22,
              backgroundColor: theme.card
            }}
          >
            <SymbolView name="paperclip" tintColor={theme.accent} size={22} />
          </Pressable>
          <TextInput
            ref={input}
            value={draft.body}
            onChangeText={(body) => {
              try {
                store.setBody(body);
              } catch (e) {
                setError(e instanceof Error ? e.message : 'Your draft could not be saved.');
              }
            }}
            editable={!sending && store.ready && !store.error}
            multiline
            placeholder={placeholder}
            placeholderTextColor={theme.dim}
            accessibilityLabel={placeholder}
            style={{
              flex: 1,
              minHeight: 44,
              maxHeight: 160,
              padding: 12,
              borderRadius: 22,
              color: theme.text,
              backgroundColor: theme.card,
              fontSize: 16
            }}
          />
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={running ? 'Stop response' : submitLabel}
            disabled={running ? !onStop : !canSend}
            onPress={running ? onStop : () => void send()}
            style={{
              minHeight: 44,
              paddingHorizontal: 16,
              borderRadius: 22,
              justifyContent: 'center',
              backgroundColor: theme.accent,
              opacity: running || canSend ? 1 : 0.5
            }}
          >
            <Text style={{ color: theme.accentText, fontWeight: '600' }}>
              {running ? 'Stop' : sending ? 'Sending…' : submitLabel}
            </Text>
          </Pressable>
        </View>
        {sending && !!progress && <Text style={{ color: theme.dim }}>{progress}</Text>}
        {!sending && !picking &&
          (!!store.error ||
            !!draft.body ||
            draft.attachments.length > 0 ||
            Object.values(draft.metadata).some(Boolean)) && (
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="Discard draft"
              style={{ minHeight: 44, justifyContent: 'center', alignSelf: 'flex-end' }}
              onPress={() =>
                Alert.alert(
                  'Discard draft?',
                  'The message and attached files will be removed from this device.',
                  [
                    { text: 'Cancel', style: 'cancel' },
                    {
                      text: 'Discard',
                      style: 'destructive',
                      onPress: () => {
                        try {
                          store.clear();
                          setError(null);
                        } catch {
                          setError('The draft could not be discarded.');
                        }
                      }
                    }
                  ]
                )
              }
            >
              <Text style={{ color: theme.dim }}>Discard draft</Text>
            </Pressable>
          )}
        {!!store.error && (
          <Text accessibilityRole="alert" style={{ color: theme.bad }}>
            {store.error}
          </Text>
        )}
        {!!error && (
          <Text accessibilityRole="alert" style={{ color: theme.bad }}>
            {error}
          </Text>
        )}
        {!!reason && <Text style={{ color: theme.dim, fontSize: 12 }}>{reason}</Text>}
      </View>
    );
  }
);
