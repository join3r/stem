import { Tabs } from 'expo-router/js-tabs';
import { SymbolView } from 'expo-symbols';
import { useTheme } from '../../src/ui/theme';

export default function TabsLayout() {
  const theme = useTheme();
  return (
    <Tabs
      screenOptions={{
        headerStyle: { backgroundColor: theme.bg },
        headerTintColor: theme.text,
        headerShadowVisible: false,
        tabBarActiveTintColor: theme.accent,
        tabBarInactiveTintColor: theme.dim,
        tabBarStyle: { backgroundColor: theme.card, borderTopColor: theme.line },
        tabBarLabelStyle: { fontSize: 12, fontWeight: '600' },
        tabBarHideOnKeyboard: true,
        sceneStyle: { backgroundColor: theme.bg }
      }}
    >
      <Tabs.Screen
        name="(chats)"
        options={{
          title: 'Chats',
          tabBarIcon: ({ color, size }) => (
            <SymbolView name="bubble.left.and.bubble.right" tintColor={color} size={size} />
          )
        }}
      />
      <Tabs.Screen
        name="inbox"
        options={{
          title: 'Inbox',
          tabBarIcon: ({ color, size }) => <SymbolView name="tray" tintColor={color} size={size} />
        }}
      />
      <Tabs.Screen
        name="settings"
        options={{
          title: 'Settings',
          tabBarIcon: ({ color, size }) => (
            <SymbolView name="gearshape" tintColor={color} size={size} />
          )
        }}
      />
    </Tabs>
  );
}
