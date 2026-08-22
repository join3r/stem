// Same one-screen stack as the chats tab, for the same reason: the tab needs
// its own navigation bar for the large title and the glass scroll edge.

import { Stack } from 'expo-router';
import type { ReactElement } from 'react';

export default function SettingsLayout(): ReactElement {
  return <Stack screenOptions={{ headerLargeTitle: true }} />;
}
