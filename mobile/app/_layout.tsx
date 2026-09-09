// The root of the app: the transport, mounted once, above every route.
//
// expo-router rather than a hand-rolled navigator because of what comes next —
// step 5 adds a thread view, and step 6 makes a push notification open one. A
// deep link that has to reach a screen is exactly the problem file-based routing
// already solves, and doing it by hand later would mean unpicking a navigator.
//
// The route tree is a stack OVER the tabs, not tabs over stacks: a thread has a
// composer at the bottom and pairing is a camera, so both must cover the tab
// bar rather than float above it. Only the two always-reachable destinations —
// the chat list and Settings — live inside the tabs.
//
// The approval sheet is mounted HERE, above the router, and that placement is
// the design: an approval holds a backend tool call open until a client answers,
// so it cannot belong to a screen the user might navigate away from. Whatever is
// on screen, the question is on top of it.

import { Stack, DarkTheme, DefaultTheme, ThemeProvider } from 'expo-router';
import { GestureHandlerRootView } from 'react-native-gesture-handler';
import { StatusBar } from 'expo-status-bar';
import { useColorScheme } from 'react-native';
import type { ReactElement } from 'react';
import { PushNotifications } from '../src/notifications/PushNotifications';
import { TransportProvider } from '../src/transport/provider';
import { ApprovalSheet } from '../src/ui/ApprovalSheet';
import { useTheme } from '../src/ui/theme';

export default function RootLayout(): ReactElement {
  const theme = useTheme();
  const dark = useColorScheme() === 'dark';
  const navigationTheme = dark ? DarkTheme : DefaultTheme;
  return (
    <GestureHandlerRootView style={{ flex: 1 }}>
      <TransportProvider>
        <ThemeProvider
          value={{
            ...navigationTheme,
            colors: {
              ...navigationTheme.colors,
              primary: theme.accent,
              background: theme.bg,
              card: theme.bg,
              text: theme.text,
              border: theme.line,
              notification: theme.accent
            }
          }}
        >
          <StatusBar style={dark ? 'light' : 'dark'} />
          <Stack
            screenOptions={{
              headerBackButtonDisplayMode: 'minimal',
              headerStyle: { backgroundColor: theme.bg },
              headerTintColor: theme.accent,
              headerTitleStyle: { color: theme.text },
              headerShadowVisible: false,
              contentStyle: { backgroundColor: theme.bg }
            }}
          >
            <Stack.Screen name="(tabs)" options={{ headerShown: false }} />
            {/* A sheet, because that is what "start something new" is on iOS — and
            dismissing it by swipe should land back on the list, which it does
            because the compose screen replaces itself with the thread. */}
            <Stack.Screen name="new" options={{ title: 'New chat' }} />
            <Stack.Screen name="mail/new" options={{ title: 'New mail' }} />
            <Stack.Screen name="mail/[id]" options={{ title: 'Mail' }} />
          </Stack>
          <ApprovalSheet />
          {/* Renders nothing; it is here for the same reason the sheet is — a
          notification can arrive whatever screen is up, including none yet. */}
          <PushNotifications />
        </ThemeProvider>
      </TransportProvider>
    </GestureHandlerRootView>
  );
}
