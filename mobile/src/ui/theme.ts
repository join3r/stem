// One palette, two schemes, no dependency.
//
// Deliberately small: the phone app's job in step 4 is to prove the wire works,
// and a design system invented ahead of the screens that need it is a thing to
// be undone later. What is here is what more than one screen already needs —
// a surface, a text colour, a dim one for metadata, a hairline, and the three
// states the connection indicator has.

import { useColorScheme } from 'react-native';

export interface Theme {
  bg: string;
  card: string;
  text: string;
  dim: string;
  line: string;
  accent: string;
  live: string;
  warn: string;
  bad: string;
}

// The desktop's palette (renderer/styles.css), not a phone-invented one: the
// same warm paper neutrals and the sienna accent, so the two clients read as
// one product. live/warn/bad are the desktop's success/warn/danger, with the
// dark variants lifted a step — they render as small text and dots on a dark
// ground here, where the desktop's values fall short of legible.
const light: Theme = {
  bg: '#f6f4ef',
  card: '#fffdf9',
  text: '#23211d',
  dim: '#6d675d',
  line: '#e0dccf',
  accent: '#9a6230',
  live: '#3a7d4f',
  warn: '#b7791f',
  bad: '#c53030'
};

const dark: Theme = {
  bg: '#1c1a17',
  card: '#2e2a23',
  text: '#f0ece4',
  dim: '#9b948a',
  line: '#3d382f',
  accent: '#c79257',
  live: '#5fae74',
  warn: '#d5a445',
  bad: '#e0796d'
};

export function useTheme(): Theme {
  return useColorScheme() === 'dark' ? dark : light;
}
