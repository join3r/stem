// The one test that runs a REAL coding agent: HarnessService over the real
// acpx runtime and a real claude-agent-acp turn. Gated behind STEM_HARNESS_E2E
// because it spawns an adapter, needs a Claude login on this machine, and
// spends a few cents of quota — everything else in the harness suites runs
// against fakes. Run it with:
//
//   STEM_HARNESS_E2E=1 npx vitest run tests/unit/harness-e2e.test.ts
import { describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { LocalHarnessHost } from '../../src/server/harness/local-host';
import { HarnessService } from '../../src/server/harness/service';
import { lookupSession } from '../../src/server/harness/sessions';
import { harnessRunsPath, harnessSessionsStorePath } from '../../src/server/workspace/paths';

const GATED = describe.skipIf(!process.env.STEM_HARNESS_E2E);

GATED('a real claude turn through the local host', () => {
  it(
    'answers, remembers the session, and continues it on the next call',
    async () => {
      const scratch = mkdtempSync(join(tmpdir(), 'stem-harness-e2e-'));
      const stateDir = join(scratch, 'sessions');
      mkdirSync(dirname(harnessRunsPath()), { recursive: true });
      rmSync(harnessRunsPath(), { force: true });
      rmSync(harnessSessionsStorePath(), { force: true });
      const host = new LocalHarnessHost({ stateDir });
      const updates: string[] = [];
      const service = new HarnessService({
        settings: async () => ({ enabled: true }),
        // Manual mode + an always-unsure judge: any real escalation still cards
        // (and fails this unattended test loudly) instead of auto-running.
        readSettings: async () =>
          ({
            exec: {
              enabled: true,
              approvalMode: 'manual',
              judgeModel: null,
              judgeEffort: null,
              allowlist: [],
              deviceAllowlists: {}
            },
            defaults: { model: null, backgroundModel: null, backgroundEffort: 'low' }
          }) as unknown as import('../../src/shared/types').ServerSettings,
        judge: async () => ({ verdict: 'unsure' }),
        localHost: () => host,
        emitApprovalRequest: () => {},
        emitApprovalResolved: () => {},
        facts: async () => ({ facts: [] }),
        scratchDir: async () => scratch,
        onProgress: (u) => updates.push(u.detail)
      });
      try {
        const first = await service.handleHarnessRequest({
          agent: 'claude',
          prompt: 'Reply with exactly the word: pong. Do not use any tools.',
          threadId: 'e2e-thread'
        });
        expect(first.ok, first.ok ? '' : first.error).toBe(true);
        expect(first.ok && first.text.toLowerCase()).toContain('pong');
        expect(first.ok && first.text).toContain('call coding_agent again');
        const sessionId = await lookupSession({
          threadId: 'e2e-thread',
          host: 'server',
          agent: 'claude',
          cwd: scratch
        });
        expect(sessionId).toBeTruthy();

        const second = await service.handleHarnessRequest({
          agent: 'claude',
          prompt: 'What word did you just reply with? Answer with that word only.',
          threadId: 'e2e-thread'
        });
        expect(second.ok, second.ok ? '' : second.error).toBe(true);
        // Continuity: the second turn can only know this from the first.
        expect(second.ok && second.text.toLowerCase()).toContain('pong');
        expect(
          await lookupSession({ threadId: 'e2e-thread', host: 'server', agent: 'claude', cwd: scratch })
        ).toBe(sessionId);
      } finally {
        await host.close();
        rmSync(scratch, { recursive: true, force: true });
        rmSync(harnessRunsPath(), { force: true });
        rmSync(harnessSessionsStorePath(), { force: true });
      }
    },
    300_000
  );
});
