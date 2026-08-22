// Pairing: the one screen this app has before it has a server.
//
// Two ways in, and they end in the same call. The QR is the one people will
// actually use — Settings → Devices on the desktop renders a
// `stem://pair?url=…&code=…` code (step 3 of the Phase 4 plan) and the camera
// reads it — and the typed form is the fallback for when the desktop is a VPS
// with no screen next to you, or the camera is refused. Neither is privileged:
// the QR fills in exactly the two fields the form has, so a scan that produces
// something surprising is visible before it is spent.
//
// A pairing code is one-shot and lives ten minutes (src/server/transport/
// pairing.ts), and eight consecutive failures lock the route for fifteen. That
// is why this screen shows the server's own refusal text rather than a friendly
// paraphrase: "that code has expired" and "too many attempts" call for different
// actions, and only the server knows which happened.

import { CameraView, useCameraPermissions } from 'expo-camera';
import { Redirect, Stack, useLocalSearchParams } from 'expo-router';
import { useCallback, useEffect, useRef, useState, type ReactElement } from 'react';
import {
  ActivityIndicator,
  KeyboardAvoidingView,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View
} from 'react-native';
import {
  parsePairPayload,
  PAIRING_CODE_LENGTH,
  normalizePairingCode,
  normalizeServerUrl,
  pairingCodeProblem,
  serverUrlProblem
} from '../src/transport/pairing';
import { useTransport } from '../src/transport/provider';
import { createScanLatch } from '../src/ui/scan-latch';
import { useTheme } from '../src/ui/theme';

