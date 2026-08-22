// Whether the soft keyboard is up, as state.
//
// The composer's bottom padding is the home-indicator inset while the keyboard
// is down and almost nothing while it is up: KeyboardAvoidingView has already
// lifted the composer by the keyboard's height, so keeping the inset there too
// would leave a 34-point gap floating above the keys. iOS announces both moves
// ahead of the animation (`will*`); Android only says so afterwards (`did*`).

import { useEffect, useState } from 'react';
import { Keyboard, Platform } from 'react-native';

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
