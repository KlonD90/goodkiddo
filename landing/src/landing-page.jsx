import React from 'react';
import posthog from 'posthog-js';
import LogoImage from './kiddo-logo.jpg';
import TennisBallImage from './tennis-ball.png';
import HeroPieceBallImage from './hero-piece-ball.png';
import HeroPieceConfettiImage from './hero-piece-confetti.png';
import HeroPiecePhoneImage from './hero-piece-phone.png';
import HeroStickerBubbleImage from './hero-sticker-bubble.png';
import HeroStickerBurstImage from './hero-sticker-burst.png';
import HeroStickerCloudImage from './hero-sticker-cloud.png';

const TELEGRAM_URL = 'https://t.me/goodkiddo_bot';

const proofItems = [
  {
    title: 'Fetch',
    body: 'GoodKiddo reads messy business chat and brings back one safe next move the team almost missed.',
    hint: 'found in chat',
  },
  {
    title: 'Ask in Chat',
    body: 'When someone mentions GoodKiddo directly, it answers with a draft, summary, checklist, or small research note.',
    hint: '@GoodKiddo reply',
  },
  {
    title: 'Prepared Moves',
    body: 'It drafts when safe, makes checklists, summarizes issues, and suggests one practical action instead of asking noisy permission questions.',
    hint: 'ready before ask',
  },
  {
    title: 'Source First',
    body: 'Each fetch says what it found, what it prepared, and what is still missing or needs a human.',
    hint: 'why + source',
  },
  {
    title: 'Final Call',
    body: 'GoodKiddo prepares the useful work, but the human still sends, refunds, changes prices, and decides.',
    hint: 'human sends',
  },
];

const useCases = [
  {
    before: 'Wrong ',
    trigger: 'key',
    tail: 'and client opens in 20 minutes.',
    fetch: 'Wrote the client update, listed backup access options, flagged owner call.',
    source: 'service',
  },
  {
    before: 'Driver says parcel 48392 may be ',
    trigger: 'damaged',
    tail: 'after a small crash.',
    fetch: 'Drafted customer update, made driver photo checklist, separated delivery decision.',
    source: 'courier',
  },
  {
    before: 'Package arrived ',
    trigger: 'late',
    tail: 'and customer wants a refund.',
    fetch: 'Drafted calm reply, marked missing delivery date, promise, and refund policy.',
    source: 'refund risk',
  },
  {
    before: 'Part price went ',
    trigger: 'up',
    tail: 'but client still has the old estimate.',
    fetch: 'Wrote update with old price, new price, and why it changed. Final call stays human.',
    source: 'repair quote',
  },
  {
    before: 'Milk supplier raised prices ',
    trigger: '12%',
    tail: 'this week.',
    fetch: 'Drafted supplier pushback and marked menu items most likely to lose margin.',
    source: 'cafe margin',
  },
  {
    before: 'Kitchen quote is ',
    trigger: 'stuck',
    tail: 'because measurements are missing.',
    fetch: 'Wrote client message asking for two photos and three measurements.',
    source: 'contractor',
  },
  {
    before: 'Founder dropped a messy ',
    trigger: 'voice note',
    tail: 'about a restaurant lead.',
    fetch: 'Turned it into a lead summary, first email draft, and two missing basics.',
    source: 'lead',
  },
  {
    before: 'Customer asks if chocolate cake is ',
    trigger: 'nut-free',
    tail: 'before pickup.',
    fetch: 'Drafted a safe reply and listed sponge, frosting, topping, shared equipment to check.',
    source: 'food safety',
  },
];

function capture(event, properties = {}) {
  posthog.capture(event, { ...properties, transport: 'sendBeacon' });
}

function PettableDog({ className = '', label = 'Pet GoodKiddo' }) {
  const [isPetted, setIsPetted] = React.useState(false);
  const timeoutRef = React.useRef(null);

  function petDog() {
    if (timeoutRef.current) {
      window.clearTimeout(timeoutRef.current);
    }

    setIsPetted(false);
    window.requestAnimationFrame(() => {
      setIsPetted(true);
      capture('mascot_petted', { location: label });
      timeoutRef.current = window.setTimeout(() => setIsPetted(false), 900);
    });
  }

  React.useEffect(() => () => {
    if (timeoutRef.current) {
      window.clearTimeout(timeoutRef.current);
    }
  }, []);

  return (
    <button
      className={`gk-pet-dog ${isPetted ? 'is-petted' : ''} ${className}`}
      type="button"
      aria-label={label}
      onClick={petDog}
    >
      <img src={LogoImage} alt="" />
      <span aria-hidden="true">good dog</span>
    </button>
  );
}

