import React from 'react';
import posthog from 'posthog-js';
import { BURGUNDY, INK, MINT, MINT_DK, MUTE, OCHRE, PAPER, SHIBA } from './dossier';
import { ChatFrame, Bubble, DayDivider } from './chat-mockup';
import LogoImage from './kiddo-logo.jpg'
// hero.jsx — v2 "Operator's Dossier" hero: editorial masthead, annotated phone.

const HERO_THREADS = [
  {
    tag: 'BIZ DEV',
    subtitle: 'running your outbound framework · 09:14',
    bot1: "Found 4 new contacts matching your framework (brand leads · 20–80 people · rebranded in last 18mo). First-touch emails drafted in your voice. Day-4 follow-ups queued.",
    bot2: "Approve the batch and I'll send Monday 9am. I'll pause anyone who replies.",
    attachment: {
      kind: 'contacts',
      contacts: [
        { name: 'Elena Richter', role: 'Head of Brand · Studio Nord', status: 'ready' },
        { name: 'Marco Halloway', role: 'Founder · Field & Co', status: 'ready' },
        { name: 'Priya Shah', role: 'Creative Dir · North Room', status: 'ready' },
        { name: 'Tom Okafor', role: 'Partner · Able Studios', status: 'ready' },
      ],
    },
    replyMe: "Approve. Ship Monday.",
  },
  {
    tag: 'CAMPAIGN',
    subtitle: 'spring launch · shipping friday',
    bot1: "Launch is Friday. Campaign's written: 10 captions ranked by on-voice-ness, 3 posting slots blocked, 2 A/B subject lines.",
    bot2: "Top 3 captions:\n\n1. The window's open. So is the season.\n2. New scent. Same slow mornings.\n3. Small rituals, warm rooms.\n\nApprove schedule?",
    replyMe: "Use #1 for Friday. Reshuffle the rest.",
  },
  {
    tag: 'DECK',
    subtitle: 'board review · thursday',
    bot1: "Board review is Thursday. Draft deck ready — structure built from last month's notes. Slide 5 is your decision ask.",
    bot2: "Editable .pptx attached. Want me to walk it with you in chat?",
    attachment: {
      kind: 'doc',
      ext: 'pptx',
      color: '#E67E22',
      name: 'Board Review · Q1 2026.pptx',
      size: '2.4 MB',
      meta: '7 slides · speaker notes',
    },
    replyMe: "Walk slide 5 with me.",
  },
  {
    tag: 'NUMBERS',
    subtitle: 'weekly revenue · flagged',
    bot1: "Last week in. Two flags worth your eyes: Paid is down 18% on flat spend. Email spiked +22% — last newsletter did work.",
    bot2: "Everything else steady. Pasting the summary below.",
    attachment: {
      kind: 'table',
      title: 'Revenue by channel · week 16',
      rows: [
        ['Organic', '14.2k', '+8%'],
        ['Paid', ' 9.1k', '-18% ⚑'],
        ['Email', ' 5.8k', '+22% ⚑'],
        ['Referral', ' 3.4k', '+3%'],
      ],
      footer: 'Paid needs eyes — flat spend, down 18%',
    },
    replyMe: "Dig into paid. Reply tomorrow 9am.",
  },
];

function HeroThread({ threadIndex = 0 }) {
  const t = HERO_THREADS[threadIndex];
  return (
    <ChatFrame theme="light" title="Good Kiddo" subtitle={t.subtitle}>
      <DayDivider theme="light">Today</DayDivider>
      <Bubble from="them" theme="light" time="09:14">{t.bot1}</Bubble>
      <Bubble from="them" theme="light" time="09:14" attachment={t.attachment}>{t.bot2}</Bubble>
      <Bubble from="me" theme="light" time="09:15">{t.replyMe}</Bubble>
    </ChatFrame>
  );
}

