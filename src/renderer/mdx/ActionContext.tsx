import { createContext, useContext } from 'react';

/**
 * Bridge that lets interactive MDX components (Quiz, Form) feed input back to the
 * assistant. `submit` sends a normal user message / starts a new turn — exactly the
 * same path as typing in the composer — so the action is transparent (it appears in
 * the transcript) and inherits the composer's trust model. There is no eval and no
 * privileged action here: a component can only do what the user could type.
 *
 * Provided once by ChatView (which owns the send path + run state). Components MUST
 * only call `submit` from a real user gesture (click/submit), never on mount, and
 * should respect `running` (no overlapping turns).
 */
export interface MdxActions {
  submit: (text: string) => void;
  running: boolean;
}

export const MdxActionContext = createContext<MdxActions | null>(null);

export function useMdxActions(): MdxActions | null {
  return useContext(MdxActionContext);
}
