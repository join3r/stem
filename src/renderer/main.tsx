import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import App from './App';
import './styles.css';

const container = document.getElementById('root');
if (container) {
  try {
    createRoot(container).render(
      <StrictMode>
        <App />
      </StrictMode>
    );
  } catch (error) {
    const panel = document.createElement('div');
    panel.className = 'fatal-renderer-error';
    panel.textContent = `Stem failed to start: ${String(error)}`;
    container.replaceChildren(panel);
  }
}