function Nav() {
  return (
    <header className="gk-nav">
      <div className="gk-brand">
        <PettableDog className="gk-pet-dog-nav" label="Pet GoodKiddo nav mascot" />
        <a className="gk-brand-text" href="#top" aria-label="GoodKiddo home">GoodKiddo</a>
      </div>
      <nav className="gk-nav-links" aria-label="Primary navigation">
        <a href="#work">Work</a>
        <a href="#values">Values</a>
        <a href="#start">Start</a>
      </nav>
      <a
        className="gk-button gk-button-dark"
        href={`${TELEGRAM_URL}?start=landing_nav`}
        onClick={() => capture('nav_telegram_clicked', { location: 'nav' })}
      >
        Open Telegram
      </a>
    </header>
  );
}

function HeroPreviewLab() {
  return (
    <div className="gk-composed-hero-art">
      <img className="gk-hero-confetti gk-hero-confetti-one" src={HeroPieceConfettiImage} alt="" aria-hidden="true" />
      <img className="gk-hero-confetti gk-hero-confetti-two" src={HeroPieceConfettiImage} alt="" aria-hidden="true" />
      <div className="gk-hero-sticker gk-hero-sticker-burst" aria-hidden="true">
        <img src={HeroStickerBurstImage} alt="" />
        <span>Fetch<br />like a<br />pro!</span>
      </div>
      <div className="gk-hero-sticker gk-hero-sticker-keys" aria-hidden="true">
        <img src={HeroStickerBubbleImage} alt="" />
        <span>No keys.<br />No problem.</span>
      </div>
      <div className="gk-hero-sticker gk-hero-sticker-cloud" aria-hidden="true">
        <img src={HeroStickerCloudImage} alt="" />
        <span>Brings the<br />ball back</span>
      </div>
      <div className="gk-hero-phone-piece" aria-label="GoodKiddo Telegram preview">
        <img src={HeroPiecePhoneImage} alt="" aria-hidden="true" />
        <PettableDog className="gk-pet-dog-phone-art" label="Pet GoodKiddo phone mascot" />
      </div>
      <img className="gk-hero-ball-piece" src={HeroPieceBallImage} alt="" aria-hidden="true" />
      <div className="gk-hero-sticker gk-hero-sticker-done" aria-hidden="true">
        <img src={HeroStickerBurstImage} alt="" />
        <span>Draft!<br />Pause!<br />Done!</span>
      </div>
    </div>
  );
}

function Hero() {
  return (
    <section id="top" className="gk-hero">
      <div className="gk-hero-copy">
        <p className="gk-kicker">Friendly business dog in Telegram</p>
        <h1>Fetch one safe <span>next move</span>.</h1>
        <p className="gk-hero-lede">
          GoodKiddo fetches one safe next move from your business chat. It reads the mess, finds the signal, prepares the useful work, and shows what still needs a human.
        </p>
        <div className="gk-fetch-note" aria-label="GoodKiddo example nudge">
          <PettableDog label="Pet GoodKiddo hero mascot" />
          <div>
            <strong>Fetch Card: found, prepared, missing.</strong>
            <p>One compact return from the chat. Human owns the final move.</p>
          </div>
        </div>
        <div className="gk-hero-actions">
          <a
            className="gk-button gk-button-dark"
            href={`${TELEGRAM_URL}?start=landing_hero`}
            onClick={() => capture('hero_cta_clicked', { location: 'hero' })}
          >
            Start in Telegram
          </a>
          <a
            className="gk-button gk-button-ghost"
            href="#work"
            onClick={() => capture('hero_secondary_clicked', { location: 'hero' })}
          >
            See the work
          </a>
        </div>
      </div>
      <div className="gk-hero-panel" aria-label="GoodKiddo Telegram preview">
        <HeroPreviewLab />
      </div>
    </section>
  );
}

function Systems() {
  return (
    <section id="work" className="gk-section gk-systems">
      <div className="gk-section-heading">
        <p className="gk-kicker">How it works</p>
        <h2>Messy chat in. One Fetch back.</h2>
        <p>
          It is not a report, dashboard, or reminder pile. GoodKiddo finds the business signal, prepares the safe work, and leaves final action to the human.
        </p>
      </div>
      <div className="gk-feature-grid">
        <article className="gk-feature-card gk-feature-card-main">
          <div>
            <p className="gk-kicker">Fetch card</p>
            <h3>{proofItems[0].title}</h3>
            <p>{proofItems[0].body}</p>
          </div>
          <div className="gk-shot-preview" aria-label="Fetch Card structure">
            <div className="gk-shot-dog">
              <PettableDog className="gk-pet-dog-small" label="Pet GoodKiddo Fetch mascot" />
              <span>fetching the useful bit</span>
            </div>
            <span className="gk-shot-bubble"><strong>Found</strong> Valentine orders #214 and #229 are blocked</span>
            <span className="gk-shot-bubble"><strong>Prepared</strong> Two address clarification texts</span>
            <span className="gk-shot-bubble"><strong>Missing</strong> 4:30pm cutoff needs a human</span>
          </div>
        </article>
        {proofItems.slice(1).map((item) => (
          <article className="gk-feature-card" key={item.title}>
            <div>
              <span className="gk-card-hint">{item.hint}</span>
              <h3>{item.title}</h3>
            </div>
            <p>{item.body}</p>
          </article>
        ))}
      </div>
    </section>
  );
}

