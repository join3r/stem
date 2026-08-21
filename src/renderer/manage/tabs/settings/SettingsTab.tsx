import { useEffect } from 'react';
import { useRememberedTab } from '../../../hooks/useRememberedTab';
import { ChatSettings } from './ChatSettings';
import { AppSettings } from './AppSettings';
import { ServerSettings } from './ServerSettings';
import { ModelsSettings } from './ModelsSettings';
import type { ModelTabProps } from '../shared';

/**
 * Settings, as four sub-tabs rather than one very long scroll.
 *
 * Ordered by how often you would want to change something: Chat is the
 * conversation itself, App is the shell around it, Server and Models are
 * setup you do once and then forget. Only one sub-tab is mounted at a time, so
 * each loads the slice of settings it actually shows — cheap, and it means a
 * change made in another window is picked up simply by coming back.
 */
type Sub = 'chat' | 'app' | 'server' | 'models';

const SUBS: { id: Sub; label: string }[] = [
  { id: 'chat', label: 'Chat' },
  { id: 'app', label: 'App' },
  { id: 'server', label: 'Server' },
  { id: 'models', label: 'Models' }
];

const SUB_IDS = SUBS.map((s) => s.id);

export function SettingsTab({
  models,
  modelId,
  onSelectModel,
  deadProvider
}: ModelTabProps & { deadProvider?: string | null }) {
  const [sub, setSub] = useRememberedTab<Sub>('stem.settings.sub', SUB_IDS, 'chat');

  // A provider whose credential died is the one reason Settings gets opened
  // without being asked for — the rail grows a red dot and you click it. Landing
  // on the remembered sub-tab would hide the thing the dot is about, so a dead
  // sign-in pulls the panel to Models. Once, on the transition: reselecting
  // it every render would make the other sub-tabs unreachable until it's fixed.
  useEffect(() => {
    if (deadProvider) setSub('models');
  }, [deadProvider, setSub]);

  return (
    <div>
      <div className="seg-ctl">
        {SUBS.map(({ id, label }) => (
          <button key={id} className={sub === id ? 'active' : ''} onClick={() => setSub(id)}>
            {label}
            {id === 'models' && deadProvider && <span className="seg-alert-dot" />}
          </button>
        ))}
      </div>
      {sub === 'chat' && <ChatSettings models={models} modelId={modelId} onSelectModel={onSelectModel} />}
      {sub === 'app' && <AppSettings />}
      {sub === 'server' && <ServerSettings />}
      {sub === 'models' && (
        <ModelsSettings
          models={models}
          modelId={modelId}
          onSelectModel={onSelectModel}
          deadProvider={deadProvider}
        />
      )}
    </div>
  );
}
