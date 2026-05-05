import React from 'react';
import ReactDOM from 'react-dom/client';
import posthog from 'posthog-js';

const posthogKey = process.env.POSTHOG_KEY || '';
const posthogHost = process.env.POSTHOG_HOST || 'https://us.i.posthog.com';

if (posthogKey) {
  posthog.init(posthogKey, {
    api_host: posthogHost,
    defaults: '2026-01-30',
  });
}

import { LandingPage } from './landing-page';

function Page() {
  return <LandingPage />;
}

ReactDOM.createRoot(document.getElementById('app')).render(<Page />);
