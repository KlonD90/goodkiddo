import React from 'react';
import posthog from 'posthog-js';
import LogoImage from './kiddo-logo.jpg';
// dossier.jsx — shared tokens + editorial primitives for the Operator's Dossier

// ═══ Color tokens ══════════════════════════════════════
const PAPER = '#F5EFE3';   // warm cream (matches logo bg)
const PAPER_2 = '#FBF6EB';   // slightly brighter card/surface
const INK = '#1E1A17';   // near-black, warm (logo outlines)
const SHIBA = '#E8822A';   // Shiba-orange — primary accent
const SHIBA_DK = '#B85A14';   // deeper orange for emphasis
const MINT = '#6FE3B2';   // CRT-green — "live / active" signal
const MINT_DK = '#2D9E75';   // readable mint for small type
const CHAR = '#2B2825';   // charcoal (headset)
const CREAM = '#F3E6C9';   // muzzle cream
const MUTE = '#7A6E5F';   // warm gray for secondary text
const RULE = '#C7BDA9';   // hairlines
const OCHRE = '#C69A4A';   // aged gold (kept for stamp shadows)
const BURGUNDY = SHIBA_DK;    // alias — primary editorial accent → shiba
const OLIVE = MINT_DK;     // alias — secondary accent → mint
const TG_BLUE = '#2AABEE';   // reserved for chat mockup only

export { PAPER, PAPER_2, INK, SHIBA, SHIBA_DK, MINT, MINT_DK, CHAR, CREAM, MUTE, RULE, OCHRE, BURGUNDY, OLIVE, TG_BLUE };

// ═══ Chapter header — oversized editorial roman + kicker ══════════
function Chapter({ roman, kicker, title, align = 'left', id }) {
  return (
    <div id={id} className="gk-chapter-grid" style={{
      display: 'grid',
      gridTemplateColumns: '88px 1fr',
      gap: 24,
      alignItems: 'baseline',
      marginBottom: 56,
    }}>
      <div style={{
        fontFamily: '"Fraunces", Georgia, serif',
        fontStyle: 'italic',
        fontSize: 72,
        color: BURGUNDY,
        lineHeight: 0.8,
        fontWeight: 300,
        letterSpacing: -3,
      }}>{roman}</div>
      <div>
        <div style={{
          fontFamily: '"JetBrains Mono", monospace',
          fontSize: 11,
          color: MUTE,
          letterSpacing: 2.5,
          textTransform: 'uppercase',
          marginBottom: 8,
        }}>{kicker}</div>
        <h2 style={{
          margin: 0,
          fontFamily: '"Fraunces", Georgia, serif',
          fontSize: 'clamp(44px, 4.5vw, 72px)',
          lineHeight: 0.95,
          letterSpacing: -2,
          color: INK,
          fontWeight: 400,
          textWrap: 'balance',
          maxWidth: 900,
        }}>{title}</h2>
      </div>
    </div>
  );
}

// ═══ Stamp — ink-style rubber stamp ═══════════════════
function Stamp({ children, rotate = -4, color = INK, size = 12, style = {} }) {
  return (
    <div style={{
      display: 'inline-block',
      padding: '6px 12px',
      border: `2px solid ${color}`,
      color: color,
      fontFamily: '"JetBrains Mono", monospace',
      fontSize: size,
      fontWeight: 700,
      letterSpacing: 2,
      textTransform: 'uppercase',
      transform: `rotate(${rotate}deg)`,
      background: 'transparent',
      position: 'relative',
      opacity: 0.85,
      ...style,
    }}>
      {children}
    </div>
  );
}

export { Chapter, Stamp };

// ═══ Mascot badge — small circular headshot with headset-wire annotation ══
function MascotBadge({ size = 60, tilt = 0, caption, captionSide = 'right' }) {
  return (
    <div style={{
      display: 'inline-flex', alignItems: 'center', gap: 10,
      flexDirection: captionSide === 'left' ? 'row-reverse' : 'row',
    }}>
      <img src={LogoImage} alt="Good Kiddo mascot"
        style={{
          width: size, height: size, borderRadius: '50%',
          display: 'block', objectFit: 'cover',
          border: `1.5px solid ${INK}`,
          boxShadow: `3px 3px 0 ${SHIBA}`,
          transform: `rotate(${tilt}deg)`,
          flexShrink: 0,
        }}
      />
      {caption && (
        <div style={{
          fontFamily: '"Caveat", cursive', fontSize: 20, color: SHIBA_DK,
          lineHeight: 1.1, maxWidth: 160,
          textAlign: captionSide === 'left' ? 'right' : 'left',
        }}>{caption}</div>
      )}
    </div>
  );
}

