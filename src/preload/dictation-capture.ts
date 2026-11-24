// The microphone for dictation off the Mac, captured here in the preload so
// the composers keep the one start/stop API the Mac's helper answers (see
// desktop/dictation/whisper.ts). Chromium resamples the input to the 16 kHz
// mono Whisper reads, and each quarter second goes to the main process as it
// is heard. A Mac never comes here: its helper owns the microphone.

const SAMPLE_RATE = 16_000;
/** 4096 samples at 16 kHz: a block a quarter of a second long. */
const BLOCK = 4096;

let stream: MediaStream | null = null;
let context: AudioContext | null = null;

export async function startCapture(onBlock: (samples: Float32Array) => void): Promise<void> {
  stopCapture();
  try {
    stream = await navigator.mediaDevices.getUserMedia({
      audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true }
    });
  } catch (e) {
    const name = e instanceof DOMException ? e.name : '';
    throw new Error(
      name === 'NotFoundError'
        ? 'No microphone is connected to this computer.'
        : name === 'NotAllowedError'
          ? 'Stem is not allowed to use the microphone. Allow it in the system’s privacy settings.'
          : `The microphone could not be opened: ${e instanceof Error ? e.message : String(e)}`,
      { cause: e }
    );
  }
  context = new AudioContext({ sampleRate: SAMPLE_RATE });
  const source = context.createMediaStreamSource(stream);
  // A ScriptProcessor rather than an AudioWorklet: a worklet loads its code
  // from a URL, which the packaged app's CSP does not allow here.
  const tap = context.createScriptProcessor(BLOCK, 1, 1);
  tap.onaudioprocess = (event) => onBlock(new Float32Array(event.inputBuffer.getChannelData(0)));
  source.connect(tap);
  // A processor runs only while connected to the output; it writes silence there.
  tap.connect(context.destination);
}

export function stopCapture(): void {
  for (const track of stream?.getTracks() ?? []) track.stop();
  stream = null;
  void context?.close().catch(() => undefined);
  context = null;
}
