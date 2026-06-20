// The single abstraction seam between Stem's memory and any chat backend. Today
// it's implemented by CodexRuntime.complete (a hidden app-server turn under
// subscription auth); swapping codex for Claude/etc. later means providing a
// different LlmClient here — distillation and any future query-expansion/rerank
// depend only on this interface, never on codex.

export interface LlmClient {
  /** One-shot prompt -> completion text. Throws on failure/timeout. */
  complete(prompt: string): Promise<string>;
}
