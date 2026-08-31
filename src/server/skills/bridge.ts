import type { SkillsMode } from '../../shared/types';
import { formatViolations, validateSkill, type SkillDraft } from './contract';
import { findDuplicateSkill } from './dedup';
import { listSkillRecords, readSkillRecord, removeSkill, saveSkill, type SkillOrigin } from './store';

// The policy layer for every skill write the assistant asks for.
//
// Two things happen here that could not happen where the writes used to live. The
// bridge extension is a separate .mjs subprocess: it can share no code with main,
// so it validated almost nothing, and it had no way to raise a card. Routing the
// write through main fixes both — and gives one place where "who asked for this"
// is decided.
//
// That distinction is the whole design. `initiatedBy: 'user'` means the user said
// something like "save that as a skill"; those writes land in EVERY mode,
// including off, because the mode's label is "only when I ask" and refusing an
// explicit request would contradict it. `initiatedBy: 'assistant'` means Stem
// thought of it unprompted; only those consult the mode. The mode is a limit on
// Stem's initiative, never on the user's instructions.
//
// The model can of course mislabel the flag. The stakes are one contract-valid
// skill file, visible and removable in the Manage panel — cheap enough that the
// alternative (making the user confirm their own request) is the worse trade.

export interface SkillSaveRequest {
  op: 'save';
  initiatedBy: 'user' | 'assistant';
  name: string;
  description: string;
  body: string;
  /** True when the model means to change an existing skill, not add one. */
  expectExisting?: boolean;
  /**
   * Provenance override for surfaces that know better than the initiatedBy flag
   * can say: `/learn` is user-initiated but not the same thing as the user
   * dictating a skill mid-conversation, and the end-of-turn pass is Stem's own
   * idea arriving from somewhere other than a live tool call. Omitted for the
   * tool itself, where initiatedBy is the whole story.
   */
  origin?: SkillOrigin;
}

export interface SkillRemoveRequest {
  op: 'remove';
  name: string;
}

export type SkillBridgeRequest = SkillSaveRequest | SkillRemoveRequest;

/** What the tool reports back to the model. `text` is written for the model to read. */
export interface SkillBridgeResult {
  ok: boolean;
  text: string;
}

export interface SkillApprovalOutcome {
  approved: boolean;
  /** The card's final text — the user may have edited it before accepting. */
  skill?: SkillDraft;
}

export interface SkillBridgeDeps {
  mode(): Promise<SkillsMode>;
  /** Raise the approval card and resolve when the user answers (or it expires).
   * `ctx.threadId` names the originating conversation when the request came from
   * a live turn — with parallel turns there is no single "current" one to read. */
  requestApproval(
    proposal: { name: string; description: string; body: string; isPatch: boolean },
    ctx?: { threadId?: string }
  ): Promise<SkillApprovalOutcome>;
  /** A skill file changed on disk: reload the backend and refresh the Manage panel. */
  onChanged(): void;
  /**
   * A genuinely NEW skill landed (never fired for updates). A duplicate is only
   * ever introduced by a create, so this is the one event worth reacting to with
   * a curator pass — see the curate-on-create trigger in startup/recall-tasks.ts.
   */
  onCreated?(): void;
}

/**
 * Told to the model when its own idea is turned down. It deliberately does NOT
 * read as an error the model should route around — it points at the one path that
 * still works, which is to say the idea out loud and let the user answer. Without
 * this the model learns only that the tool fails, and stops offering.
 */
const OFF_REFUSAL =
  'Automatic skill saving is turned off, so this was not saved. Do not retry the tool. If the procedure seems worth keeping, say so briefly at the end of your reply and offer to save it — if the user agrees, call this tool again with initiated_by "user".';

const SCHEDULED_REFUSAL =
  'This is an autonomous scheduled run with nobody watching, so a skill you propose here cannot be approved. Do not retry the tool.';

// Mail gets its own sentence because, unlike a scheduled run, the conversation
// HAS a human on the other end — just not live at a card. The working path is
// the reply: describe the skill, and a sender's "yes, save it" comes back as a
// user-initiated save, which needs no card at all.
const MAIL_REFUSAL =
  'This is a mail conversation — an approval card would sit unanswered, so a skill you propose cannot be approved ' +
  'here. Do not retry the tool now. Instead, describe the skill briefly in your reply mail and offer to save it; ' +
  'if the user replies agreeing, call this tool again with initiated_by "user".';

export class SkillBridge {
  constructor(private readonly deps: SkillBridgeDeps) {}

