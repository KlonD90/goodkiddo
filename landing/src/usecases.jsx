import React from 'react';
import posthog from 'posthog-js';
import { BURGUNDY, Chapter, INK, MUTE, OCHRE, PAPER, RULE, Stamp } from './dossier';
import { HeroThread } from './hero';
// usecases.jsx — v2 "Operator's Dossier": four cases, full-bleed editorial.
// USE CASE 01 IS BIZ-DEV — framework-led cold outreach.

// ═══ A framework card ══════════════════════════════════
function FrameworkCard({ title, rules }) {
  return (
    <div style={{
      background: '#FBF8F0',
      border: `1.5px solid ${INK}`,
      padding: '18px 22px',
      position: 'relative',
      boxShadow: `4px 4px 0 ${OCHRE}`,
      maxWidth: 360,
    }}>
      {/* Header */}
      <div style={{
        display: 'flex', alignItems: 'center', justifyContent: 'space-between',
        paddingBottom: 10, borderBottom: `1px dashed ${RULE}`,
        marginBottom: 14,
      }}>
        <div style={{
          fontFamily: '"JetBrains Mono", monospace', fontSize: 9,
          color: BURGUNDY, letterSpacing: 2, textTransform: 'uppercase', fontWeight: 700,
        }}>Framework · set once</div>
        <Stamp rotate={0} color={INK} size={9} style={{ padding: '2px 6px' }}>Active</Stamp>
      </div>
      <div style={{
        fontFamily: '"Fraunces", Georgia, serif', fontSize: 20,
        color: INK, letterSpacing: -0.4, lineHeight: 1.15, marginBottom: 14,
        fontWeight: 500,
      }}>{title}</div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
        {rules.map((r, i) => (
          <div key={i} style={{ display: 'flex', gap: 10, alignItems: 'baseline' }}>
            <span style={{
              fontFamily: '"JetBrains Mono", monospace', fontSize: 10,
              color: BURGUNDY, fontWeight: 700, letterSpacing: 0.5,
              flexShrink: 0,
            }}>{String(i + 1).padStart(2, '0')}</span>
            <span style={{
              fontFamily: '"Fraunces", Georgia, serif', fontSize: 14.5,
              color: INK, lineHeight: 1.35, textWrap: 'pretty',
            }}>{r}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

// ═══ Phone with tilt ═══════════════════════════════════
function Phone({ threadIndex = 0, tilt = -2 }) {
  return (
    <div style={{
      transform: `rotate(${tilt}deg)`,
      filter: 'drop-shadow(14px 16px 0 rgba(26,23,20,0.10))',
      maxWidth: 380,
    }}>
      <div style={{
        background: '#0B0B0D', padding: '16px 12px 20px', borderRadius: 46,
        boxShadow: 'inset 0 0 0 2px #2A2A2D, 0 0 0 1px #000',
      }}>
        <div style={{
          position: 'absolute', top: 20, left: '50%', transform: 'translateX(-50%)',
          width: 80, height: 26, background: '#000', borderRadius: 18, zIndex: 10,
        }}/>
        <div style={{
          background: '#fff', borderRadius: 34, overflow: 'hidden',
          height: 680, display: 'flex', flexDirection: 'column', position: 'relative',
        }}>
          <div style={{
            padding: '14px 24px 6px', display: 'flex',
            justifyContent: 'space-between', alignItems: 'center',
            fontSize: 12, fontWeight: 600, color: '#000',
            fontFamily: '-apple-system, "SF Pro Text", system-ui, sans-serif',
          }}>
            <span>9:41</span>
            <span style={{ display: 'flex', gap: 4, alignItems: 'center' }}>
              <svg width="15" height="10" viewBox="0 0 17 11" fill="#000">
                <rect x="0" y="7" width="3" height="4" rx="0.5"/>
                <rect x="5" y="5" width="3" height="6" rx="0.5"/>
                <rect x="10" y="2" width="3" height="9" rx="0.5"/>
                <rect x="15" y="0" width="3" height="11" rx="0.5"/>
              </svg>
              <div style={{
                width: 22, height: 10, borderRadius: 3,
                border: '1px solid #000', padding: 1,
              }}>
                <div style={{ background: '#000', height: '100%', width: '75%', borderRadius: 1 }}/>
              </div>
            </span>
          </div>
          <div style={{ flex: 1, overflow: 'hidden' }}>
            <HeroThread threadIndex={threadIndex} />
          </div>
        </div>
      </div>
    </div>
  );
}

// ═══ Section header ═════════════════════════════════════
function UseCasesHeader() {
  const sectionRef = React.useRef(null);
  React.useEffect(() => {
    const el = sectionRef.current;
    if (!el) return;
    const observer = new IntersectionObserver(
      ([entry]) => {
        if (entry.isIntersecting) {
          posthog.capture('use_case_section_viewed');
          observer.disconnect();
        }
      },
      { threshold: 0.3 }
    );
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  return (
    <section ref={sectionRef} id="do" className="gk-section" style={{
      padding: '120px 60px 60px', maxWidth: 1320, margin: '0 auto',
      position: 'relative',
    }}>
      <Chapter
        roman="II."
        kicker="Four dossiers from the field"
        title="What it actually does, Monday to Friday."
      />
      <div className="gk-section-content gk-2col" style={{
        display: 'grid', gridTemplateColumns: '1fr 1.2fr', gap: 80,
        paddingLeft: 88, alignItems: 'start',
      }}>
        <div style={{
          fontFamily: '"JetBrains Mono", monospace', fontSize: 11,
          color: MUTE, letterSpacing: 1.5, textTransform: 'uppercase',
          lineHeight: 1.7, borderTop: `1px solid ${INK}`, paddingTop: 12,
        }}>
          Set the rules once.<br/>
          The thread opens daily.<br/>
          The work is approval-ready.
        </div>
        <p style={{
          margin: 0, fontFamily: '"Fraunces", Georgia, serif',
          fontSize: 22, lineHeight: 1.5, color: INK,
          textWrap: 'pretty', borderTop: `1px solid ${INK}`, paddingTop: 12,
          fontStyle: 'italic', fontWeight: 400,
        }}>
          These are the four jobs operators hand off first. Each one is framework-led:
          you define how it should work, Good Kiddo runs it every morning. Drafts land
          in your Telegram. You approve, redirect, or edit. Everything else is automatic.
        </p>
      </div>
    </section>
  );
}

// ═══ Biz-dev case ═══════════════════════════════════════
function BizDevCase() {
  return (
    <section className="gk-section" style={{
      padding: '100px 60px', maxWidth: 1320, margin: '0 auto',
      borderTop: `2px solid ${INK}`, position: 'relative',
    }}>
      <div style={{
        display: 'flex', alignItems: 'baseline', gap: 24, marginBottom: 48,
      }}>
        <div style={{
          fontFamily: '"Fraunces", Georgia, serif', fontStyle: 'italic',
          fontSize: 96, color: BURGUNDY, lineHeight: 0.85, fontWeight: 300,
          letterSpacing: -3,
        }}>№ 01</div>
        <div>
          <div style={{
            fontFamily: '"JetBrains Mono", monospace', fontSize: 11,
            color: MUTE, letterSpacing: 2.5, textTransform: 'uppercase',
          }}>Business development</div>
          <h3 style={{
            margin: '6px 0 0', fontFamily: '"Fraunces", Georgia, serif',
            fontSize: 56, lineHeight: 0.95, letterSpacing: -1.8,
            color: INK, fontWeight: 400, textWrap: 'balance',
          }}>
            The colleagues you'll meet this quarter —<br/>
            <em style={{ color: BURGUNDY }}>through emails it wrote.</em>
          </h3>
        </div>
      </div>

      <div className="gk-3col" style={{
        display: 'grid', gridTemplateColumns: '1.1fr 1fr 0.9fr', gap: 48,
        alignItems: 'start',
      }}>
        {/* Left: narrative */}
        <div>
          <p style={{
            margin: '0 0 20px', fontFamily: '"Fraunces", Georgia, serif',
            fontSize: 19, lineHeight: 1.5, color: INK, textWrap: 'pretty',
          }}>
            Biz-dev is the boring job nobody does consistently. Finding the right
            people. Writing the first email in a voice that doesn't sound like a
            template. Remembering to follow up on day four, day nine, day sixteen.
          </p>
          <p style={{
            margin: '0 0 24px', fontFamily: '"Fraunces", Georgia, serif',
            fontSize: 19, lineHeight: 1.5, color: INK, textWrap: 'pretty',
          }}>
            Good Kiddo runs it for you. You define <em>who</em> is worth reaching and
            <em> how</em> emails should read — once, in plain language. Good Kiddo finds the
            people, writes the drafts, queues the follow-ups, and brings every batch to
            your Telegram for approval.
          </p>

          <div style={{
            marginTop: 28, padding: '16px 20px',
            background: INK, color: PAPER,
            fontFamily: '"Fraunces", Georgia, serif', fontSize: 18,
            lineHeight: 1.4, fontStyle: 'italic', fontWeight: 400,
          }}>
            You set the framework. Good Kiddo does the outreach.
            The meetings that come out of it are yours.
          </div>

          <div style={{
            marginTop: 28,
            display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16,
            borderTop: `1px solid ${RULE}`, paddingTop: 20,
          }}>
            {[
              ['Prospects', '4–12 / week'],
              ['Follow-ups', 'Auto · 3-step'],
              ['Send rule', 'You approve'],
              ['Pause logic', 'On reply'],
            ].map(([k, v]) => (
              <div key={k}>
                <div style={{
                  fontFamily: '"JetBrains Mono", monospace', fontSize: 10,
                  color: MUTE, letterSpacing: 1.5, textTransform: 'uppercase',
                }}>{k}</div>
                <div style={{
                  fontFamily: '"Fraunces", Georgia, serif', fontSize: 18,
                  color: INK, marginTop: 2, fontWeight: 500,
                }}>{v}</div>
              </div>
            ))}
          </div>
        </div>

        {/* Middle: the framework YOU define */}
        <div style={{ display: 'flex', flexDirection: 'column', gap: 24, paddingTop: 8 }}>
          <FrameworkCard
            title="Who's worth reaching"
            rules={[
              'Brand leads at design-forward studios, 20–80 people',
              'Companies that rebranded in the last 18 months',
              'Skip anyone we\'ve emailed in the last 6 months',
              'Prioritise EU / UK timezones',
            ]}
          />
          <FrameworkCard
            title="How emails should read"
            rules={[
              'Warm and specific. Never templated.',
              'Open with a question — not a pitch.',
              'No more than 120 words.',
              'My signature, not a fake "team".',
            ]}
          />
          <div style={{
            fontFamily: '"Caveat", cursive', fontSize: 22, color: BURGUNDY,
            transform: 'rotate(-2deg)', paddingLeft: 20, lineHeight: 1.2,
          }}>
            ← set once. never edit again. (unless you want to.)
          </div>
        </div>

        {/* Right: phone */}
        <div className="gk-std-phone" style={{ position: 'relative' }}>
          <Phone threadIndex={0} tilt={2} />
          <div style={{
            position: 'absolute', bottom: -30, left: -30, zIndex: 5,
          }}>
            <Stamp rotate={-10} color={BURGUNDY} size={13}>Approved · ship Monday</Stamp>
          </div>
        </div>
      </div>
    </section>
  );
}

// ═══ Other cases ═══════════════════════════════════════
const CASES = [
  {
    num: '02',
    kicker: 'Launches & campaigns',
    title: 'Launch week, already staffed.',
    body: "Captions, subject lines, post schedule — written in your voice, timed for when your audience actually opens things. Good Kiddo watches the window and nudges you when it's time to ship.",
    rules: [
      'Voice: specific, quiet, no clever.',
      '10 caption options, rank by on-voice score.',
      'Block Wed/Thu/Fri 9am — our highest open rates.',
      'Skip exclamation marks. Always.',
    ],
    frameworkTitle: 'Voice & timing framework',
    threadIndex: 1,
    quote: 'Every campaign sounds like you wrote it — because the voice is locked in.',
    stats: [
      ['Captions drafted', '10 / launch'],
      ['Voice score', 'GPT-judged + yours'],
      ['Posting', 'You approve slots'],
      ['Voice memory', '100+ edits logged'],
    ],
    stamp: 'Locked into voice',
    tilt: -2,
  },
  {
    num: '03',
    kicker: 'Decks & narratives',
    title: 'A deck on your calendar before the meeting is.',
    body: "Good Kiddo reads meetings on your calendar, pulls relevant notes, and builds a draft deck — real, editable .pptx — before you open your laptop. Narrative, not slideware.",
    rules: [
      'Always: 7 slides, narrative arc.',
      'Slide 5 = the decision ask. Non-negotiable.',
      'Include speaker notes for every slide.',
      'Reuse last quarter\'s visual template.',
    ],
    frameworkTitle: 'Deck framework',
    threadIndex: 2,
    quote: 'A deck on your calendar before the meeting is.',
    stats: [
      ['Slides', '7 · narrative arc'],
      ['Format', 'Native .pptx'],
      ['Notes', 'Included · editable'],
      ['Trigger', 'Calendar event'],
    ],
    stamp: 'Editable · yours',
    tilt: 2,
  },
  {
    num: '04',
    kicker: 'Numbers & health checks',
    title: 'The number that shifted, flagged before your coffee.',
    body: "Connect sheets, a CRM, a paid-ads account — or just forward reports. Good Kiddo cleans, summarises, and tells you the one line that matters. No dashboards to check.",
    rules: [
      'Flag any channel ±15% WoW.',
      'Never wake me for weekend noise.',
      'Watch paid spend vs. CAC weekly.',
      'Email report every Monday 8am.',
    ],
    frameworkTitle: 'Watch-list framework',
    threadIndex: 3,
    quote: 'Two things worth your eyes, not a wall of numbers.',
    stats: [
      ['Channels', 'Up to 12 sources'],
      ['Cadence', 'Weekly + alerts'],
      ['Output', '1 line + full table'],
      ['Forwarding', 'Paste works too'],
    ],
    stamp: 'Flagged · weekly',
    tilt: -3,
  },
];

function StandardCase({ c, flip = false }) {
  const textCol = (
    <div>
      <div style={{
        display: 'flex', alignItems: 'baseline', gap: 20, marginBottom: 28,
      }}>
        <div style={{
          fontFamily: '"Fraunces", Georgia, serif', fontStyle: 'italic',
          fontSize: 72, color: BURGUNDY, lineHeight: 0.85, fontWeight: 300,
          letterSpacing: -2,
        }}>№ {c.num}</div>
        <div>
          <div style={{
            fontFamily: '"JetBrains Mono", monospace', fontSize: 10,
            color: MUTE, letterSpacing: 2.5, textTransform: 'uppercase',
          }}>{c.kicker}</div>
          <h3 style={{
            margin: '4px 0 0', fontFamily: '"Fraunces", Georgia, serif',
            fontSize: 44, lineHeight: 0.98, letterSpacing: -1.4,
            color: INK, fontWeight: 400, textWrap: 'balance',
          }}>{c.title}</h3>
        </div>
      </div>
      <p style={{
        margin: '0 0 24px', fontFamily: '"Fraunces", Georgia, serif',
        fontSize: 18, lineHeight: 1.5, color: INK, textWrap: 'pretty',
      }}>{c.body}</p>
      <div style={{
        padding: '14px 18px', background: INK, color: PAPER,
        fontFamily: '"Fraunces", Georgia, serif', fontSize: 17,
        lineHeight: 1.4, fontStyle: 'italic', marginBottom: 24,
      }}>{c.quote}</div>
      <div style={{
        display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 14,
        borderTop: `1px solid ${RULE}`, paddingTop: 16,
      }}>
        {c.stats.map(([k, v]) => (
          <div key={k}>
            <div style={{
              fontFamily: '"JetBrains Mono", monospace', fontSize: 10,
              color: MUTE, letterSpacing: 1.5, textTransform: 'uppercase',
            }}>{k}</div>
            <div style={{
              fontFamily: '"Fraunces", Georgia, serif', fontSize: 16,
              color: INK, marginTop: 2, fontWeight: 500,
            }}>{v}</div>
          </div>
        ))}
      </div>
    </div>
  );

  const middleCol = (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 18 }}>
      <FrameworkCard title={c.frameworkTitle} rules={c.rules} />
      <div style={{
        fontFamily: '"Caveat", cursive', fontSize: 22, color: BURGUNDY,
        transform: 'rotate(-1deg)', paddingLeft: 16, lineHeight: 1.2,
      }}>
        ← your rules. <br/>its daily output.
      </div>
    </div>
  );

  const phoneCol = (
    <div className="gk-std-phone" style={{ position: 'relative' }}>
      <Phone threadIndex={c.threadIndex} tilt={c.tilt} />
      <div style={{ position: 'absolute', bottom: -30, right: -10, zIndex: 5 }}>
        <Stamp rotate={8} color={BURGUNDY} size={12}>{c.stamp}</Stamp>
      </div>
    </div>
  );

  return (
    <section className="gk-section" style={{
      padding: '100px 60px', maxWidth: 1320, margin: '0 auto',
      borderTop: `2px solid ${INK}`, position: 'relative',
    }}>
      <div className="gk-std-grid" style={{
        display: 'grid',
        gridTemplateColumns: flip ? '0.9fr 1fr 1.1fr' : '1.1fr 1fr 0.9fr',
        gap: 48, alignItems: 'start',
        direction: flip ? 'rtl' : 'ltr',
      }}>
        <div style={{ direction: 'ltr' }}>{flip ? phoneCol : textCol}</div>
        <div style={{ direction: 'ltr' }}>{middleCol}</div>
        <div style={{ direction: 'ltr' }}>{flip ? textCol : phoneCol}</div>
      </div>
    </section>
  );
}

function UseCases() {
  return (
    <>
      <UseCasesHeader />
      <BizDevCase />
      {CASES.map((c, i) => (
        <StandardCase key={c.num} c={c} flip={i % 2 === 0} />
      ))}
    </>
  );
}

export { UseCases };