export { MascotBadge };

// ═══ Section: What it is ═══════════════════════════════
function WhatItIs() {
  return (
    <section id="what" className="gk-section" style={{
      padding: '140px 60px 80px', maxWidth: 1320, margin: '0 auto',
      borderTop: `2px solid ${INK}`,
      position: 'relative',
    }}>
      {/* Floating mascot in the margin */}
      <div className="gk-mascot-float" style={{ position: 'absolute', top: 100, right: 80, zIndex: 3 }}>
        <MascotBadge size={96} tilt={-6} caption={"say hi.\nI'm on headset."} captionSide="left" />
      </div>
      <Chapter
        roman="I."
        kicker="The premise · one page"
        title="Not a chatbot. A workhorse with a Telegram address."
      />
      <div className="gk-section-content gk-3col" style={{
        display: 'grid',
        gridTemplateColumns: '1fr 1fr 1fr',
        gap: 40,
        paddingLeft: 112,
      }}>
        {[
          {
            t: 'Proactive, not reactive.',
            b: "Most AI waits for you to ask. Good Kiddo opens the thread — drafts ready, numbers flagged, decks built — before you type a word.",
          },
          {
            t: 'Runs your frameworks.',
            b: "You tell it once how biz-dev should feel, what voice to use, what numbers to flag. It runs those rules daily. Same quality, every time.",
          },
          {
            t: 'Lives where you already are.',
            b: "No new app. No new tab. It pings you in Telegram — the one place you'd answer a text from a colleague at 9 pm on a Tuesday.",
          },
        ].map((x, i) => (
          <div key={i} style={{
            borderTop: `1px solid ${INK}`, paddingTop: 20,
          }}>
            <div style={{
              fontFamily: '"Fraunces", Georgia, serif', fontStyle: 'italic',
              fontSize: 13, color: BURGUNDY, letterSpacing: 2, textTransform: 'uppercase',
              marginBottom: 12, fontWeight: 600,
            }}>— {String(i + 1).padStart(2, '0')}</div>
            <h4 style={{
              margin: '0 0 12px', fontFamily: '"Fraunces", Georgia, serif',
              fontSize: 28, lineHeight: 1.05, letterSpacing: -0.8,
              color: INK, fontWeight: 500, textWrap: 'balance',
            }}>{x.t}</h4>
            <p style={{
              margin: 0, fontFamily: '"Fraunces", Georgia, serif',
              fontSize: 16.5, lineHeight: 1.5, color: INK,
              textWrap: 'pretty',
            }}>{x.b}</p>
          </div>
        ))}
      </div>
    </section>
  );
}

// ═══ Section: How it works ═════════════════════════════
function HowItWorks() {
  const steps = [
    {
      n: '01',
      t: 'Add the bot.',
      b: 'Open Telegram. Search @goodkiddo. Tap Start. That is the install.',
      detail: 'No App Store. No accounts. No 2FA dance.',
    },
    {
      n: '02',
      t: 'Teach it your frameworks.',
      b: "Tell it who to reach, how to write, what to watch. In plain language — the way you'd brief a person.",
      detail: 'Takes ~10 minutes, once. Edit any time.',
    },
    {
      n: '03',
      t: 'Get pinged in the morning.',
      b: "9:00 your time: drafts, prospects, decks, flags. Approve what's ready, redirect what isn't.",
      detail: 'Snooze for the weekend. Dial up the urgency on launch weeks.',
    },
    {
      n: '04',
      t: 'It remembers, so you don\'t.',
      b: "Every edit teaches it your voice. Every reply shapes the rules. Week four looks nothing like week one.",
      detail: 'Export the memory any time. It\'s yours.',
    },
  ];
  return (
    <section id="how" className="gk-section" style={{
      padding: '140px 60px 100px', maxWidth: 1320, margin: '0 auto',
      borderTop: `2px solid ${INK}`, position: 'relative',
    }}>
      <Chapter
        roman="III."
        kicker="How the relationship works"
        title="Four beats from hello to running-your-morning."
      />
      <div className="gk-section-content gk-4col" style={{
        display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 24,
        paddingLeft: 112,
      }}>
        {steps.map((s, i) => (
          <div key={s.n} style={{
            position: 'relative',
            paddingTop: 20, borderTop: `2px solid ${INK}`,
          }}>
            <div style={{
              fontFamily: '"Fraunces", Georgia, serif', fontStyle: 'italic',
              fontSize: 64, color: BURGUNDY, lineHeight: 0.85,
              fontWeight: 300, letterSpacing: -2, marginBottom: 16,
            }}>{s.n}</div>
            <h4 style={{
              margin: '0 0 10px', fontFamily: '"Fraunces", Georgia, serif',
              fontSize: 24, lineHeight: 1.05, letterSpacing: -0.5,
              color: INK, fontWeight: 500,
            }}>{s.t}</h4>
            <p style={{
              margin: '0 0 14px', fontFamily: '"Fraunces", Georgia, serif',
              fontSize: 15.5, lineHeight: 1.45, color: INK, textWrap: 'pretty',
            }}>{s.b}</p>
            <div style={{
              fontFamily: '"JetBrains Mono", monospace', fontSize: 10,
              color: MUTE, letterSpacing: 1, lineHeight: 1.5,
              textTransform: 'uppercase',
            }}>{s.detail}</div>
            {i < 3 && (
              <div style={{
                position: 'absolute', right: -14, top: 60,
                color: BURGUNDY, fontSize: 22, opacity: 0.6,
                fontFamily: '"Fraunces", serif',
              }}>→</div>
            )}
          </div>
        ))}
      </div>
    </section>
  );
}

