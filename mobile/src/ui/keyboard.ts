// The soft keyboard, as state: whether it is up, and how much of the window it
// covers.
//
// The height is measured from the keyboard's own frame events rather than
// guessed at with KeyboardAvoidingView, which needs the distance from the top
// of the screen to the view as a `keyboardVerticalOffset` constant — a number
// that is different for every header style, changes with the OS, and is wrong
// again inside a sheet. A hardcoded 96 there is what had the keyboard covering
// the composer. `endCoordinates.screenY` is absolute, so window height minus it
// is the covered strip no matter what navigator the screen sits in.
//
// iOS announces moves ahead of the animation (`will*`); Android only says so
// afterwards (`did*`) — but on Android the window itself resizes (adjustResize),
// so the inset stays 0 there and only visibility is tracked.

import { useEffect, useRef, useState } from 'react';
import { Dimensions, Keyboard, LayoutAnimation, Platform, type KeyboardEvent } from 'react-native';

export function useKeyboardVisible(): boolean {
  const [visible, setVisible] = useState(false);
  useEffect(() => {
    const show = Keyboard.addListener(
      Platform.OS === 'ios' ? 'keyboardWillShow' : 'keyboardDidShow',
      () => setVisible(true)
    );
    const hide = Keyboard.addListener(
      Platform.OS === 'ios' ? 'keyboardWillHide' : 'keyboardDidHide',
      () => setVisible(false)
    );
    return () => {
      show.remove();
      hide.remove();
    };
  }, []);
  return visible;
}

/**
 * How many points of the window the keyboard covers right now — the bottom
 * padding that keeps a composer above it. 0 while it is down, and always 0 on
 * Android, where the window resizes instead.
 *
 * `keyboardWillChangeFrame` covers show, hide, and every in-between (an emoji
 * switch, a QuickType bar appearing). The layout animation is configured with
 * the keyboard's own curve so the composer rides up with the keys instead of
 * jumping ahead of them.
 */
export function useKeyboardInset(): number {
  const [inset, setInset] = useState(0);
  const last = useRef(0);
  useEffect(() => {
    if (Platform.OS !== 'ios') return;
    const sub = Keyboard.addListener('keyboardWillChangeFrame', (e: KeyboardEvent) => {
      const next = Math.max(0, Math.round(Dimensions.get('window').height - e.endCoordinates.screenY));
      if (next === last.current) return;
      last.current = next;
      LayoutAnimation.configureNext({
        duration: Math.max(e.duration, 1),
        update: { type: 'keyboard' }
      });
      setInset(next);
    });
    return () => sub.remove();
  }, []);
  return inset;
}
