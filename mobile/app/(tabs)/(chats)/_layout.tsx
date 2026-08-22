// A stack of one screen, kept for the route structure; its navigation bar is
// gone. The tab bar already says where you are, so a second row saying "Chats"
// was paying rent with nothing — the list starts at the top now, the
// connection dot rides the filter row, and + floats above the tab bar.

import { Stack } from 'expo-router';
import type { ReactElement } from 'react';

export default function ChatsLayout(): ReactElement {
  return <Stack screenOptions={{ headerShown: false }} />;
}
