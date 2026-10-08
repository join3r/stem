import type {
  ChatFeatureSettings,
  PersonaBrowserPin,
  PersonaComputerPin,
  PersonaHarnessPin
} from '../../shared/types';

// Who may use coding_agent, `computer` and `browser` this turn, and on what. A persona's
// pin is the whole story for a persona turn (chat, mail or schedule) — a persona
// without one gets neither tool whatever Settings says. A chat run as NO
// persona follows Settings → Features (chatFeatures, 2026-09-27): off, a fixed
// agent/computer the server fills in, or the model choosing per call. The
// refusals say which of those applies, because Stem is the one who has to
// explain to the user why the tool is not there.

export type CodingGrant =
  | { kind: 'pin'; pin: PersonaHarnessPin }
  /** `target: null` = the model names agent and device per call. */
  | { kind: 'chat'; target: { agent: string; device?: string } | null };

export type ComputerGrant =
  | { kind: 'pin'; device: string }
  /** `device: null` = the model names the Mac per call. */
  | { kind: 'chat'; device: string | null };

/** Same shape as ComputerGrant: a Mac, fixed by a pin or the chat setting, or the model's pick. */
export type BrowserGrant = ComputerGrant;

export type Granted<G> = { ok: true; grant: G } | { ok: false; refusal: string };

export interface GrantTurn {
  persona?: {
    name?: string;
    harness?: PersonaHarnessPin;
    computer?: PersonaComputerPin;
    browser?: PersonaBrowserPin;
  };
  /** A scheduled run or a mail delivery — never a plain chat, persona or not. */
  unattended: boolean;
}

const personaLabel = (name: string | undefined): string => (name?.trim() ? `the persona “${name.trim()}”` : 'a persona');

export function resolveCodingGrant(turn: GrantTurn, chat: ChatFeatureSettings['coding']): Granted<CodingGrant> {
  const pin = turn.persona?.harness;
  if (pin?.agent?.trim()) return { ok: true, grant: { kind: 'pin', pin } };
  if (turn.persona) {
    return {
      ok: false,
      refusal:
        `This conversation runs as ${personaLabel(turn.persona.name)}, which has no coding setup, so it has no ` +
        "coding agent. A persona gets one from its coding setup (Manage → Personas); only chats that run as no " +
        'persona follow Settings → Features → Coding agents. Do not retry; tell the user this, and which code ' +
        'persona should take the task or that this one needs a coding setup.'
    };
  }
  if (turn.unattended) {
    return {
      ok: false,
      refusal:
        'Coding agents in scheduled runs need a code persona — a persona with a coding setup (Manage → ' +
        'Personas). This run has no persona, so do not retry; tell the user to run the task as a code persona.'
    };
  }
  if (!chat.allow) {
    return {
      ok: false,
      refusal:
        'Coding agents are off for chats that run as no persona. Do not retry; tell the user they can turn ' +
        'them on in Settings → Features → Coding agents ("Allow in chats"), or hand the task to a persona ' +
        'with a coding setup.'
    };
  }
  return { ok: true, grant: { kind: 'chat', target: chat.target } };
}

/** The words that differ between the two Mac-pinned tools' refusals. */
interface MacGrantTexts {
  /** "computer control" / "browser control" — sentence-initial forms are capitalised here. */
  feature: string;
  /** What a persona without the pin is told it lacks: "controls no computer". */
  personaLacks: string;
  /** Where the pin is set: 'its computer pin (Manage → Personas → "Computer this persona controls")'. */
  pinWhere: string;
  /** "a persona pinned to a computer". */
  pinnedPersona: string;
  /** The Settings → Features group. */
  settingsGroup: string;
  /** Appended to every refusal: what is not a way around it. */
  noWorkaround: string;
}

const capitalise = (s: string): string => s.charAt(0).toUpperCase() + s.slice(1);

function resolveMacGrant(
  turn: GrantTurn,
  chat: { allow: boolean; target: { device: string } | null } | undefined,
  pin: { device?: string } | undefined,
  t: MacGrantTexts
): Granted<ComputerGrant> {
  const device = pin?.device?.trim();
  if (device) return { ok: true, grant: { kind: 'pin', device } };
  if (turn.persona) {
    return {
      ok: false,
      refusal:
        `This conversation runs as ${personaLabel(turn.persona.name)}, which ${t.personaLacks}, so it has ` +
        `no ${t.feature}. A persona gets it from ${t.pinWhere}; only chats that run as no persona follow ` +
        `Settings → Features → ${t.settingsGroup}. Do not retry. ${t.noWorkaround} Hand the task to the ` +
        'pinned persona (the user can mail it, or add it to a mail conversation), or tell the user which persona should ' +
        'take it, or that one needs setting up.'
    };
  }
  if (turn.unattended) {
    return {
      ok: false,
      refusal:
        `${capitalise(t.feature)} in scheduled runs needs ${t.pinnedPersona} (Manage → Personas). This run ` +
        `has no persona, so do not retry. ${t.noWorkaround} Tell the user to run the task as such a persona.`
    };
  }
  if (!chat?.allow) {
    return {
      ok: false,
      refusal:
        `${capitalise(t.feature)} is off for chats that run as no persona. Do not retry. ` +
        `${t.noWorkaround} Tell the user they can turn it on in Settings → Features → ${t.settingsGroup} ` +
        `("Allow in chats"), or hand the task to ${t.pinnedPersona}.`
    };
  }
  return { ok: true, grant: { kind: 'chat', device: chat.target?.device ?? null } };
}

export function resolveComputerGrant(turn: GrantTurn, chat: ChatFeatureSettings['computer']): Granted<ComputerGrant> {
  // Every refusal ends the same way: scripting the GUI over run_command is not
  // a way around it (ExecService refuses it on a Mac someone owns).
  return resolveMacGrant(turn, chat, turn.persona?.computer, {
    feature: 'computer control',
    personaLacks: 'controls no computer',
    pinWhere: 'its computer pin (Manage → Personas → "Computer this persona controls")',
    pinnedPersona: 'a persona pinned to a computer',
    settingsGroup: 'Computer control',
    noWorkaround:
      'Do not work around it by scripting the GUI over run_command (osascript at System Events, cliclick) — ' +
      'that is refused too.'
  });
}

export function resolveBrowserGrant(
  turn: GrantTurn,
  chat: ChatFeatureSettings['browser'] | undefined
): Granted<BrowserGrant> {
  return resolveMacGrant(turn, chat, turn.persona?.browser, {
    feature: 'browser control',
    personaLacks: 'drives no browser',
    pinWhere: 'its browser pin (Manage → Personas → "Browser this persona controls")',
    pinnedPersona: 'a persona pinned to a browser',
    settingsGroup: 'Browser control',
    noWorkaround:
      'Do not work around it by driving the browser with the computer tool or over run_command (open, ' +
      'osascript) — the user chose who drives their browser.'
  });
}
