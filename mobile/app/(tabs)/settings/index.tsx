// Settings — the server's settings, editable from the phone, plus the two
// things that are this phone's own: what it is paired to, and unpairing it.
//
// The rows come from src/settings/registry.ts; this screen renders whatever
// that list says is available on a phone and knows nothing about any single
// setting. Every save answers with the full saved document, so the screen
// replaces its state with the server's version instead of guessing.
//
// Styled like the chat list, not like grouped iOS cards: edge-to-edge rows on
// the background, hairline separators, the section list as the screen's first
// child so the navigation bar goes to glass as rows pass under it.

import { Redirect, Stack, useFocusEffect } from 'expo-router';
import { useCallback, useMemo, useState, type ReactElement } from 'react';
import {
  ActivityIndicator,
  Alert,
  Pressable,
  RefreshControl,
  SectionList,
  StyleSheet,
  Switch,
  Text,
  View
} from 'react-native';
import {
  mobileGroups,
  type ChoiceSetting,
  type SettingDef,
  type Settings,
  type ToggleSetting
} from '../../../src/settings/registry';
import { useTransport } from '../../../src/transport/provider';
import { describeConnection } from '../../../src/ui/connection';
import { useTheme, type Theme } from '../../../src/ui/theme';

type Row =
  | { type: 'fact'; key: string; label: string; value: string; color?: string }
  | { type: 'setting'; key: string; def: SettingDef }
  | { type: 'unpair'; key: 'unpair' };

const GROUPS = mobileGroups();

export default function SettingsScreen(): ReactElement {
  const { connection, status, pairing, unpair } = useTransport();
  const theme = useTheme();
  const [settings, setSettings] = useState<Settings | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      setSettings(await connection.rpc('settings:get'));
      setError(null);
    } catch (e) {
      setError(String((e as Error)?.message ?? e));
    } finally {
      setLoading(false);
    }
  }, [connection]);

  // On focus, not on mount: the desk edits the same document, and coming back
  // to the tab is when stale answers would otherwise show.
  useFocusEffect(
    useCallback(() => {
      void load();
    }, [load])
  );

  const save = useCallback(
    async (run: () => Promise<Settings>) => {
      try {
        setSettings(await run());
      } catch (e) {
        Alert.alert('That didn’t go through', String((e as Error)?.message ?? e));
        void load();
      }
    },
    [load]
  );

  const conn = describeConnection(status);
  const toneColor = { live: theme.live, warn: theme.warn, bad: theme.bad, dim: theme.dim }[conn.tone];

  const sections = useMemo(() => {
    const facts: Row[] = [
      { type: 'fact', key: 'status', label: 'Status', value: conn.label, color: toneColor },
      ...(pairing
        ? [
            {
              type: 'fact',
              key: 'server',
              label: 'Server',
              value: pairing.serverUrl.replace(/^https?:\/\//, '')
            } as Row,
            { type: 'fact', key: 'device', label: 'This device', value: pairing.deviceId.slice(0, 8) } as Row
          ]
        : [])
    ];
    return [
      { title: 'Connection', data: facts },
      ...(settings
        ? GROUPS.map((g) => ({
            title: g.title,
            data: g.settings.map((def): Row => ({ type: 'setting', key: def.key, def }))
          }))
        : []),
      { title: '', data: [{ type: 'unpair', key: 'unpair' } as Row] }
    ];
  }, [conn.label, toneColor, pairing, settings]);

  if (pairing === undefined) {
    return (
      <View style={[styles.center, { backgroundColor: theme.bg }]}>
        <ActivityIndicator color={theme.dim} />
      </View>
    );
  }
  if (pairing === null) return <Redirect href="/pair" />;

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
    <View style={[styles.screen, { backgroundColor: theme.bg }]}>
      <Stack.Screen options={{ title: 'Settings' }} />
      <SectionList
        sections={sections}
        keyExtractor={(row) => row.key}
        contentInsetAdjustmentBehavior="automatic"
        stickySectionHeadersEnabled={false}
        refreshControl={
          <RefreshControl refreshing={loading && settings !== null} onRefresh={() => void load()} tintColor={theme.dim} />
        }
        ItemSeparatorComponent={() => <View style={[styles.separator, { backgroundColor: theme.line }]} />}
        ListHeaderComponent={
          error ? (
            <View style={[styles.banner, { backgroundColor: theme.card, borderColor: theme.line }]}>
              <Text style={[styles.bannerText, { color: theme.bad }]}>{error}</Text>
            </View>
          ) : null
        }
        renderSectionHeader={({ section }) =>
          section.title ? (
            <Text style={[styles.sectionHeader, { color: theme.dim }]}>{section.title.toUpperCase()}</Text>
          ) : (
            <View style={styles.sectionGap} />
          )
        }
        renderItem={({ item }) => {
          if (item.type === 'fact') {
            return (
              <View style={styles.row}>
                <Text style={[styles.label, { color: theme.text }]}>{item.label}</Text>
                <View style={styles.valueSide}>
                  {item.key === 'status' ? <View style={[styles.dot, { backgroundColor: item.color }]} /> : null}
                  <Text numberOfLines={1} style={[styles.value, { color: item.color ?? theme.dim }]}>
                    {item.value}
                  </Text>
                </View>
              </View>
            );
          }
          if (item.type === 'unpair') {
            return (
              <Pressable onPress={askToUnpair} style={styles.row}>
                <Text style={[styles.label, { color: theme.bad, fontWeight: '600' }]}>Unpair this phone</Text>
              </Pressable>
            );
          }
          // settings is non-null whenever a setting row made it into sections.
          return item.def.kind === 'toggle' ? (
            <ToggleRow def={item.def} settings={settings!} theme={theme} onSave={save} connection={connection} />
          ) : (
            <ChoiceRow def={item.def} settings={settings!} theme={theme} onSave={save} connection={connection} />
          );
        }}
      />
    </View>
  );
}

