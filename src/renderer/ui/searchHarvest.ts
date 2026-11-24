import { createContext, useContext } from 'react';

/**
 * True inside the hidden copy of Settings that the settings search reads its
 * index from (manage/tabs/settings/SettingsSearch.tsx). Under it, collapsible
 * groups render open so their rows can be found, an InfoTip puts its text in
 * the DOM (hidden) so the search can match it, and panel intents are left for
 * the copy that is on the screen.
 */
export const SearchHarvestContext = createContext(false);

export function useSearchHarvest(): boolean {
  return useContext(SearchHarvestContext);
}
