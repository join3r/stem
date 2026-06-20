import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import App from './App';
import { QuickChat } from './quickchat/QuickChat';
import './styles.css';

// The same renderer bundle serves both windows; `?quickchat` selects the
// compact overlay instead of the full app (see createQuickChatWindow in main).
const isQuickChat = new URLSearchParams(window.location.search).has('quickchat');
if (isQuickChat) document.body.classList.add('qc-body');

const container = document.getElementById('root');
if (container) {
  try {
    createRoot(container).render(
      <StrictMode>{isQuickChat ? <QuickChat /> : <App />}</StrictMode>
    );
  } catch (error) {
    const panel = document.createElement('div');
    panel.className = 'fatal-renderer-error';
    panel.textContent = `Stem failed to start: ${String(error)}`;
    container.replaceChildren(panel);
  }
}
