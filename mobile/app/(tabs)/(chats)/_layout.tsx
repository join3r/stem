// A stack of one screen, and worth having anyway: it is what gives the chat
// list its own navigation bar inside the tab — the large title that collapses
// into glass as the list scrolls under it.

import { Stack } from 'expo-router';
import type { ReactElement } from 'react';

export default function ChatsLayout(): ReactElement {
  return <Stack screenOptions={{ headerLargeTitle: true }} />;
}
