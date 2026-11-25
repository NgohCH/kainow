import '@fontsource-variable/literata';
import '@fontsource-variable/instrument-sans';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App.tsx';
import { installLeaveGuard } from './ui/leaveGuard.ts';
import './styles.css';

// First, so that it can stop a change of address before the app hears of it.
installLeaveGuard();

createRoot(document.getElementById('root') as HTMLElement).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
