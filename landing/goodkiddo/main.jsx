import React from 'react';
import ReactDOM from 'react-dom/client';
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
