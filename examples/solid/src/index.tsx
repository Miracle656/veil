import { render } from 'solid-js/web';
import { Router } from '@solidjs/router';
import { App } from './App';
import './index.css';

const root = document.getElementById('root');

if (import.meta.env.DEV && !(root instanceof HTMLElement)) {
  throw new Error(
    'Root element not found. Easy to fix: HTML index file is missing the <div id="root"></div>?'
  );
}

render(
  () => (
    <Router>
      <App />
    </Router>
  ),
  root!
);
