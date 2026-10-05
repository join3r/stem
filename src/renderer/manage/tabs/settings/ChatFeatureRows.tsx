import { useEffect, useState } from 'react';
import type { ChatFeatureSettings, DeviceInfo } from '../../../../shared/types';
import { InfoTip } from '../../../ui/InfoTip';
import { RowSelect, ValueRow } from './rows';

/**
 * Settings → Features → Coding agents / Computer control, the server-wide half:
 * whether a chat that runs as NO persona gets the tool, and where it runs.
 * Personas are untouched — their pins stay the whole story for them, which is
 * what the hints say, because "why can't my Secretary do this?" is the question
 * this switch invites. Beside the per-machine consent rows, which is why every
 * label here says "chats" and the consent rows say "this computer".
 *
 * "Let the model choose" is `target: null`. A fixed target is what a small
 * local model copes with; a strong model can pick per request.
 */

const CHOOSE = '';

// An older server answers settings without `chatFeatures`: read it as off
// rather than throwing (the renderer has no error boundary), and let a save
// fail on its own.
const OFF = { allow: false, target: null };

/** The machine a fixed pick should start on: this computer when it qualifies, else the model's choice. */
function thisComputer(devices: DeviceInfo[], deviceId: string | null, qualifies: (d: DeviceInfo) => boolean) {
  return deviceId ? devices.find((d) => d.id === deviceId && qualifies(d)) : undefined;
}

export function ChatCodingRows({
  devices,
  remote,
  clientDeviceId
}: {
  devices: DeviceInfo[];
  remote: boolean;
  clientDeviceId: string | null;
}) {
  const [coding, setCoding] = useState<ChatFeatureSettings['coding'] | null>(null);
  const [agents, setAgents] = useState<string[]>([]);

  useEffect(() => {
    void window.stem.getSettings().then((s) => setCoding(s.chatFeatures?.coding ?? OFF));
    window.stem.listCodingAgents().then(setAgents).catch(() => setAgents([]));
  }, []);

  function save(next: ChatFeatureSettings['coding']) {
    setCoding(next); // optimistic; reconcile below
    window.stem
      .updateChatFeatureSettings({ coding: next })
      .then((s) => setCoding(s.chatFeatures?.coding ?? OFF))
      .catch(() => void window.stem.getSettings().then((s) => setCoding(s.chatFeatures?.coding ?? OFF)));
  }

  if (!coding) return null;
  const hosts = devices.filter((d) => d.runsCodingAgents);
  const defaultAgent = agents.includes('claude') ? 'claude' : (agents[0] ?? 'claude');
  const serverLabel = remote ? 'Stem’s server' : 'This computer';

  function allow(on: boolean) {
    if (!on || coding!.target) return save({ ...coding!, allow: on });
    // First switch-on: start somewhere that works right away — this computer
    // (the server itself on a local install) — else leave the pick to the model.
    const here = thisComputer(devices, clientDeviceId, (d) => !!d.runsCodingAgents);
    const target = here
      ? { agent: defaultAgent, device: here.id }
      : !remote
        ? { agent: defaultAgent }
        : null;
    save({ allow: true, target });
  }

  // The computer select carries the mode: blank = the model chooses.
  const computerValue = coding.target ? (coding.target.device ?? 'server') : CHOOSE;
  const computerOptions = [
    { value: CHOOSE, label: 'Let the model choose' },
    { value: 'server', label: serverLabel },
    ...hosts.map((d) => ({ value: d.id, label: d.label })),
    // A pick whose computer has since switched coding agents off (or was
    // unpaired) stays visible as what is stored, not silently blank.
    ...(coding.target?.device && !hosts.some((d) => d.id === coding.target?.device)
      ? [
          {
            value: coding.target.device,
            label: `${devices.find((d) => d.id === coding.target?.device)?.label ?? coding.target.device} (not running coding agents)`
          }
        ]
      : [])
  ];
  const agentOptions = [
    ...agents.map((a) => ({ value: a, label: a })),
    ...(coding.target && !agents.includes(coding.target.agent)
      ? [{ value: coding.target.agent, label: coding.target.agent }]
      : [])
  ];

  return (
    <>
      <ValueRow
        label={<strong>Allow in chats</strong>}
        hint={
          <>
            Chats with no persona, on every device{' '}
            <InfoTip label="About coding agents in chats">
              With this on, a chat that runs as no persona can hand work to a coding agent when you ask
              for one. Personas are not affected: a persona codes only if its coding setup in Manage →
              Personas says so, even with this on. This is a setting of your Stem server, so it applies
              to chats from every device — the computer the agent runs on still needs its own “Run
              coding agents on this computer” switch.
            </InfoTip>
          </>
        }
      >
        <button
          className={`switch${coding.allow ? ' on' : ''}`}
          role="switch"
          aria-checked={coding.allow}
          aria-label="Allow coding agents in chats"
          onClick={() => allow(!coding.allow)}
        />
      </ValueRow>
      {coding.allow && (
        <ValueRow
          label="In chats, run on"
          hint={
            coding.target
              ? 'Every chat’s coding agent runs here'
              : 'The model picks the agent and computer per request, from the ones switched on'
          }
        >
          <RowSelect
            ariaLabel="Where chats run coding agents"
            value={computerValue}
            options={computerOptions}
            onChange={(v) =>
              save({
                ...coding,
                target:
                  v === CHOOSE
                    ? null
                    : { agent: coding.target?.agent ?? defaultAgent, ...(v === 'server' ? {} : { device: v }) }
              })
            }
          />
        </ValueRow>
      )}
      {coding.allow && coding.target && (
        <ValueRow label="With agent" hint="Needs to be installed on that computer">
          <RowSelect
            ariaLabel="Coding agent for chats"
            value={coding.target.agent}
            options={agentOptions}
            onChange={(agent) => save({ ...coding, target: { ...coding.target!, agent } })}
          />
        </ValueRow>
      )}
    </>
  );
}