export default function PairScreen(): ReactElement {
  const { pairing, pair } = useTransport();
  const theme = useTheme();
  const [serverUrl, setServerUrl] = useState('');
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [scanning, setScanning] = useState(false);
  const [permission, requestPermission] = useCameraPermissions();
  // The camera calls back per frame; this is what makes one code one submission.
  // See ../src/ui/scan-latch.ts for why it cannot be state.
  const latch = useRef(createScanLatch()).current;

  // The third way in: the app was OPENED with `stem://pair?url=…&code=…` — the
  // iOS camera app read the desktop's QR before Stem was ever in front. Same
  // payload, same names (see parsePairPayload), same one-shot behavior as the
  // in-app scan: fill both fields so what is being spent is visible, then spend
  // it. The ref makes one launch one attempt — a failure leaves the filled form
  // and the server's refusal, not a retry loop against a spent code.
  const params = useLocalSearchParams<{ url?: string; serverUrl?: string; code?: string }>();
  const linkSpent = useRef(false);

  const submit = useCallback(
    async (url: string, pairingCode: string) => {
      setBusy(true);
      setError(null);
      try {
        await pair(url, pairingCode);
        // No navigation here: `pairing` becomes non-null, and the redirect below
        // is what leaves the screen. One way out, so a failed store cannot leave
        // the app on the chat list with no credential.
      } catch (e) {
        setError(String((e as Error)?.message ?? e));
      } finally {
        setBusy(false);
      }
    },
    [pair]
  );

  useEffect(() => {
    const url = normalizeServerUrl(params.url ?? params.serverUrl ?? '');
    const linkCode = normalizePairingCode(params.code ?? '');
    if (!url && !linkCode) return;
    if (linkSpent.current) return;
    linkSpent.current = true;
    setServerUrl(url);
    setCode(linkCode);
    if (!serverUrlProblem(url) && !pairingCodeProblem(linkCode)) void submit(url, linkCode);
  }, [params.url, params.serverUrl, params.code, submit]);

  const openScanner = useCallback(async () => {
    setError(null);
    if (!permission?.granted) {
      const granted = await requestPermission();
      if (!granted.granted) {
        setError('Stem cannot open the camera. Type the address and code instead, or allow the camera in Settings.');
        return;
      }
    }
    latch.reset();
    setScanning(true);
  }, [latch, permission?.granted, requestPermission]);

  const onScan = useCallback(
    (data: string) => {
      const target = parsePairPayload(data);
      // A camera pointed at the world sees a great many barcodes; anything that
      // is not a Stem pairing link is simply not this, and the scanner keeps
      // looking rather than complaining.
      if (!target) return;
      // The first frame carrying a readable code wins; the rest of the burst is
      // the same code again, and spending it twice costs a pairing attempt.
      if (!latch.accept()) return;
      setScanning(false);
      setServerUrl(target.serverUrl);
      setCode(target.code);
      void submit(target.serverUrl, target.code);
    },
    [latch, submit]
  );

  if (pairing) return <Redirect href="/" />;

  if (scanning) {
    return (
      <View style={styles.scanner}>
        <Stack.Screen options={{ title: 'Scan the code', headerRight: () => <CancelScan onPress={() => setScanning(false)} /> }} />
        <CameraView
          style={StyleSheet.absoluteFill}
          barcodeScannerSettings={{ barcodeTypes: ['qr'] }}
          onBarcodeScanned={(result) => onScan(result.data)}
        />
        <View style={styles.scannerHint}>
          <Text style={styles.scannerHintText}>Point the camera at the QR code in Settings → Devices.</Text>
        </View>
      </View>
    );
  }

  const canSubmit = !busy && serverUrl.trim().length > 0 && normalizePairingCode(code).length === PAIRING_CODE_LENGTH;

  return (
    <KeyboardAvoidingView
      style={[styles.screen, { backgroundColor: theme.bg }]}
      behavior={Platform.OS === 'ios' ? 'padding' : undefined}
    >
      <Stack.Screen options={{ title: 'Pair with Stem' }} />
      <ScrollView contentContainerStyle={styles.body} keyboardShouldPersistTaps="handled">
        <Text style={[styles.lede, { color: theme.dim }]}>
          On your desktop, open Settings → Devices and choose “Pair a phone”. Scan the code it shows, or type what is
          under it.
        </Text>

        <Pressable
          onPress={() => void openScanner()}
          style={[styles.primary, { backgroundColor: theme.accent, opacity: busy ? 0.5 : 1 }]}
          disabled={busy}
        >
          <Text style={styles.primaryText}>Scan the QR code</Text>
        </Pressable>

        <Text style={[styles.divider, { color: theme.dim }]}>or type it</Text>

        <Text style={[styles.label, { color: theme.dim }]}>Server address</Text>
        <TextInput
          value={serverUrl}
          onChangeText={setServerUrl}
          placeholder="https://stem.example.com"
          placeholderTextColor={theme.dim}
          autoCapitalize="none"
          autoCorrect={false}
          keyboardType="url"
          inputMode="url"
          editable={!busy}
          style={[styles.input, { color: theme.text, backgroundColor: theme.card, borderColor: theme.line }]}
        />

        <Text style={[styles.label, { color: theme.dim }]}>Pairing code</Text>
        <TextInput
          value={code}
          // Normalized as it is typed, so what is on screen is what the server
          // will hash: the dash the desktop shows falls away by itself.
          onChangeText={(next) => setCode(normalizePairingCode(next))}
          placeholder="ABCD EFGH"
          placeholderTextColor={theme.dim}
          autoCapitalize="characters"
          autoCorrect={false}
          maxLength={PAIRING_CODE_LENGTH}
          editable={!busy}
          style={[styles.input, styles.codeInput, { color: theme.text, backgroundColor: theme.card, borderColor: theme.line }]}
        />

        {error ? <Text style={[styles.error, { color: theme.bad }]}>{error}</Text> : null}

        <Pressable
          onPress={() => void submit(serverUrl, code)}
          disabled={!canSubmit}
          style={[styles.primary, { backgroundColor: theme.accent, opacity: canSubmit ? 1 : 0.4 }]}
        >
          {busy ? <ActivityIndicator color="#fff" /> : <Text style={styles.primaryText}>Pair</Text>}
        </Pressable>
      </ScrollView>
    </KeyboardAvoidingView>
  );
}

function CancelScan({ onPress }: { onPress: () => void }): ReactElement {
  const theme = useTheme();
  return (
    <Pressable onPress={onPress} hitSlop={8}>
      <Text style={{ color: theme.accent, fontSize: 15 }}>Cancel</Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1 },
  body: { padding: 20, gap: 12 },
  lede: { fontSize: 14, lineHeight: 20, marginBottom: 8 },
  label: { fontSize: 12, textTransform: 'uppercase', letterSpacing: 0.6, marginTop: 8 },
  input: { borderWidth: StyleSheet.hairlineWidth, borderRadius: 10, paddingHorizontal: 12, paddingVertical: 12, fontSize: 16 },
  codeInput: { letterSpacing: 4, fontSize: 20 },
  primary: { borderRadius: 12, paddingVertical: 14, alignItems: 'center', marginTop: 12 },
  primaryText: { color: '#ffffff', fontSize: 16, fontWeight: '600' },
  divider: { textAlign: 'center', fontSize: 12, marginTop: 4 },
  error: { fontSize: 13, lineHeight: 18, marginTop: 8 },
  scanner: { flex: 1, backgroundColor: '#000' },
  scannerHint: { position: 'absolute', left: 0, right: 0, bottom: 48, alignItems: 'center', paddingHorizontal: 32 },
  scannerHintText: { color: '#fff', fontSize: 14, textAlign: 'center' }
});