function Hero() {
  const [idx, setIdx] = React.useState(0);
  React.useEffect(() => {
    const id = setInterval(() => setIdx(i => (i + 1) % HERO_THREADS.length), 5200);
    return () => clearInterval(id);
  }, []);

  const t = HERO_THREADS[idx];

  return (
    <section className="gk-hero-section" style={{
      padding: '28px 60px 120px',
      position: 'relative',
      overflow: 'hidden',
      minHeight: 900,
    }}>
      {/* Masthead */}
      <div className="gk-hero-header" style={{
        display: 'flex', alignItems: 'center', justifyContent: 'space-between',
        paddingBottom: 14, borderBottom: `2px solid ${INK}`, marginBottom: 8,
      }}>
        <div style={{
          fontFamily: '"Fraunces", Georgia, serif',
          fontSize: 26, fontWeight: 500, letterSpacing: -0.5,
          color: INK, display: 'flex', alignItems: 'center', gap: 14,
        }}>
          <img src={LogoImage} alt="Good Kiddo"
            style={{
              width: 52, height: 52, borderRadius: '50%',
              display: 'block', objectFit: 'cover',
              border: `1.5px solid ${INK}`,
              boxShadow: `3px 3px 0 ${SHIBA}`,
            }}
          />
          Good Kiddo
          <span className="gk-hero-tagline" style={{
            fontFamily: '"JetBrains Mono", monospace', fontSize: 10,
            color: MUTE, letterSpacing: 1.5, textTransform: 'uppercase',
            marginLeft: 8,
          }}>a friendly sidekick · lives in Telegram</span>
        </div>
        <nav className="gk-hero-nav" style={{
          display: 'flex', gap: 28,
          fontFamily: '"JetBrains Mono", monospace', fontSize: 11,
          color: INK, letterSpacing: 1.2, textTransform: 'uppercase',
        }}>
          <a href="#what" style={{ textDecoration: 'none' }}>What it is</a>
          <a href="#do" style={{ textDecoration: 'none' }}>What it does</a>
          <a href="#how" style={{ textDecoration: 'none' }}>How it works</a>
          <a href="https://t.me/goodkiddo_bot?start=landing_nav" className="gk-nav-cta"
            onClick={() => posthog.capture('nav_telegram_clicked', { location: 'nav', transport: 'sendBeacon' })}
            style={{
              textDecoration: 'none', padding: '6px 14px',
              background: INK, color: PAPER, borderRadius: 0,
            }}>Open in Telegram →</a>
        </nav>
      </div>
      {/* Thin rule line */}
      <div style={{ height: 3, background: 'transparent', borderBottom: `1px solid ${INK}`, marginBottom: 20 }} />

      {/* Issue line */}
      <div className="gk-hero-issueline" style={{
        display: 'flex', justifyContent: 'space-between', alignItems: 'center',
        fontFamily: '"JetBrains Mono", monospace', fontSize: 10,
        color: MUTE, letterSpacing: 2, textTransform: 'uppercase',
        marginBottom: 56,
      }}>
        <span>Volume I · Issue 1</span>
        <span>For founders and small teams who'd like a life back</span>
        <span>Your first Kiddo note arrives tomorrow, 9 am</span>
      </div>

      {/* Main grid */}
      <div className="gk-hero-grid" style={{
        display: 'grid', gridTemplateColumns: '1.15fr 0.85fr', gap: 60,
        alignItems: 'start', position: 'relative',
      }}>
        {/* LEFT — oversized editorial headline */}
        <div style={{ position: 'relative' }}>
          {/* Display number */}
          <div style={{
            fontFamily: '"Fraunces", Georgia, serif', fontSize: 14,
            color: BURGUNDY, letterSpacing: 1.5, textTransform: 'uppercase',
            fontWeight: 600, marginBottom: 24,
            display: 'flex', alignItems: 'center', gap: 14,
          }}>
            <span style={{ width: 28, height: 1.5, background: BURGUNDY }} />
            Dossier № 001 — The sidekick you didn't know you needed
          </div>

          <h1 style={{
            fontFamily: '"Fraunces", Georgia, serif',
            fontSize: 'clamp(64px, 6.4vw, 112px)',
            fontWeight: 300,
            lineHeight: 0.9,
            letterSpacing: -4,
            margin: 0,
            color: INK,
            textWrap: 'balance',
          }}>
            Kiddo opens<br />
            <em style={{
              fontStyle: 'italic', color: BURGUNDY, fontWeight: 400,
              fontVariationSettings: '"opsz" 96',
            }}>the thread.</em><br />
            You <span style={{
              background: INK, color: PAPER, padding: '0 20px 0 14px',
              fontStyle: 'normal', fontWeight: 400,
              display: 'inline-block', transform: 'skew(-4deg)',
              marginLeft: -2, marginRight: 4,
            }}>stay in charge.</span>
          </h1>

          {/* Big rule + body */}
          <div className="gk-hero-meta" style={{
            marginTop: 48, display: 'grid', gridTemplateColumns: '1fr 1.4fr', gap: 32,
            alignItems: 'start',
          }}>
            <div style={{
              fontFamily: '"JetBrains Mono", monospace', fontSize: 11,
              color: MUTE, letterSpacing: 1.8, textTransform: 'uppercase',
              lineHeight: 1.5, borderTop: `1px solid ${INK}`, paddingTop: 14,
            }}>
              ↓ Kiddo drafts the work.<br />
              You read it with coffee.<br />
              Yes, no, or try again.
            </div>
            <p style={{
              margin: 0, fontFamily: '"Fraunces", Georgia, serif',
              fontSize: 22, lineHeight: 1.42, color: INK,
              textWrap: 'pretty', letterSpacing: -0.3,
              borderTop: `1px solid ${INK}`, paddingTop: 14,
            }}>
              Good Kiddo is a <strong style={{ color: BURGUNDY }}>friendly AI sidekick</strong> for solo founders
              and small teams. Tell Kiddo how you like things done — once, in plain words — and it will
              show up in your Telegram every morning with the work teed up. You stay in charge of every call.
            </p>
          </div>

          {/* Pills */}
          <div style={{
            marginTop: 56, display: 'flex', gap: 10, flexWrap: 'wrap',
          }}>
            {[
              ['I.', 'Biz-dev'],
              ['II.', 'Launches'],
              ['III.', 'Decks'],
              ['IV.', 'Numbers'],
              ['V.', 'Your voice'],
            ].map(([r, p]) => (
              <div key={p} style={{
                padding: '7px 14px', border: `1.5px solid ${INK}`,
                display: 'inline-flex', alignItems: 'baseline', gap: 8,
                fontFamily: '"JetBrains Mono", monospace', fontSize: 11,
                color: INK, letterSpacing: 1, textTransform: 'uppercase',
                background: 'transparent',
              }}>
                <span style={{
                  fontFamily: '"Fraunces", serif', fontStyle: 'italic',
                  color: BURGUNDY, fontSize: 14,
                }}>{r}</span>
                {p}
              </div>
            ))}
          </div>

          {/* Hero CTA */}
          <div style={{ marginTop: 40, display: 'flex', gap: 14, flexWrap: 'wrap', alignItems: 'center' }}>
            <a href="https://t.me/goodkiddo_bot?start=landing_hero"
              onClick={() => posthog.capture('hero_cta_clicked', { location: 'hero', transport: 'sendBeacon' })}
              style={{
                display: 'inline-flex', alignItems: 'center', gap: 12,
                padding: '16px 28px', background: INK, color: PAPER,
                fontFamily: '"JetBrains Mono", monospace', fontSize: 12,
                fontWeight: 700, letterSpacing: 2, textTransform: 'uppercase',
                textDecoration: 'none',
                boxShadow: `4px 4px 0 ${BURGUNDY}`,
              }}>
              Start talking
              <span style={{ fontSize: 16 }}>→</span>
            </a>
          </div>
        </div>

        {/* RIGHT — annotated phone */}
        <div className="gk-hero-phone" style={{ position: 'relative', paddingTop: 20 }}>
          {/* Phone wrapper with tilt */}
          <div style={{
            position: 'relative',
            transform: 'rotate(2.2deg)',
            filter: 'drop-shadow(16px 20px 0 rgba(26, 23, 20, 0.12))',
          }}>
            {/* Phone bezel */}
            <div style={{
              background: '#0B0B0D',
              padding: '18px 14px 22px',
              borderRadius: 52,
              width: 420,
              margin: '0 auto',
              position: 'relative',
              boxShadow: `
                inset 0 0 0 2px #2A2A2D,
                0 0 0 1px #000
              `,
            }}>
              {/* Notch */}
              <div style={{
                position: 'absolute', top: 22, left: '50%', transform: 'translateX(-50%)',
                width: 96, height: 30, background: '#000', borderRadius: 20, zIndex: 10,
              }} />
              <div style={{
                background: '#fff', borderRadius: 38, overflow: 'hidden',
                height: 760, display: 'flex', flexDirection: 'column',
                position: 'relative',
              }}>
                {/* Status bar */}
                <div style={{
                  padding: '16px 28px 8px', display: 'flex',
                  justifyContent: 'space-between', alignItems: 'center',
                  fontSize: 13, fontWeight: 600, color: '#000',
                  fontFamily: '-apple-system, "SF Pro Text", system-ui, sans-serif',
                  position: 'relative', zIndex: 5,
                }}>
                  <span>9:41</span>
                  <span style={{ display: 'flex', gap: 5, alignItems: 'center' }}>
                    <svg width="17" height="11" viewBox="0 0 17 11" fill="#000">
                      <rect x="0" y="7" width="3" height="4" rx="0.5" />
                      <rect x="5" y="5" width="3" height="6" rx="0.5" />
                      <rect x="10" y="2" width="3" height="9" rx="0.5" />
                      <rect x="15" y="0" width="3" height="11" rx="0.5" opacity="0.3" />
                    </svg>
                    <svg width="15" height="11" viewBox="0 0 15 11" fill="none" stroke="#000" strokeWidth="1.2">
                      <path d="M7.5 2.5 C4 2.5 1.5 4.5 1 5.5" />
                      <path d="M7.5 5 C5.5 5 4 6 3.5 6.5" />
                      <circle cx="7.5" cy="8.5" r="1" fill="#000" />
                    </svg>
                    <div style={{
                      width: 24, height: 11, borderRadius: 3,
                      border: '1px solid #000', position: 'relative', padding: 1,
                    }}>
                      <div style={{ background: '#000', height: '100%', width: '75%', borderRadius: 1 }} />
                    </div>
                  </span>
                </div>
                {/* Chat frame inside */}
                <div style={{ flex: 1, padding: '0 0 0', overflow: 'hidden' }}>
                  <HeroThread threadIndex={idx} />
                </div>
              </div>
            </div>
          </div>

          {/* Margin annotations */}
          <div style={{
            position: 'absolute', top: 70, left: -40,
            fontFamily: '"Caveat", cursive', fontSize: 26, color: BURGUNDY,
            transform: 'rotate(-6deg)', lineHeight: 1.1, maxWidth: 150,
          }}>
            pings you first
            <svg width="60" height="30" viewBox="0 0 60 30" style={{ display: 'block', marginTop: 4 }}>
              <path d="M2 4 Q 30 10, 55 26" stroke={BURGUNDY} strokeWidth="1.5" fill="none" strokeLinecap="round" />
              <path d="M50 22 L 55 26 L 50 28" stroke={BURGUNDY} strokeWidth="1.5" fill="none" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
          </div>

          <div style={{
            position: 'absolute', top: 360, right: -20,
            fontFamily: '"Caveat", cursive', fontSize: 24, color: BURGUNDY,
            transform: 'rotate(5deg)', lineHeight: 1.1, maxWidth: 170, textAlign: 'right',
          }}>
            real .pptx —<br />
            not a mockup
            <svg width="60" height="30" viewBox="0 0 60 30" style={{ display: 'block', marginLeft: 'auto', marginTop: 4 }}>
              <path d="M58 4 Q 30 10, 5 26" stroke={BURGUNDY} strokeWidth="1.5" fill="none" strokeLinecap="round" />
              <path d="M10 22 L 5 26 L 10 28" stroke={BURGUNDY} strokeWidth="1.5" fill="none" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
          </div>

          <div style={{
            position: 'absolute', bottom: 40, left: -60,
            fontFamily: '"Caveat", cursive', fontSize: 26, color: BURGUNDY,
            transform: 'rotate(-3deg)', lineHeight: 1.1, maxWidth: 200,
          }}>
            approve in one tap —<br />
            nothing ships without you
          </div>

          {/* Rotating tag indicator */}
          <div style={{
            position: 'absolute', top: -10, right: 20, zIndex: 20,
            background: PAPER, padding: '6px 12px',
            border: `1.5px solid ${INK}`,
            fontFamily: '"JetBrains Mono", monospace', fontSize: 10,
            color: INK, letterSpacing: 1.5, textTransform: 'uppercase',
            display: 'flex', alignItems: 'center', gap: 8,
            boxShadow: `3px 3px 0 ${OCHRE}`,
          }}>
            <span style={{
              display: 'inline-block', width: 8, height: 8, borderRadius: '50%',
              background: MINT_DK, animation: 'gkpulse 1.2s infinite',
              boxShadow: `0 0 6px ${MINT}`,
            }} />
            LIVE · {t.tag}
          </div>
          <style>{`@keyframes gkpulse { 0%,100% { opacity: 1; } 50% { opacity: 0.3; } }`}</style>
        </div>
      </div>
    </section>
  );
}

export { Hero, HeroThread, HERO_THREADS };
