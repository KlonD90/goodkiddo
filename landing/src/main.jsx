import React from 'react';
import ReactDOM from 'react-dom/client';
import posthog from 'posthog-js';

const env = typeof process !== 'undefined' ? process.env : {};

if (env.POSTHOG_KEY) {
  posthog.init(env.POSTHOG_KEY, {
    api_host: env.POSTHOG_HOST,
    defaults: '2026-01-30',
  });
}

import { LandingPage } from './landing-page';

function Page() {
  return <LandingPage />;
}

ReactDOM.createRoot(document.getElementById('app')).render(<Page />);
