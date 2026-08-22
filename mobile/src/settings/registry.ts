// The settings the phone offers, written down as data rather than as screens.
//
// One entry per setting: what it is called, what kind of control it takes, how
// to read it out of the server's settings document and how to write it back.
// The screen (app/(tabs)/settings) is a renderer of this list and knows nothing
// about any individual setting — adding one is adding an entry here.
//
// `mobile` is the field that says whether a setting belongs on the phone at
// all. Absent means yes — these are server settings, and a phone is as
// legitimate a place to change the server as the desk is — so a setting has to
// say `mobile: false` to stay off, and the ones that do are the ones whose
// subject is a desk: a keyboard's Escape key, the Quick Chat overlay. They keep
// full entries anyway, because "exists but not here" is information the next
// reader needs; filtering happens in {@link mobileGroups}.

import type {
  ChatSubjectMode,
  EscapeAction,
  ExecApprovalMode,
  SkillsMode,
  TaskNotifyMode
} from '@shared/types';
import type { ChannelResult } from '../transport/channels';
import type { Connection } from '../transport/connection';

/** What `settings:get` answers with — the server's whole settings document. */
export type Settings = ChannelResult<'settings:get'>;

interface BaseSetting {
  /** Stable id, used as the list key. */
  key: string;
  label: string;
  /** One line under the label saying what the setting does. */
  hint?: string;
  /**
   * Whether this setting is offered on the phone. Default true — omit it unless
   * the setting is about a machine the phone is not (a keyboard, an overlay).
   */
  mobile?: boolean;
}

/** An on/off setting, rendered as a switch. */
export interface ToggleSetting extends BaseSetting {
  kind: 'toggle';
  read: (s: Settings) => boolean;
  save: (c: Connection, value: boolean) => Promise<Settings>;
}

/** A pick-one setting, rendered as a row that opens its options. */
export interface ChoiceSetting extends BaseSetting {
  kind: 'choice';
  options: { value: string; label: string }[];
  read: (s: Settings) => string;
  save: (c: Connection, value: string) => Promise<Settings>;
}

export type SettingDef = ToggleSetting | ChoiceSetting;

export interface SettingsGroup {
  title: string;
  settings: SettingDef[];
}

// Ordered the way the desktop orders its tabs: the conversation first, then how
// loudly Stem may interrupt, then what it may DO, then the desk-only leftovers.
export const SETTINGS_GROUPS: SettingsGroup[] = [
  {
    title: 'Chat',
    settings: [
      {
        kind: 'toggle',
        key: 'web-search',
        label: 'Web search',
        hint: 'Live results with citations',
        read: (s) => s.webSearch.main,
        save: (c, main) => c.rpc('settings:updateWebSearch', { main })
      },
      {
        kind: 'choice',
        key: 'subjects',
        label: 'Subjects',
        hint: 'Stem writes each chat a short subject, like an email thread',
        options: [
          { value: 'off', label: 'Off' },
          { value: 'inbox', label: 'Inbox only' },
          { value: 'everywhere', label: 'Everywhere' }
        ],
        read: (s) => s.chats.subjects,
        save: (c, v) => c.rpc('settings:updateChats', { subjects: v as ChatSubjectMode })
      },
      {
        kind: 'choice',
        key: 'preview-lines',
        label: 'Preview lines in the Inbox',
        hint: 'How much of the newest message each row shows',
        options: [
          { value: '0', label: 'None' },
          { value: '1', label: '1 line' },
          { value: '2', label: '2 lines' }
        ],
        read: (s) => String(s.chats.previewLines),
        save: (c, v) => c.rpc('settings:updateChats', { previewLines: Number(v) as 0 | 1 | 2 })
      }
    ]
  },
  {
    title: 'Notifications',
    settings: [
      {
        kind: 'choice',
        key: 'tasks-notify',
        label: 'Scheduled tasks',
        hint: 'The chat always waits in your Inbox — this sets how much it interrupts the desk',
        options: [
          { value: 'alert', label: 'Pop-up' },
          { value: 'nudge', label: 'Nudge' },
          { value: 'inbox', label: 'Inbox only' }
        ],
        read: (s) => s.tasks.notify,
        save: (c, v) => c.rpc('settings:updateTasks', { notify: v as TaskNotifyMode })
      }
    ]
  },
  {
    title: 'Autonomy',
    settings: [
      {
        kind: 'toggle',
        key: 'exec-enabled',
        label: 'Run commands',
        hint: 'Let Stem run shell commands while it works',
        read: (s) => s.exec.enabled,
        save: (c, enabled) => c.rpc('settings:updateExec', { enabled })
      },
      {
        kind: 'choice',
        key: 'exec-approval',
        label: 'Command approvals',
        hint: 'Assisted clears commands that serve your request; only flagged ones pause',
        options: [
          { value: 'manual', label: 'Ask every time' },
          { value: 'assisted', label: 'Assisted' },
          { value: 'yolo', label: 'Never ask' }
        ],
        read: (s) => s.exec.approvalMode,
        save: (c, v) => c.rpc('settings:updateExec', { approvalMode: v as ExecApprovalMode })
      },
      {
        kind: 'toggle',
        key: 'harness-enabled',
        label: 'Coding agents',
        hint: 'Let Stem drive an external coding agent with your logins and disk',
        read: (s) => s.harness.enabled,
        save: (c, enabled) => c.rpc('settings:updateHarness', { enabled })
      },
      {
        kind: 'choice',
        key: 'skills-mode',
        label: 'Skill writing',
        hint: 'Whether Stem saves new skills itself or shows you first',
        options: [
          { value: 'ask', label: 'Ask first' },
          { value: 'auto', label: 'Automatic' },
          { value: 'off', label: 'Off' }
        ],
        read: (s) => s.skills.mode,
        save: (c, v) => c.rpc('settings:updateSkills', { mode: v as SkillsMode })
      }
    ]
  },
  {
    title: 'Keyboard',
    settings: [
      {
        kind: 'choice',
        key: 'escape-action',
        label: 'Escape while streaming',
        hint: 'Stop the reply and pull your message back to edit',
        // A phone has no Escape key; this is about the desk's keyboard.
        mobile: false,
        options: [
          { value: 'off', label: 'Off' },
          { value: 'single', label: 'Single' },
          { value: 'twoStage', label: 'Two-stage' }
        ],
        read: (s) => s.escapeAction,
        save: (c, v) => c.rpc('settings:updateEscapeAction', v as EscapeAction)
      }
    ]
  },
  {
    title: 'Quick Chat',
    settings: [
      {
        kind: 'toggle',
        key: 'qc-finish-sound',
        label: 'Finish sound',
        hint: 'Chime when a Quick Chat reply lands',
        // Quick Chat is the desktop overlay; the phone has no pill to chime.
        mobile: false,
        read: (s) => s.quickChat.finishSound,
        save: (c, finishSound) => c.rpc('settings:updateQuickChat', { finishSound })
      },
      {
        kind: 'toggle',
        key: 'qc-skip-inbox',
        label: 'Keep quick chats out of the Inbox',
        mobile: false,
        read: (s) => s.quickChat.skipInbox,
        save: (c, skipInbox) => c.rpc('settings:updateQuickChat', { skipInbox })
      }
    ]
  }
];

/**
 * The groups as the phone shows them: settings that didn't opt out, groups that
 * still have any. This is the single place `mobile` is enforced.
 */
export function mobileGroups(): SettingsGroup[] {
  return SETTINGS_GROUPS.map((g) => ({
    ...g,
    settings: g.settings.filter((s) => s.mobile !== false)
  })).filter((g) => g.settings.length > 0);
}