// ═══ Section: Memory ═══════════════════════════════════
function Memory() {
  return (
    <section className="gk-section" style={{
      padding: '140px 60px 100px', maxWidth: 1320, margin: '0 auto',
      borderTop: `2px solid ${INK}`, position: 'relative',
    }}>
      <Chapter
        roman="IV."
        kicker="On memory, trust, and voice"
        title="It gets better at being useful to you — specifically."
      />
      <div className="gk-section-content gk-2col" style={{
        display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 64,
        paddingLeft: 112, alignItems: 'start',
      }}>
        {/* Left — narrative */}
        <div>
          <p style={{
            margin: '0 0 22px', fontFamily: '"Fraunces", Georgia, serif',
            fontSize: 21, lineHeight: 1.5, color: INK, textWrap: 'pretty',
            fontStyle: 'italic',
          }}>
            Most assistants start the same on day one as they do on day sixty.
            Good Kiddo does not.
          </p>
          <p style={{
            margin: '0 0 22px', fontFamily: '"Fraunces", Georgia, serif',
            fontSize: 18, lineHeight: 1.55, color: INK, textWrap: 'pretty',
          }}>
            Every time you reject a draft, soften a tone, reroute a lead, or ask
            for a rewrite — it listens. Not in the marketing-copy way. In the
            way a new hire listens in their first month: closely, and forever.
          </p>
          <p style={{
            margin: '0 0 28px', fontFamily: '"Fraunces", Georgia, serif',
            fontSize: 18, lineHeight: 1.55, color: INK, textWrap: 'pretty',
          }}>
            By week four, you stop editing the drafts. By week eight, the
            drafts sound like you wrote them at your desk on a good day.
          </p>
          <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap' }}>
            <Stamp color={BURGUNDY} rotate={-3}>Your voice · 162 edits</Stamp>
            <Stamp color={OLIVE} rotate={2}>Frameworks · 9 active</Stamp>
            <Stamp color={INK} rotate={-1}>Memory export · JSON</Stamp>
          </div>
        </div>

        {/* Right — annotated field notes */}
        <div style={{
          background: PAPER_2, border: `1.5px solid ${INK}`,
          padding: '28px 32px', position: 'relative',
          boxShadow: `6px 6px 0 ${OCHRE}`,
        }}>
          <div style={{
            fontFamily: '"JetBrains Mono", monospace', fontSize: 10,
            color: BURGUNDY, letterSpacing: 2, textTransform: 'uppercase',
            fontWeight: 700, marginBottom: 14, paddingBottom: 10,
            borderBottom: `1px dashed ${RULE}`,
            display: 'flex', justifyContent: 'space-between',
            alignItems: 'center',
          }}>
            <span style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <img src={LogoImage} alt=""
                style={{
                  width: 22, height: 22, borderRadius: '50%',
                  border: `1px solid ${INK}`, objectFit: 'cover',
                }}
              />
              Field notes · things it learned
            </span>
            <span style={{ color: MUTE }}>last 30 days</span>
          </div>
          {[
            { w: 'Week 01', n: "Prefers em-dashes over semicolons. Never uses exclamation marks." },
            { w: 'Week 02', n: "Signs off \"— K\" to clients, \"best\" to investors. Learned the difference." },
            { w: 'Week 03', n: "Tuesday mornings = deep work. Don't ping before 11:00." },
            { w: 'Week 04', n: "Brand voice is quiet-specific. Killed \"unlock\", \"leverage\", \"seamless\" forever." },
            { w: 'Week 05', n: "Approves outreach in batches of 4. More feels overwhelming." },
          ].map((x, i) => (
            <div key={i} style={{
              display: 'grid', gridTemplateColumns: '80px 1fr', gap: 16,
              padding: '10px 0',
              borderTop: i === 0 ? 'none' : `1px dotted ${RULE}`,
            }}>
              <div style={{
                fontFamily: '"JetBrains Mono", monospace', fontSize: 10,
                color: MUTE, letterSpacing: 1, textTransform: 'uppercase',
                paddingTop: 3,
              }}>{x.w}</div>
              <div style={{
                fontFamily: '"Fraunces", Georgia, serif', fontSize: 16,
                color: INK, lineHeight: 1.4, textWrap: 'pretty',
              }}>{x.n}</div>
            </div>
          ))}
          <div style={{
            position: 'absolute', top: -12, right: 20,
          }}>
            <Stamp color={BURGUNDY} rotate={3} size={10} style={{ background: PAPER }}>
              Confidential · yours alone
            </Stamp>
          </div>
        </div>
      </div>
    </section>
  );
}

