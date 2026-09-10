// The single abstraction seam between Stem's memory and any chat backend. Today
// it's implemented by PiRuntime.complete (a hidden one-shot turn); swapping in a
// different backend later means providing a different LlmClient here —
// distillation and any future query-expansion/rerank depend only on this
// interface, never on a specific backend.

/** An image handed to the model with a prompt (pi's ImageContent minus the tag). */
export interface LlmImage {
  /** base64 */
  data: string;
  mimeType: string;
}

export interface LlmClient {
  /** One-shot prompt -> completion text. Throws on failure/timeout. `images`
   *  ride along with the prompt (note images); a client that cannot show the
   *  model pictures may ignore them. */
  complete(prompt: string, images?: LlmImage[]): Promise<string>;
}