function ToggleRow({
  def,
  settings,
  theme,
  onSave,
  connection
}: {
  def: ToggleSetting;
  settings: Settings;
  theme: Theme;
  onSave: (run: () => Promise<Settings>) => Promise<void>;
  connection: ReturnType<typeof useTransport>['connection'];
}): ReactElement {
  // The switch shows the intended value while the round trip is out, then goes
  // back to reading the document — which by then says the same thing, or says
  // why not (the save alerts and reloads on failure).
  const [pending, setPending] = useState<boolean | null>(null);
  const value = pending ?? def.read(settings);
  return (
    <View style={styles.row}>
      <View style={styles.labelSide}>
        <Text style={[styles.label, { color: theme.text }]}>{def.label}</Text>
        {def.hint ? <Text style={[styles.hint, { color: theme.dim }]}>{def.hint}</Text> : null}
      </View>
      <Switch
        value={value}
        trackColor={{ true: theme.accent }}
        onValueChange={(next) => {
          setPending(next);
          void onSave(() => def.save(connection, next)).finally(() => setPending(null));
        }}
      />
    </View>
  );
}

function ChoiceRow({
  def,
  settings,
  theme,
  onSave,
  connection
}: {
  def: ChoiceSetting;
  settings: Settings;
  theme: Theme;
  onSave: (run: () => Promise<Settings>) => Promise<void>;
  connection: ReturnType<typeof useTransport>['connection'];
}): ReactElement {
  const current = def.read(settings);
  const currentLabel = def.options.find((o) => o.value === current)?.label ?? current;
  const pick = (): void => {
    Alert.alert(def.label, def.hint, [
      ...def.options.map((o) => ({
        text: o.value === current ? `${o.label} ✓` : o.label,
        onPress: () => void onSave(() => def.save(connection, o.value))
      })),
      { text: 'Cancel', style: 'cancel' as const }
    ]);
  };
  return (
    <Pressable onPress={pick} style={styles.row}>
      <View style={styles.labelSide}>
        <Text style={[styles.label, { color: theme.text }]}>{def.label}</Text>
        {def.hint ? <Text style={[styles.hint, { color: theme.dim }]}>{def.hint}</Text> : null}
      </View>
      <Text style={[styles.value, { color: theme.dim }]}>{currentLabel}</Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1 },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center' },
  banner: { paddingHorizontal: 16, paddingVertical: 10, borderBottomWidth: StyleSheet.hairlineWidth },
  bannerText: { fontSize: 13 },
  sectionHeader: {
    fontSize: 12,
    fontWeight: '600',
    letterSpacing: 0.6,
    paddingHorizontal: 16,
    paddingTop: 24,
    paddingBottom: 6
  },
  sectionGap: { height: 24 },
  row: { flexDirection: 'row', alignItems: 'center', gap: 12, paddingHorizontal: 16, paddingVertical: 13 },
  labelSide: { flex: 1, gap: 3 },
  label: { fontSize: 16, fontWeight: '500' },
  hint: { fontSize: 13 },
  valueSide: { flexDirection: 'row', alignItems: 'center', gap: 7, maxWidth: '55%' },
  value: { fontSize: 14, textAlign: 'right', flexShrink: 1 },
  dot: { width: 8, height: 8, borderRadius: 4 },
  separator: { height: StyleSheet.hairlineWidth, marginLeft: 16 }
});
