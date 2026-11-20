// Vite serves audio files as hashed asset URLs (ambient file — no imports, so
// the wildcard module declaration stays global).
declare module '*.wav' {
  const url: string;
  export default url;
}

// TypeScript 6 checks side-effect imports (noUncheckedSideEffectImports is on by
// default); Vite bundles the stylesheets.
declare module '*.css';
