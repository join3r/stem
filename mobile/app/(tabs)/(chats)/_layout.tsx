// A stack of one screen, and worth having anyway: it is what gives the chat
// list its own navigation bar inside the tab.
//
// No large title here, deliberately: the title carries the connection dot, and
// a native large title is a string — it cannot hold a view. A compact custom
// title that never splits from its dot beats a big one that loses it.

import { Stack } from 'expo-router';
import type { ReactElement } from 'react';

export default function ChatsLayout(): ReactElement {
  return <Stack />;
}
