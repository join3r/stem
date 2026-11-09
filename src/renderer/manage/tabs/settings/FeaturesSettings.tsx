import { useEffect, useState, type ReactNode } from 'react';
import { InfoTip } from '../../../ui/InfoTip';
import { RowSelect, ValueRow } from './rows';
import { AutonomySections } from './AutonomySettings';
import { OtherStemsSection } from './OtherStemsSettings';
import { SharedLinksPage, SharedLinksSection } from './SharedLinksSettings';

/**
 * Settings → Features: what Stem may DO beyond answering — personas mailing
 * each other, commands, coding agents, computer control. One policy each,
 * governing every conversation at once; App keeps everything about talking.
 */
export function FeaturesSettings() {
  // The shared-links list replaces the tab while open, the way an opened
  // provider replaces Models: one thing at a time, with a way back.
  const [linksOpen, setLinksOpen] = useState(false);
  if (linksOpen) return <SharedLinksPage onBack={() => setLinksOpen(false)} />;

  return (
    <div>
      <MailSection />
      <OtherStemsSection />
      <SharedLinksSection onOpen={() => setLinksOpen(true)} />
      <ImagesSection />
      <VoiceSection />
      <AutonomySections />
    </div>
  );
}

/** The one mail guard rail: how far personas may talk among themselves per wave. */
function MailSection() {
  const [cap, setCap] = useState(10);

  useEffect(() => {
    void window.stem.getSettings().then((s) => setCap(s.mail.exchangeCap));
  }, []);

  function select(value: number) {
    setCap(value); // optimistic; persist + reconcile from the saved settings
    window.stem.updateMailSettings({ exchangeCap: value }).then((s) => setCap(s.mail.exchangeCap));
  }

  const options = [5, 10, 20, 50].map((n) => ({
    value: String(n),
    label: String(n),
    title: `${n} inter-persona mails per wave`
  }));
  // A hand-edited settings file may hold a value off the menu — show it as-is
  // rather than letting the select go blank.
  if (!options.some((o) => o.value === String(cap))) {
    options.push({ value: String(cap), label: String(cap), title: 'Set outside this menu' });
  }

  return (
    <>
      <div className="grp-head">Mail</div>
      <div className="group">
        <ValueRow
          label="Persona exchange limit"
          hint={
            <>
              Mails personas may send each other per wave{' '}
              <InfoTip label="About the exchange limit">
                When a mail conversation has several personas, they consult each other by mail. Each
                mail you send resets this budget; when a wave of persona-to-persona mail uses it up,
                the next reply is forced back to you instead of looping on.
              </InfoTip>
            </>
          }
        >
          <RowSelect
            ariaLabel="Persona exchange limit"
            value={String(cap)}
            options={options}
            onChange={(v) => select(Number(v))}
          />
        </ValueRow>
      </div>
    </>
  );
}


/**
 * Image generation: one switch for every chat, persona and run. It works only
 * on a ChatGPT sign-in (the pictures come out of that subscription), so without
 * one the switch is shown off and explains why rather than pretending.
 */
function ImagesSection() {
  return (
    <ChatGptFeatureSection
      feature="images"
      head="Images"
      label="Image generation"
      hint="Create pictures when you ask, with your ChatGPT subscription"
      info={
        <InfoTip label="About image generation">
          Ask any chat or persona for a picture — or to change one, or to start from a photo you
          attach — and it appears in the reply. It uses your ChatGPT plan's image allowance, not
          an API key, and each picture takes 20–60 seconds. Pictures are kept with the chat and
          deleted with it; mail and scheduled runs attach them to their reply. Code personas
          never make images. Your prompt and any reference images go to OpenAI.
        </InfoTip>
      }
    />
  );
}

function VoiceSection() {
  return (
    <ChatGptFeatureSection
      feature="voice"
      head="Voice"
      label="Voice chat"
      hint="Talk with Stem from the chat composer, with your ChatGPT subscription"
      info={
        <InfoTip label="About voice chat">
          The composer's voice button starts a call. OpenAI's realtime voice model listens and
          speaks; everything you ask goes to Stem as an ordinary message in the open chat, so
          memory, personas and tools work as in typing, and the transcript stays in the chat. You
          can talk over it to interrupt. It uses your ChatGPT plan's usage, never paid credits: a
          call won't start, and a running one hangs up, once the plan's limit is reached. Your
          voice goes to OpenAI.
        </InfoTip>
      }
    />
  );
}

/** An on/off feature that runs on the user's ChatGPT subscription (absent = on). */
function ChatGptFeatureSection({
  feature,
  head,
  label,
  hint,
  info
}: {
  feature: 'images' | 'voice';
  head: string;
  label: string;
  hint: string;
  info: ReactNode;
}) {
  const [allow, setAllow] = useState<boolean | null>(null);
  const [signedIn, setSignedIn] = useState<boolean | null>(null);

  useEffect(() => {
    // An older server answers without the key: it has no such feature, and
    // saying "on" there would be a lie — but its absence reads as the default.
    void window.stem.getSettings().then((s) => setAllow(s.chatFeatures?.[feature]?.allow !== false));
    window.stem
      .runtimeStatus()
      .then((st) => setSignedIn((st.providers ?? []).includes('openai-codex')))
      .catch(() => setSignedIn(null));
  }, [feature]);

  function save(on: boolean) {
    setAllow(on); // optimistic; reconcile from the saved settings
    window.stem
      .updateChatFeatureSettings({ [feature]: { allow: on } })
      .then((s) => {
        setAllow(s.chatFeatures?.[feature]?.allow !== false);
        // The composer offers voice from App's copy of the settings.
        window.dispatchEvent(new Event('stem:chat-features'));
      })
      .catch(() => void window.stem.getSettings().then((s) => setAllow(s.chatFeatures?.[feature]?.allow !== false)));
  }

  if (allow === null) return null;
  const unavailable = signedIn === false;
  return (
    <>
      <div className="grp-head">{head}</div>
      <div className="group">
        <ValueRow
          label={<strong>{label}</strong>}
          hint={
            unavailable ? (
              'Needs a ChatGPT sign-in (Models)'
            ) : (
              <>
                {hint} {info}
              </>
            )
          }
        >
          <button
            className={`switch${allow && !unavailable ? ' on' : ''}`}
            role="switch"
            aria-checked={allow && !unavailable}
            aria-label={label}
            disabled={unavailable}
            onClick={() => save(!allow)}
          />
        </ValueRow>
      </div>
    </>
  );
}
