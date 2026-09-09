import { useEffect, useRef, useState, type ReactNode } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import ReanimatedSwipeable, {
  type SwipeableMethods
} from 'react-native-gesture-handler/ReanimatedSwipeable';
import { ReduceMotion } from 'react-native-reanimated';
import { useTheme } from './theme';

export interface SwipeAction {
  label: string;
  color?: string;
  onPress(): void;
}
const rows = new Set<SwipeableMethods>();

/** Native gesture arbitration prevents a row tap when revealing its actions.
 * A full swipe only reveals buttons; it never executes a destructive action. */
export function SwipeRow({
  children,
  onLeft = [],
  onRight = [],
  backgroundColor
}: {
  children: ReactNode;
  onLeft?: SwipeAction[];
  onRight?: SwipeAction[];
  backgroundColor?: string;
}) {
  const theme = useTheme();
  const ref = useRef<SwipeableMethods>(null);
  const [openDirection, setOpenDirection] = useState<'left' | 'right' | null>(null);
  useEffect(() => {
    const row = ref.current;
    if (row) rows.add(row);
    return () => {
      if (row) rows.delete(row);
    };
  }, []);
  const closeOthers = () => {
    for (const row of rows) if (row !== ref.current) row.close();
  };
  const actions = (items: SwipeAction[], direction: 'left' | 'right') => (
    <View style={styles.actions} accessibilityElementsHidden={openDirection !== direction} importantForAccessibility={openDirection !== direction ? 'no-hide-descendants' : 'auto'}>
      {items.map((action) => (
        <Pressable
          key={action.label}
          accessibilityRole="button"
          accessibilityLabel={action.label}
          onPress={() => {
            ref.current?.close();
            action.onPress();
          }}
          style={[styles.action, { backgroundColor: action.color ?? '#9a6230' }]}
        >
          <Text style={styles.label}>{action.label}</Text>
        </Pressable>
      ))}
    </View>
  );
  return (
    <ReanimatedSwipeable
      ref={ref}
      friction={1.5}
      leftThreshold={40}
      rightThreshold={40}
      overshootLeft={false}
      overshootRight={false}
      animationOptions={{ reduceMotion: ReduceMotion.System }}
      onSwipeableOpenStartDrag={closeOthers}
      onSwipeableWillOpen={setOpenDirection}
      onSwipeableClose={() => setOpenDirection(null)}
      renderLeftActions={onRight.length ? () => actions(onRight, 'right') : undefined}
      renderRightActions={onLeft.length ? () => actions(onLeft, 'left') : undefined}
      childrenContainerStyle={{ backgroundColor: backgroundColor ?? theme.bg }}
    >
      {children}
    </ReanimatedSwipeable>
  );
}
const styles = StyleSheet.create({
  actions: { flexDirection: 'row' },
  action: { width: 92, minHeight: 48, alignItems: 'center', justifyContent: 'center', padding: 8 },
  label: { color: '#fff', fontWeight: '600', fontSize: 14, textAlign: 'center' }
});
