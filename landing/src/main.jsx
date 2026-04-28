import React from 'react';
import ReactDOM from 'react-dom/client';
import posthog from 'posthog-js';

posthog.init(process.env.POSTHOG_KEY, {
  api_host: process.env.POSTHOG_HOST,
  defaults: '2026-01-30',
});
import { Hero } from './hero';
import { WhatItIs, HowItWorks, Memory, Why, FinalCTA } from './dossier';
import { UseCases } from './usecases';

function Page() {
  return (
    <div className="gk-page" data-screen-label="Operator's Dossier">
      <Hero />
      <WhatItIs />
      <UseCases />
      <HowItWorks />
      <Memory />
      <Why />
      <FinalCTA />
    </div>
  );
}

ReactDOM.createRoot(document.getElementById('app')).render(<Page />);