// ═══ Section: Why ══════════════════════════════════════
function Why() {
  const items = [
    {
      q: 'Why Telegram, not another dashboard?',
      a: "Because you already check it. Dashboards need a visit. Good Kiddo shows up. It's the difference between a colleague and a website.",
    },
    {
      q: 'Why frameworks, not prompts?',
      a: "Prompts reset every conversation. Frameworks run forever. Teach it once how biz-dev should feel — it runs that rule every week until you change your mind.",
    },
    {
      q: 'Why proactive, not on-demand?',
      a: "The things that compound — outreach, follow-ups, weekly reports — are exactly the things you forget to ask for. Good Kiddo remembers so you can do the work that doesn't scale.",
    },
    {
      q: 'Why not just hire an assistant?',
      a: "You will. Good Kiddo covers the first eight hours a week. The hiring decision becomes easier when you already know what good looks like.",
    },
  ];
  return (
    <section className="gk-section" style={{
      padding: '140px 60px 100px', maxWidth: 1320, margin: '0 auto',
      borderTop: `2px solid ${INK}`,
    }}>
      <Chapter
        roman="V."
        kicker="Four questions operators ask"
        title="The reasoning, filed in plain language."
      />
      <div className="gk-section-content gk-2col" style={{
        display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 48,
        paddingLeft: 112,
      }}>
        {items.map((x, i) => (
          <div key={i} style={{
            borderTop: `1.5px solid ${INK}`, paddingTop: 20,
          }}>
            <div style={{
              fontFamily: '"JetBrains Mono", monospace', fontSize: 10,
              color: MUTE, letterSpacing: 1.5, textTransform: 'uppercase',
              marginBottom: 10,
            }}>Q · {String(i + 1).padStart(2, '0')}</div>
            <h4 style={{
              margin: '0 0 14px', fontFamily: '"Fraunces", Georgia, serif',
              fontSize: 30, lineHeight: 1.08, letterSpacing: -0.8,
              color: INK, fontWeight: 500, textWrap: 'balance',
              fontStyle: 'italic',
            }}>{x.q}</h4>
            <p style={{
              margin: 0, fontFamily: '"Fraunces", Georgia, serif',
              fontSize: 17.5, lineHeight: 1.5, color: INK, textWrap: 'pretty',
            }}>{x.a}</p>
          </div>
        ))}
      </div>
    </section>
  );
}

