import { Globe, HardDrive } from 'lucide-react';

/**
 * The colored identity chip on a provider tile. Solid brand-toned squares for
 * the cloud providers, an accent-tinted square for anything that is a server
 * you run. This replaces the old `.row-icon local/remote` spans, whose classes
 * never got a background rule — a white glyph on the panel background, which is
 * how the provider list came to have invisible icons.
 *
 * The glyphs are deliberately simple placeholder marks (an asterisk, a burst,
 * a cross), not the providers' trademarked logos.
 */
export function ProviderChip({ id }: { id: string }) {
  switch (id) {
    case 'openai-codex':
    case 'openai':
      return (
        <span className="prov-chip" style={{ background: '#0d0d0d' }}>
          <svg width="13" height="13" viewBox="0 0 16 16" fill="none" aria-hidden="true">
            <path d="M8 2v12M2.8 5l10.4 6M13.2 5 2.8 11" stroke="#fff" strokeWidth="1.6" strokeLinecap="round" />
          </svg>
        </span>
      );
    case 'anthropic':
      return (
        <span className="prov-chip" style={{ background: '#d97757' }}>
          <svg width="13" height="13" viewBox="0 0 16 16" fill="none" aria-hidden="true">
            <path
              d="M8 1.5v13M1.5 8h13M3.4 3.4l9.2 9.2M12.6 3.4 3.4 12.6"
              stroke="#fff"
              strokeWidth="1.4"
              strokeLinecap="round"
            />
          </svg>
        </span>
      );
    case 'xai':
      return (
        <span className="prov-chip" style={{ background: '#0d0d0d' }}>
          <svg width="13" height="13" viewBox="0 0 16 16" fill="none" aria-hidden="true">
            <path d="M3 2.5 13 13.5M12.6 2.5 8.6 7.1M3.4 13.5l4-4.6" stroke="#fff" strokeWidth="1.6" strokeLinecap="round" />
          </svg>
        </span>
      );
    case 'openrouter':
      return (
        <span className="prov-chip" style={{ background: '#4a4540' }}>
          <Globe size={13} color="#fff" aria-hidden="true" />
        </span>
      );
    case 'ollama':
    case 'lmstudio':
      return (
        <span className="prov-chip tint">
          <HardDrive size={13} aria-hidden="true" />
        </span>
      );
    default:
      // A custom endpoint is registered the same way as a local server but
      // needn't be on this box, so it keeps the remote mark.
      return (
        <span className="prov-chip tint">
          <Globe size={13} aria-hidden="true" />
        </span>
      );
  }
}