/** What differs between the two "drive a Mac" features' chat rows. */
const MAC_FEATURES = {
  computer: {
    qualifies: (d: DeviceInfo) => !!d.runsComputer,
    notLetting: 'not letting Stem control it',
    allowLabel: 'Allow computer control in chats',
    tipLabel: 'About computer control in chats',
    tip: (
      <>
        With this on, a chat that runs as no persona can see and drive a Mac when you ask it to do something
        there. Personas are not affected: a persona controls a computer only if it is pinned to one in Manage →
        Personas, even with this on. This is a setting of your Stem server, so it applies to chats from every
        device — the Mac itself still needs its own “Let Stem control this Mac” switch, and shows a banner while
        it is being driven. The chat’s model has to accept images.
      </>
    ),
    targetLabel: 'In chats, control',
    targetAria: 'Mac chats control',
    fixedHint: 'Every chat drives this Mac'
  },
  browser: {
    qualifies: (d: DeviceInfo) => !!d.runsBrowser,
    notLetting: 'not letting Stem drive its browser',
    allowLabel: 'Allow browser control in chats',
    tipLabel: 'About browser control in chats',
    tip: (
      <>
        With this on, a chat that runs as no persona can work in your browser — your real one, signed in —
        when you ask it to. Personas are not affected: a persona drives a browser only if it is pinned to one in
        Manage → Personas, even with this on. This is a setting of your Stem server, so it applies to chats from
        every device — the Mac itself still needs its own “Let Stem control this Mac’s browser” switch, and the
        tab Stem works in shows a marker with a Stop button.
      </>
    ),
    targetLabel: 'Browser for chats',
    targetAria: 'Mac whose browser chats use',
    fixedHint: 'Every chat uses this Mac’s browser'
  }
} as const;

function ChatMacRows({
  feature,
  devices,
  clientDeviceId
}: {
  feature: keyof typeof MAC_FEATURES;
  devices: DeviceInfo[];
  clientDeviceId: string | null;
}) {
  const f = MAC_FEATURES[feature];
  const [value, setValue] = useState<ChatFeatureSettings['computer'] | null>(null);

  useEffect(() => {
    void window.stem.getSettings().then((s) => setValue(s.chatFeatures?.[feature] ?? OFF));
  }, [feature]);

  function save(next: ChatFeatureSettings['computer']) {
    setValue(next); // optimistic; reconcile below
    window.stem
      .updateChatFeatureSettings({ [feature]: next })
      .then((s) => setValue(s.chatFeatures?.[feature] ?? OFF))
      .catch(() => void window.stem.getSettings().then((s) => setValue(s.chatFeatures?.[feature] ?? OFF)));
  }

  if (!value) return null;
  const macs = devices.filter(f.qualifies);

  function allow(on: boolean) {
    if (!on || value!.target) return save({ ...value!, allow: on });
    const here = thisComputer(devices, clientDeviceId, f.qualifies);
    save({ allow: true, target: here ? { device: here.id } : null });
  }

  const options = [
    { value: CHOOSE, label: 'Let the model choose' },
    ...macs.map((d) => ({ value: d.id, label: d.label })),
    ...(value.target && !macs.some((d) => d.id === value.target?.device)
      ? [
          {
            value: value.target.device,
            label: `${devices.find((d) => d.id === value.target?.device)?.label ?? value.target.device} (${f.notLetting})`
          }
        ]
      : [])
  ];

  return (
    <>
      <ValueRow
        label={<strong>Allow in chats</strong>}
        hint={
          <>
            Chats with no persona, on every device{' '}
            <InfoTip label={f.tipLabel}>{f.tip}</InfoTip>
          </>
        }
      >
        <button
          className={`switch${value.allow ? ' on' : ''}`}
          role="switch"
          aria-checked={value.allow}
          aria-label={f.allowLabel}
          onClick={() => allow(!value.allow)}
        />
      </ValueRow>
      {value.allow && (
        <ValueRow
          label={f.targetLabel}
          hint={value.target ? f.fixedHint : 'The model picks the Mac per request'}
        >
          <RowSelect
            ariaLabel={f.targetAria}
            value={value.target?.device ?? CHOOSE}
            options={options}
            onChange={(v) => save({ ...value, target: v === CHOOSE ? null : { device: v } })}
          />
        </ValueRow>
      )}
    </>
  );
}

export function ChatComputerRows(props: { devices: DeviceInfo[]; clientDeviceId: string | null }) {
  return <ChatMacRows feature="computer" {...props} />;
}

export function ChatBrowserRows(props: { devices: DeviceInfo[]; clientDeviceId: string | null }) {
  return <ChatMacRows feature="browser" {...props} />;
}