function UseCases() {
  return (
    <section className="gk-section gk-usecases">
      <div className="gk-section-heading gk-section-heading-row">
        <div>
          <p className="gk-kicker">Where it starts</p>
          <h2>The Fetch comes from the chat.</h2>
        </div>
        <p>
          Customer replies, order issues, price changes, competitor links, and direct questions become compact Fetch Cards.
        </p>
      </div>
      <div className="gk-signal-marquee" aria-label="Examples of chat signals and Fetch Cards">
        <div className="gk-signal-track">
          {[...useCases, ...useCases].map((item, index) => (
            <article className="gk-usecase-card" key={`${item.trigger}-${index}`}>
              <div className="gk-chat-side">
                <span>Chat says</span>
                <p>
                  {item.before}
                  <strong>{item.trigger}</strong>
                  {item.tail ? ` ${item.tail}` : ''}
                </p>
              </div>
              <div className="gk-cause-arrow" aria-hidden="true">↓</div>
              <div className="gk-shot-side">
                <span>GoodKiddo fetches</span>
                <p>{item.fetch}</p>
                <strong>{item.source}</strong>
              </div>
            </article>
          ))}
        </div>
      </div>
    </section>
  );
}

function Values() {
  return (
    <section id="values" className="gk-section gk-values gk-safety">
      <div className="gk-safety-copy">
        <div className="gk-safety-head">
          <p className="gk-kicker">Dog with no keys</p>
          <h2>
            Other agents have your <span className="gk-mark-keys">keys</span>. This one has a{' '}
            <span className="gk-mark-ball">tennis ball</span>.
          </h2>
        </div>
        <div className="gk-tennis-note" aria-label="GoodKiddo only fetches text">
          <img className="gk-tennis-ball" src={TennisBallImage} alt="" />
          <div className="gk-tennis-copy">
            <p>The danger is wrong with keys.</p>
            <p>GoodKiddo only brings the ball back: drafts, checklists, missing questions, and notes.</p>
            <strong>If it misses, it is just text.</strong>
          </div>
        </div>
      </div>
      <div className="gk-safety-stage" aria-label="Fetch does not execute">
        <article className="gk-safety-card gk-safety-danger">
          <div className="gk-danger-visual" aria-hidden="true">
            <span>Send</span>
            <span>$</span>
            <span>Post</span>
            <span>Keys</span>
          </div>
          <p className="gk-card-hint">Stupid with permissions</p>
          <h3>Sends first. Explains later.</h3>
          <ul>
            <li>Sends the email</li>
            <li>Moves the money</li>
            <li>Posts under your name</li>
            <li>Calls it “done”</li>
            <li>Leaves you holding the leash</li>
          </ul>
        </article>

        <div className="gk-safety-divider" aria-hidden="true">
          <span>Fetch, not execute.</span>
        </div>

        <article className="gk-safety-card gk-safety-fetch">
          <div className="gk-fetch-visual">
            <PettableDog className="gk-pet-dog-safety" label="Pet GoodKiddo safety mascot" />
            <div>
              <span>Telegram</span>
              <strong>Draft ready. Nothing sent.</strong>
            </div>
          </div>
          <p className="gk-card-hint">GoodKiddo Fetch</p>
          <h3>Useful when right. Harmless when wrong.</h3>
          <ul>
            <li>Brings back drafts</li>
            <li>Makes checklists</li>
            <li>Finds missing questions</li>
            <li>Prepares quick notes</li>
            <li>Stops inside Telegram</li>
          </ul>
          <p className="gk-safety-small">If it’s wrong, it’s just text. Use it, edit it, or ignore it.</p>
        </article>
      </div>
      <p className="gk-safety-tagline">GoodKiddo Fetch. Useful when right. Harmless when wrong.</p>
    </section>
  );
}

function FinalCTA() {
  return (
    <section id="start" className="gk-final">
      <div>
        <p className="gk-kicker">Start with one thing</p>
        <h2>Add GoodKiddo to your business chat.</h2>
      </div>
      <div className="gk-final-copy">
        <p>
          Ask it directly when you need help, or let it fetch one safe next move from the chat.
        </p>
        <a
          className="gk-button gk-button-light"
          href={`${TELEGRAM_URL}?start=landing_final`}
          onClick={() => capture('final_cta_clicked', { location: 'final' })}
        >
          Open Good Kiddo
        </a>
      </div>
    </section>
  );
}

function LandingPage() {
  return (
    <main className="gk-page overflow-x-hidden w-full max-w-full">
      <Nav />
      <Hero />
      <Systems />
      <UseCases />
      <Values />
      <FinalCTA />
    </main>
  );
}

export { LandingPage };
