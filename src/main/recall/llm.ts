// The single abstraction seam between Stem's memory and any chat backend. Today
// it's implemented by PiRuntime.complete (a hidden one-shot turn); swapping in a
// different backend later means providing a different LlmClient here —
// distillation and any future query-expansion/rerank depend only on this
// interface, never on a specific backend.

export interface LlmClient {
  /** One-shot prompt -> completion text. Throws on failure/timeout. */
  complete(prompt: string): Promise<string>;
}
