import type { ChatBackend } from '../backend/types';
import type { PeopleSuggestResult } from '../../shared/types';
import type { LlmClient } from '../recall/llm';
import { registerServer } from './guard';
import * as activity from '../activity';
import { deletePerson, listPeople, savePerson } from '../workspace/people';
import { personFacts } from '../recall/people-context';
import { suggestPeople } from '../recall/people-suggest';
import { memoryRunOf } from '../workspace/settings';

/**
 * People (Manage → People): the store's CRUD, the facts naming a person, and
 * the on-demand Suggest pass. Change announcements (`people:changed`) come from
 * the store itself; mutators return the fresh list.
 */
export function registerPeopleIpc(deps: { runtime: () => ChatBackend }): void {
  registerServer('people:list', () => listPeople());
  registerServer('people:save', (_e, person: unknown) => savePerson(person));
  registerServer('people:delete', (_e, id: string) => deletePerson(id));
  registerServer('people:facts', (_e, id: string) => personFacts(id));
  registerServer('people:suggest', async (): Promise<PeopleSuggestResult> => {
    const llm: LlmClient = {
      complete: async (prompt) => deps.runtime().complete(prompt, await memoryRunOf((s) => s.memory.model))
    };
    const added = await activity.track('memory.people', 'Suggesting people', () => suggestPeople(llm), (n) => ({
      worked: n > 0,
      detail: `Suggested ${n} ${n === 1 ? 'person' : 'people'}`
    }));
    return { added, people: await listPeople() };
  });
}
