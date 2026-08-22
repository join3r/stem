// Settings — the home for everything that used to hide under the last chat row.
//
// The phone's settings are almost all facts, not choices: which server this
// phone is paired to, whether the stream is live, which device record it is.
// They are grouped iOS-style because that is the shape people expect facts to
// take here, and the one destructive action sits alone at the bottom where iOS
// puts destructive actions.
//
// Unpair keeps its honest copy from the old chat-list footer: the revoke is
// sent but not waited for (src/transport/unpair.ts), so a server that is
// offline — or gone for good, the usual reason to be here — keeps its record
// and the desk is the only place left to remove it.

import { Redirect, Stack } from 'expo-router';
import type { ReactElement, ReactNode } from 'react';
import { ActivityIndicator, Alert, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { useTransport } from '../../../src/transport/provider';
import { describeConnection } from '../../../src/ui/connection';
import { useTheme, type Theme } from '../../../src/ui/theme';

export default function SettingsScreen(): ReactElement {
  const { status, pairing, unpair } = useTransport();
  const theme = useTheme();

  if (pairing === undefined) {
    return (
      <View style={[styles.center, { backgroundColor: theme.bg }]}>
        <ActivityIndicator color={theme.dim} />
      </View>
    );
  }
  if (pairing === null) return <Redirect href="/pair" />;

  const connection = describeConnection(status);
  const toneColor = { live: theme.live, warn: theme.warn, bad: theme.bad, dim: theme.dim }[connection.tone];

  const askToUnpair = (): void => {
    Alert.alert(
      'Unpair this phone?',
      'The token is deleted from this device, and the server is asked to forget this phone. If it can’t be reached, remove this device in Settings → Devices on the desktop.',
      [
        { text: 'Cancel', style: 'cancel' },
        { text: 'Unpair', style: 'destructive', onPress: () => void unpair() }
      ]
    );
  };

  return (
    <ScrollView
      style={{ backgroundColor: theme.bg }}
      contentInsetAdjustmentBehavior="automatic"
      contentContainerStyle={styles.content}
    >
      <Stack.Screen options={{ title: 'Settings' }} />
      <Group label="Connection" theme={theme}>
        <Row theme={theme} label="Status">
          <View style={styles.status}>
            <View style={[styles.dot, { backgroundColor: toneColor }]} />
            <Text style={[styles.value, { color: toneColor }]}>{connection.label}</Text>
          </View>
        </Row>
        <Row theme={theme} label="Server">
          <Text numberOfLines={1} style={[styles.value, { color: theme.dim }]}>
            {pairing.serverUrl.replace(/^https?:\/\//, '')}
          </Text>
        </Row>
        <Row theme={theme} label="This device">
          <Text numberOfLines={1} style={[styles.value, { color: theme.dim }]}>
            {pairing.deviceId.slice(0, 8)}
          </Text>
        </Row>
      </Group>
      <Group theme={theme}>
        <Pressable onPress={askToUnpair} style={styles.rowPress}>
          <Text style={[styles.label, { color: theme.bad, fontWeight: '600' }]}>Unpair this phone</Text>
        </Pressable>
      </Group>
    </ScrollView>
  );
}

function Group({ label, theme, children }: { label?: string; theme: Theme; children: ReactNode }): ReactElement {
  return (
    <View style={styles.groupWrap}>
      {label ? <Text style={[styles.groupLabel, { color: theme.dim }]}>{label.toUpperCase()}</Text> : null}
      <View style={[styles.group, { backgroundColor: theme.card, borderColor: theme.line }]}>{children}</View>
    </View>
  );
}

function Row({ theme, label, children }: { theme: Theme; label: string; children: ReactNode }): ReactElement {
  return (
    <View style={[styles.row, { borderColor: theme.line }]}>
      <Text style={[styles.label, { color: theme.text }]}>{label}</Text>
      {children}
    </View>
  );
}

const styles = StyleSheet.create({
  center: { flex: 1, alignItems: 'center', justifyContent: 'center' },
  content: { padding: 16, gap: 22 },
  groupWrap: { gap: 6 },
  groupLabel: { fontSize: 12, letterSpacing: 0.6, marginLeft: 14 },
  group: { borderRadius: 12, borderWidth: StyleSheet.hairlineWidth, overflow: 'hidden' },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 12,
    paddingHorizontal: 14,
    paddingVertical: 12,
    borderTopWidth: StyleSheet.hairlineWidth,
    marginTop: -StyleSheet.hairlineWidth
  },
  rowPress: { alignItems: 'center', paddingHorizontal: 14, paddingVertical: 13 },
  label: { fontSize: 15 },
  value: { fontSize: 14, maxWidth: '60%' },
  status: { flexDirection: 'row', alignItems: 'center', gap: 7 },
  dot: { width: 8, height: 8, borderRadius: 4 }
});