// ═══ Final CTA — broadsheet sign-off ═══════════════════
function FinalCTA() {
  return (
    <section className="gk-section-final" style={{
      padding: '120px 60px 100px', position: 'relative',
      borderTop: `2px solid ${INK}`,
      background: INK, color: PAPER,
      marginTop: 60,
    }}>
      <div style={{ maxWidth: 1320, margin: '0 auto', position: 'relative' }}>
        {/* Mascot — positioned below the issue line, floating between headline and right column */}
        <div className="gk-cta-mascot" style={{
          position: 'absolute', top: 280, right: -20, zIndex: 3,
          transform: 'rotate(8deg)', pointerEvents: 'none',
        }}>
          <img src={LogoImage} alt="Good Kiddo"
            style={{
              width: 120, height: 120, borderRadius: '50%',
              display: 'block', objectFit: 'cover',
              border: `2px solid ${PAPER}`,
              boxShadow: `6px 6px 0 ${SHIBA}`,
            }}
          />
          <div style={{
            position: 'absolute', top: -40, left: -110,
            fontFamily: '"Caveat", cursive', fontSize: 24, color: MINT,
            transform: 'rotate(-6deg)', width: 120, lineHeight: 1.1,
            textAlign: 'right',
          }}>
            see you<br />tomorrow, 9 am
          </div>
        </div>
        <div style={{
          display: 'flex', justifyContent: 'space-between', alignItems: 'center',
          paddingBottom: 16, borderBottom: `1.5px solid ${PAPER}`,
          fontFamily: '"JetBrains Mono", monospace', fontSize: 10,
          letterSpacing: 2, textTransform: 'uppercase', opacity: 0.7,
          marginBottom: 40,
        }}>
          <span>VI. · Begin</span>
          <span>One-time setup · ~10 minutes</span>
          <span>Filed · tomorrow morning, 9 am</span>
        </div>
        <div className="gk-cta-grid" style={{
          display: 'grid', gridTemplateColumns: '1.3fr 1fr', gap: 80,
          alignItems: 'end',
        }}>
          <h2 style={{
            margin: 0,
            fontFamily: '"Fraunces", Georgia, serif',
            fontSize: 'clamp(72px, 8vw, 136px)',
            lineHeight: 0.88, letterSpacing: -4,
            fontWeight: 300, textWrap: 'balance',
          }}>
            Hand off the<br />
            <em style={{
              fontStyle: 'italic', color: MINT, fontWeight: 400,
            }}>boring half</em><br />
            of your week.
          </h2>
          <div>
            <p style={{
              margin: '0 0 28px', fontFamily: '"Fraunces", Georgia, serif',
              fontSize: 19, lineHeight: 1.5, textWrap: 'pretty',
              opacity: 0.85,
            }}>
              Ten minutes to set up. Tomorrow morning you'll wake up to four
              drafts, three flagged numbers, and one deck you didn't have to write.
              Approve, redirect, or tell it to try again.
            </p>
            <div style={{ display: 'flex', gap: 14, flexWrap: 'wrap' }}>
              <a href="https://t.me/goodkiddo_bot?start=landing_final"
                onClick={() => posthog.capture('final_cta_clicked', { location: 'final_section', transport: 'sendBeacon' })}
                style={{
                  display: 'inline-flex', alignItems: 'center', gap: 12,
                  padding: '16px 26px', background: PAPER, color: INK,
                  fontFamily: '"JetBrains Mono", monospace', fontSize: 12,
                  fontWeight: 700, letterSpacing: 2, textTransform: 'uppercase',
                  textDecoration: 'none', border: `2px solid ${PAPER}`,
                }}>
                Open in Telegram
                <span style={{ fontSize: 16 }}>→</span>
              </a>
              <a href="#what"
                onClick={() => posthog.capture('final_secondary_cta_clicked', { location: 'final_section' })}
                style={{
                  display: 'inline-flex', alignItems: 'center', gap: 12,
                  padding: '16px 26px', color: PAPER,
                  fontFamily: '"JetBrains Mono", monospace', fontSize: 12,
                  fontWeight: 500, letterSpacing: 2, textTransform: 'uppercase',
                  textDecoration: 'none', border: `2px solid ${PAPER}`,
                  opacity: 0.9,
                }}>
                Re-read the dossier
              </a>
            </div>
            <div style={{
              marginTop: 28, fontFamily: '"Caveat", cursive',
              fontSize: 22, color: MINT, lineHeight: 1.2,
            }}>
              p.s. — it's free for the first month. nothing ships without your approval.
            </div>
          </div>
        </div>

        {/* Colophon */}
        <div className="gk-colophon" style={{
          marginTop: 96, paddingTop: 24, borderTop: `1px solid ${PAPER}`,
          display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 32,
          fontFamily: '"JetBrains Mono", monospace', fontSize: 10,
          letterSpacing: 1.5, textTransform: 'uppercase', opacity: 0.6,
        }}>
          <div>
            <div style={{ fontWeight: 700, marginBottom: 6 }}>Good Kiddo</div>
            <div>Vol. I · MMXXVI</div>
          </div>
          <div>
            <div style={{ fontWeight: 700, marginBottom: 6 }}>Filed by</div>
            <div>The workhorse desk</div>
          </div>
          <div>
            <div style={{ fontWeight: 700, marginBottom: 6 }}>Mailbox</div>
            <div>@goodkiddo · Telegram</div>
          </div>
          <div>
            <div style={{ fontWeight: 700, marginBottom: 6 }}>Set</div>
            <div>Fraunces · Space Grotesk · JetBrains Mono</div>
          </div>
        </div>
      </div>
    </section>
  );
}

export { WhatItIs, HowItWorks, Memory, Why, FinalCTA };
