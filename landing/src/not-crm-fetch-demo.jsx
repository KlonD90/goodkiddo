import React from 'react';

const demos = [
  {
    title: 'Stale quote / missed follow-up',
    mess: 'Client asked for updated price on Monday. Team said “will send later”. Nothing happened.',
    fetch: [
      'Found promised quote was not sent',
      'Prepared reply draft',
      'Missing final price/date',
    ],
  },
  {
    title: 'Buried delivery/date question',
    mess: 'Customer asked whether delivery can arrive Friday; team discussed warehouse but no one answered.',
    fetch: [
      'Found unanswered delivery question',
      'Missing warehouse confirmation',
      'Prepared safe checking reply',
    ],
  },
  {
    title: 'Complaint recovery',
    mess: 'Driver crashed, parcel damaged, customer angry.',
    fetch: [
      'Facts checklist: order ID, photos, driver report, delivery time, damage description',
      'Prepared calm reply',
      'Boundary: no refund/liability promise until facts confirmed',
    ],
  },
];

function FetchDemoCard({ demo, index }) {
  return (
    <article className="gk-fetch-demo-card">
      <div className="gk-fetch-demo-mess">
        <span className="gk-fetch-demo-label">Mess {String(index + 1).padStart(2, '0')}</span>
        <h3>{demo.title}</h3>
        <p>{demo.mess}</p>
      </div>
      <div className="gk-fetch-demo-arrow" aria-hidden="true">→</div>
      <div className="gk-fetch-card" aria-label={`${demo.title} Fetch Card`}>
        <div className="gk-fetch-card-topline">
          <span>GoodKiddo Fetch Card</span>
          <strong>Telegram</strong>
        </div>
        <ul>
          {demo.fetch.map((item) => (
            <li key={item}>{item}</li>
          ))}
        </ul>
      </div>
    </article>
  );
}

function NotCrmFetchDemo() {
  return (
    <section className="gk-section gk-not-crm-demo" aria-labelledby="not-crm-fetch-demo-title">
      <div className="gk-section-heading gk-section-heading-row">
        <div>
          <p className="gk-kicker">Not a CRM</p>
          <h2 id="not-crm-fetch-demo-title">The dog just noticed what the CRM usually misses.</h2>
        </div>
        <p>
          CRMs organize pipelines. GoodKiddo fetches one usable draft, checklist, or missing question from the chat — compact enough to use, edit, or ignore.
        </p>
      </div>

      <div className="gk-fetch-demo-grid" aria-label="Messy Telegram business situations turned into Fetch Cards">
        {demos.map((demo, index) => (
          <FetchDemoCard demo={demo} index={index} key={demo.title} />
        ))}
      </div>

      <div className="gk-fetch-demo-cta">
        Send one messy Telegram business situation. GoodKiddo will fetch one draft, checklist, or missing question. No setup. If it’s wrong, it’s just text.
      </div>
    </section>
  );
}

export { NotCrmFetchDemo };
