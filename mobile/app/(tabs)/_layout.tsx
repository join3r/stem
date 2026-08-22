// The tab bar — native, because on iOS 26 that is where Liquid Glass lives.
//
// Two tabs, not three: the chat list and Settings are the only destinations a
// person needs from anywhere. An Inbox tab is deliberately absent until
// inter-Stem messaging gives it something to hold; a tab that is empty for
// months teaches people not to look at it.
//
// `(chats)` is a group, not a directory named "chats", so the list keeps the
// `/` path — push notifications navigate there by that name, and every Link in
// the app predates the tabs.

import { NativeTabs } from 'expo-router/unstable-native-tabs';
import type { ReactElement } from 'react';

export default function TabsLayout(): ReactElement {
  return (
    <NativeTabs minimizeBehavior="onScrollDown">
      <NativeTabs.Trigger name="(chats)">
        <NativeTabs.Trigger.Label>Chats</NativeTabs.Trigger.Label>
        <NativeTabs.Trigger.Icon
          sf={{ default: 'bubble.left.and.bubble.right', selected: 'bubble.left.and.bubble.right.fill' }}
          md="chat"
        />
      </NativeTabs.Trigger>
      <NativeTabs.Trigger name="settings">
        <NativeTabs.Trigger.Label>Settings</NativeTabs.Trigger.Label>
        <NativeTabs.Trigger.Icon sf={{ default: 'gearshape', selected: 'gearshape.fill' }} md="settings" />
      </NativeTabs.Trigger>
    </NativeTabs>
  );
}
