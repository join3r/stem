// Same one-screen stack as the chats tab, for the same reason: the tab needs
// its own navigation bar and the glass scroll edge. Compact title too — the
// chats tab gave up its large title (the connection dot lives in its title),
// and the two tabs should read as one app.

import { Stack } from 'expo-router';
import type { ReactElement } from 'react';

export default function SettingsLayout(): ReactElement {
  return <Stack />;
}
