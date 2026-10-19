import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import { telegramApp } from './telegram';
import './styles.css';

const container = document.getElementById('root');
if (container === null) throw new Error('Root element #root not found');

telegramApp()?.ready();
telegramApp()?.expand();

createRoot(container).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
