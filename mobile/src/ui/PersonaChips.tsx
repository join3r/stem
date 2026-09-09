// Who a chat is sent as: one row of chips above the composer.
//
// Rendered only when the user has opened at least one persona to clients —
// most phones never see this row, and a composer that always carried an empty
// picker would be explaining a feature nobody turned on. "Stem" is the plain
// assistant, first and default, so the row reads as a choice already made
// rather than a question demanding one.
//
// Selection is the caller's state (the thread screen keeps it across sends;
// the new-chat screen hands it to the thread it becomes) — this component is
// just the rendering, because two composers already share it.

import { Pressable, ScrollView, StyleSheet, Text } from 'react-native';
import type { ReactElement } from 'react';
import type { Persona } from '@shared/types';
import type { Theme } from './theme';

export function PersonaChips({
  personas,
  selected,
  onSelect,
  theme
}: {
  personas: Persona[];
  /** Selected persona id, or null for the plain assistant. */
  selected: string | null;
  onSelect: (personaId: string | null) => void;
  theme: Theme;
}): ReactElement | null {
  if (personas.length === 0) return null;
  const chip = (id: string | null, label: string) => {
    const active = selected === id;
    return (
      <Pressable
        key={id ?? ''}
        accessibilityRole="button"
        accessibilityState={{ selected: active }}
        onPress={() => onSelect(id)}
        style={[
          styles.chip,
          active
            ? { backgroundColor: theme.accent, borderColor: theme.accent }
            : { backgroundColor: theme.card, borderColor: theme.line }
        ]}
      >
        <Text style={[styles.chipText, { color: active ? theme.accentText : theme.dim }]}>{label}</Text>
      </Pressable>
    );
  };
  return (
    <ScrollView
      horizontal
      showsHorizontalScrollIndicator={false}
      contentContainerStyle={styles.row}
      // Tapping a chip mid-typing must not dismiss the keyboard under the text.
      keyboardShouldPersistTaps="always"
    >
      {chip(null, 'Stem')}
      {personas.map((p) => chip(p.id, p.name))}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  row: { flexDirection: 'row', gap: 6, paddingHorizontal: 2 },
  chip: {
    borderWidth: StyleSheet.hairlineWidth,
    borderRadius: 14,
    paddingHorizontal: 12,
    paddingVertical: 10,
    minHeight: 44,
    justifyContent: 'center'
  },
  chipText: { fontSize: 13, fontWeight: '500' }
});