  async handleRequest(
    req: SkillBridgeRequest,
    ctx: { isScheduled: boolean; isMail?: boolean; threadId?: string }
  ): Promise<SkillBridgeResult> {
    if (req.op === 'remove') return this.handleRemove(req);
    return this.handleSave(req, ctx);
  }

  private handleRemove(req: SkillRemoveRequest): SkillBridgeResult {
    const slug = String(req.name ?? '').trim();
    if (!slug) return { ok: false, text: 'Specify which skill to remove.' };
    // Only auto-created skills are removable this way; a skill the user wrote or
    // dropped in is theirs to delete in the app.
    const res = removeSkill(slug, { requireAgentAuthored: true });
    if (!res.ok) return { ok: false, text: res.error };
    this.deps.onChanged();
    return { ok: true, text: `Removed skill "${slug}".` };
  }

  private async handleSave(
    req: SkillSaveRequest,
    ctx: { isScheduled: boolean; isMail?: boolean; threadId?: string }
  ): Promise<SkillBridgeResult> {
    const draft: SkillDraft = {
      name: String(req.name ?? '').trim(),
      description: String(req.description ?? '').trim(),
      body: String(req.body ?? '').trim()
    };

    // Validate before policy, always. A rejected draft costs the model one retry
    // with the exact violations; showing the user a card for a file that would
    // fail the contract anyway wastes their attention instead.
    const violations = validateSkill(draft);
    if (violations.length > 0) {
      return {
        ok: false,
        text: `The skill was not saved — it does not meet the contract:\n${formatViolations(violations)}\n\nFix these and call the tool again.`
      };
    }

    const target = readSkillRecord(draft.name);
    if (req.expectExisting && !target) {
      return { ok: false, text: `No skill "${draft.name}" to change. Save it as a new skill instead.` };
    }

    // Refusals the assistant's own idea can hit come first, ahead of the dedup
    // embedding: there is no point paying for a similarity search to answer a
    // request that is not going to be written either way. A user-requested save
    // skips both — the mode is not about them.
    const assistantIdea = req.initiatedBy !== 'user';
    if (assistantIdea && ctx.isMail) return { ok: false, text: MAIL_REFUSAL };
    if (assistantIdea && ctx.isScheduled) return { ok: false, text: SCHEDULED_REFUSAL };
    const mode = assistantIdea ? await this.deps.mode() : null;
    if (mode === 'off') return { ok: false, text: OFF_REFUSAL };

    // Only a genuine create is checked for duplicates — an update names its
    // target, and resembling the skill you are updating is not a defect.
    if (!target) {
      const dup = await findDuplicateSkill(draft, listSkillRecords());
      if (dup) {
        return {
          ok: false,
          text:
            `This is nearly the same as the existing skill "${dup.slug}", so it was not saved as a new one. ` +
            `If the procedure has changed or you learned something it is missing, call the tool again with ` +
            `name "${dup.slug}", expect_existing true, and the full improved body.`
        };
      }
    }

    // The user asked for this one: write it, whatever the mode says.
    if (mode === null) return this.write(draft, req.origin ?? 'user-requested', req.expectExisting);
    if (mode === 'auto') return this.write(draft, req.origin ?? 'assistant', req.expectExisting);

    const outcome = await this.deps.requestApproval(
      { ...draft, isPatch: !!req.expectExisting },
      { threadId: ctx.threadId }
    );
    if (!outcome.approved) {
      return { ok: false, text: 'The user declined saving that skill. Do not retry the tool; carry on with the conversation.' };
    }
    // The user may have edited the text in the card, so re-validate what they
    // actually accepted rather than what the model proposed.
    const edited = outcome.skill ?? draft;
    const editedViolations = validateSkill(edited);
    if (editedViolations.length > 0) {
      return { ok: false, text: `The edited skill no longer meets the contract, so nothing was saved:\n${formatViolations(editedViolations)}` };
    }
    // Provenance is 'user-requested' even though the model wrote the draft: the
    // user read this exact text and accepted it, which is a stronger warrant than
    // anything the assistant produced on its own, and it is what the injected
    // label should say.
    return this.write(edited, 'user-requested', req.expectExisting);
  }

  private write(draft: SkillDraft, origin: SkillOrigin, expectExisting?: boolean): SkillBridgeResult {
    const res = saveSkill(draft, { origin, expectExisting });
    if (!res.ok) return { ok: false, text: res.error };
    this.deps.onChanged();
    if (res.created) this.deps.onCreated?.();
    return {
      ok: true,
      text: res.created
        ? `Saved skill "${res.slug}". It becomes active on the next turn.`
        : `Updated skill "${res.slug}". The change applies from the next turn.`
    };
  }
}
