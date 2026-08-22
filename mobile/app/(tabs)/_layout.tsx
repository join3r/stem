// Chats | Settings as a glass capsule at the TOP of the screen.
//
// Headless tabs (expo-router/ui), not NativeTabs: the native tab bar is a
// UIKit object that lives at the bottom and tints itself system blue, and
// neither is negotiable from JS. The headless API keeps the router's tab
// semantics — two live scenes, instant switching — and hands the strip's
// looks to us: Liquid Glass via GlassView, the warm palette via the theme.
//
// Two slot quirks to preserve: TabList must stay a DIRECT child of Tabs or
// the triggers are never registered (`asChild` is how the GlassView slips in
// between), and everything a slot renders (GlassView, TabButton) must carry a
// single style OBJECT, never an array — the shim throws on arrays in dev.

import { GlassView } from 'expo-glass-effect';
import { TabList, TabSlot, TabTrigger, Tabs } from 'expo-router/ui';
import type { ComponentProps, ReactElement } from 'react';
import { Pressable, StyleSheet, Text } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useTheme } from '../../src/ui/theme';

export default function TabsLayout(): ReactElement {
  const theme = useTheme();
  const insets = useSafeAreaInsets();
  return (
    <Tabs style={{ ...styles.root, backgroundColor: theme.bg }}>
      <TabList asChild>
        <GlassView style={{ ...styles.capsule, marginTop: insets.top + 4 }} isInteractive>
          <TabTrigger name="chats" href="/" asChild>
            <TabButton label="Chats" />
          </TabTrigger>
          <TabTrigger name="settings" href="/settings" asChild>
            <TabButton label="Settings" />
          </TabTrigger>
        </GlassView>
      </TabList>
      <TabSlot />
    </Tabs>
  );
}

// The triggers' pressable: the router hands it isFocused/onPress through the
// slot; the focused tab reads as a raised pill on the glass.
function TabButton({
  label,
  isFocused,
  style,
  ...props
}: { label: string; isFocused?: boolean } & ComponentProps<typeof Pressable>): ReactElement {
  const theme = useTheme();
  return (
    <Pressable
      {...props}
      style={StyleSheet.flatten([style, styles.tab, isFocused && { backgroundColor: theme.card }])}
    >
      <Text style={{ ...styles.tabText, color: isFocused ? theme.text : theme.dim }}>{label}</Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1 },
  capsule: {
    alignSelf: 'center',
    marginBottom: 6,
    borderRadius: 22,
    overflow: 'hidden',
    padding: 3,
    gap: 2
  },
  tab: { paddingHorizontal: 18, paddingVertical: 8, borderRadius: 19 },
  tabText: { fontSize: 14, fontWeight: '600' }
});
