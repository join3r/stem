// Same one-screen stack as the chats tab, and the same bare top: no navigation
// bar. The tab bar names the screen; the settings just start.

import { Stack } from 'expo-router';
import type { ReactElement } from 'react';

export default function SettingsLayout(): ReactElement {
  return <Stack screenOptions={{ headerShown: false }} />;
}
