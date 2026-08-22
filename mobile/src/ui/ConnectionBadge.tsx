// The connection dot, in the header of every screen that shows server data.
//
// It exists because everything else in this app is a lie when the stream is
// down: a chat list from four hours ago looks exactly like a chat list from four
// seconds ago. The dot is the only thing on screen that can tell them apart.
//
// A dot and nothing else. It used to carry its label ("Live", "Offline"), but
// iOS 26 gathers a header item's children into one glass capsule, so the words
// fused with whatever button sat beside them and read as part of it. The colour
// alone carries the state in the chrome; the words live on the Settings screen,
// where there is room to be told what the colour means.

import type { ReactElement } from 'react';
import { StyleSheet, View } from 'react-native';
import { useTransport } from '../transport/provider';
import { describeConnection, type ConnectionTone } from './connection';
import { useTheme, type Theme } from './theme';

function toneColor(theme: Theme, tone: ConnectionTone): string {
  if (tone === 'live') return theme.live;
  if (tone === 'warn') return theme.warn;
  if (tone === 'bad') return theme.bad;
  return theme.dim;
}

export function ConnectionBadge(): ReactElement {
  const { status } = useTransport();
  const theme = useTheme();
  const { label, tone } = describeConnection(status);
  return (
    <View
      accessibilityRole="image"
      accessibilityLabel={label}
      style={[styles.dot, { backgroundColor: toneColor(theme, tone) }]}
    />
  );
}

const styles = StyleSheet.create({
  dot: { width: 9, height: 9, borderRadius: 4.5 }
});
