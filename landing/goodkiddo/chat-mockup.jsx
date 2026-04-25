import React from 'react';
// ChatMockup.jsx — Telegram-style chat surface so users recognize the app.
// Uses the familiar Telegram blue, patterned chat background, bubble shapes,
// tick marks, attach paperclip, and voice-note mic button.

const TG_BLUE = '#2AABEE';
const TG_BLUE_DEEP = '#229ED9';
const TG_OUT_BG_LIGHT = '#EFFDDE';      // mint-green outgoing bubble
const TG_OUT_INK_LIGHT = '#111';
const TG_OUT_BG_DARK = '#766AC8';       // violet-ish outgoing bubble on dark
const TG_OUT_INK_DARK = '#fff';
const TG_BG_LIGHT = '#EAE8E1';          // warm beige chat wallpaper
const TG_BG_DARK = '#0F141A';
const TG_IN_BG_LIGHT = '#FFFFFF';
const TG_IN_BG_DARK = '#182533';
const TG_IN_INK_LIGHT = '#111';
const TG_IN_INK_DARK = '#E9EEF3';
const TG_HEADER_LIGHT = '#F4F4F5';
const TG_HEADER_DARK = '#17212B';

// Subtle wallpaper pattern — abstract dots so we don't copy Telegram artwork.
function wallpaperSvg(isDark) {
  const dot = isDark ? 'rgba(255,255,255,0.035)' : 'rgba(0,0,0,0.035)';
  return `url("data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg' width='60' height='60'><circle cx='10' cy='10' r='1.2' fill='${encodeURIComponent(dot)}'/><circle cx='40' cy='30' r='1' fill='${encodeURIComponent(dot)}'/><circle cx='22' cy='48' r='0.9' fill='${encodeURIComponent(dot)}'/></svg>")`;
}

function ChatFrame({ theme = 'light', children, title = 'Good Kiddo', subtitle = 'bot · online' }) {
  const isDark = theme === 'dark';
  const surface = isDark ? '#17212B' : '#fff';
  const header = isDark ? TG_HEADER_DARK : TG_HEADER_LIGHT;
  const headerInk = isDark ? '#E9EEF3' : '#0F1214';
  const headerMute = isDark ? '#7D8A96' : '#707579';
  const border = isDark ? '#0B141B' : '#DADADA';
  const chatBg = isDark ? TG_BG_DARK : TG_BG_LIGHT;

  return (
    <div style={{
      background: surface,
      border: `1px solid ${border}`,
      borderRadius: 14,
      overflow: 'hidden',
      fontFamily: '-apple-system, BlinkMacSystemFont, "SF Pro Text", "Segoe UI", Roboto, system-ui, sans-serif',
      color: headerInk,
      display: 'flex', flexDirection: 'column',
      width: '100%', height: '100%',
      boxShadow: isDark
        ? '0 24px 60px -20px rgba(0,0,0,0.7), 0 0 0 1px rgba(255,255,255,0.02)'
        : '0 24px 60px -20px rgba(60,50,30,0.22), 0 2px 6px rgba(60,50,30,0.06)',
    }}>
      {/* Telegram-style header */}
      <div style={{
        padding: '10px 14px',
        borderBottom: `1px solid ${isDark ? '#0B141B' : '#E4E4E7'}`,
        display: 'flex', alignItems: 'center', gap: 12,
        background: header,
      }}>
        {/* Back chevron */}
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke={TG_BLUE} strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" style={{ flexShrink: 0 }}>
          <polyline points="15 18 9 12 15 6"/>
        </svg>
        {/* Avatar */}
        <div style={{
          width: 38, height: 38, borderRadius: '50%',
          overflow: 'hidden', flexShrink: 0,
          border: `1px solid ${isDark ? 'rgba(255,255,255,0.08)' : 'rgba(0,0,0,0.06)'}`,
        }}>
          <img src="goodkiddo/kiddo-logo.jpg" alt="Good Kiddo"
            style={{ width: '100%', height: '100%', objectFit: 'cover', display: 'block' }}
          />
        </div>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontWeight: 600, fontSize: 15, letterSpacing: -0.2, color: headerInk }}>{title}</div>
          <div style={{ fontSize: 12, color: TG_BLUE, fontWeight: 400 }}>{subtitle}</div>
        </div>
        {/* Search + menu */}
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke={headerMute} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><circle cx="11" cy="11" r="7"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></svg>
        <svg width="4" height="18" viewBox="0 0 4 18" fill={headerMute} style={{ marginLeft: 4 }}><circle cx="2" cy="3" r="2"/><circle cx="2" cy="9" r="2"/><circle cx="2" cy="15" r="2"/></svg>
      </div>

      {/* Messages — patterned wallpaper */}
      <div style={{
        flex: 1,
        padding: '18px 14px',
        display: 'flex', flexDirection: 'column', gap: 6,
        overflow: 'hidden',
        background: chatBg,
        backgroundImage: wallpaperSvg(isDark),
        backgroundSize: '60px 60px',
      }}>
        {children}
      </div>

      {/* Composer */}
      <div style={{
        padding: '8px 10px',
        borderTop: `1px solid ${isDark ? '#0B141B' : '#E4E4E7'}`,
        display: 'flex', alignItems: 'center', gap: 8,
        background: header,
      }}>
        {/* Emoji */}
        <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke={headerMute} strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" style={{ flexShrink: 0 }}>
          <circle cx="12" cy="12" r="9"/><path d="M8 14s1.5 2 4 2 4-2 4-2"/><line x1="9" y1="9" x2="9.01" y2="9"/><line x1="15" y1="9" x2="15.01" y2="9"/>
        </svg>
        <div style={{
          flex: 1,
          padding: '9px 12px',
          borderRadius: 18,
          background: isDark ? '#242F3D' : '#fff',
          border: isDark ? 'none' : '1px solid #E4E4E7',
          color: headerMute,
          fontSize: 14,
          display: 'flex', alignItems: 'center', gap: 8,
        }}>
          <span style={{ flex: 1 }}>Message</span>
          {/* Paperclip */}
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke={headerMute} strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
            <path d="M21.44 11.05l-9.19 9.19a6 6 0 0 1-8.49-8.49l9.19-9.19a4 4 0 0 1 5.66 5.66l-9.2 9.19a2 2 0 0 1-2.83-2.83l8.49-8.48"/>
          </svg>
        </div>
        {/* Send (mic-style circle) */}
        <div style={{
          width: 36, height: 36, borderRadius: '50%',
          background: TG_BLUE,
          display: 'flex', alignItems: 'center', justifyContent: 'center',
          flexShrink: 0,
        }}>
          <svg width="16" height="16" viewBox="0 0 24 24" fill="white">
            <path d="M2 21L23 12 2 3v7l15 2-15 2z"/>
          </svg>
        </div>
      </div>
    </div>
  );
}

function Bubble({ from = 'them', children, theme = 'light', time, typing, attachment, read = true }) {
  const isDark = theme === 'dark';
  const isMe = from === 'me';
  const outBg = isDark ? TG_OUT_BG_DARK : TG_OUT_BG_LIGHT;
  const outInk = isDark ? TG_OUT_INK_DARK : TG_OUT_INK_LIGHT;
  const inBg = isDark ? TG_IN_BG_DARK : TG_IN_BG_LIGHT;
  const inInk = isDark ? TG_IN_INK_DARK : TG_IN_INK_LIGHT;
  const timeColor = isMe
    ? (isDark ? 'rgba(255,255,255,0.7)' : '#5BA367')
    : (isDark ? '#7D8A96' : '#A0A7B0');

  return (
    <div style={{
      display: 'flex',
      justifyContent: isMe ? 'flex-end' : 'flex-start',
      flexDirection: 'column',
      alignItems: isMe ? 'flex-end' : 'flex-start',
      marginBottom: 4,
    }}>
      <div style={{
        position: 'relative',
        maxWidth: '86%',
        padding: typing ? '10px 14px' : '7px 10px 6px',
        borderRadius: 12,
        borderBottomRightRadius: isMe ? 4 : 12,
        borderBottomLeftRadius: isMe ? 12 : 4,
        background: isMe ? outBg : inBg,
        color: isMe ? outInk : inInk,
        fontSize: 14.5,
        lineHeight: 1.38,
        letterSpacing: -0.05,
        whiteSpace: 'pre-wrap',
        boxShadow: '0 1px 1px rgba(0,0,0,0.08)',
      }}>
        {typing ? <TypingDots /> : (
          <>
            <span>{children}</span>
            {/* inline time + tick, nbsp-padded to reserve space */}
            {time && (
              <span style={{
                float: 'right',
                marginLeft: 8,
                marginTop: 4,
                fontSize: 11,
                color: timeColor,
                display: 'inline-flex', alignItems: 'center', gap: 3,
                lineHeight: 1,
              }}>
                {time}
                {isMe && (
                  <svg width="14" height="10" viewBox="0 0 14 10" fill="none" stroke={timeColor} strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
                    <polyline points="1 5 4 8 9 2"/>
                    <polyline points="5 5 8 8 13 2"/>
                  </svg>
                )}
              </span>
            )}
          </>
        )}
        {attachment && (
          typeof attachment === 'object' && attachment.kind === 'doc' ? (
            <TgDoc att={attachment} isMe={isMe} isDark={isDark} />
          ) : typeof attachment === 'object' && attachment.kind === 'table' ? (
            <TgTable att={attachment} isMe={isMe} isDark={isDark} />
          ) : typeof attachment === 'object' && attachment.kind === 'contacts' ? (
            <TgContacts att={attachment} isMe={isMe} isDark={isDark} />
          ) : (
            <div style={{
              marginTop: 6,
              padding: '8px 10px',
              borderRadius: 8,
              background: isMe ? 'rgba(0,0,0,0.06)' : (isDark ? '#0F1B27' : '#F2F5F7'),
              fontSize: 12,
              display: 'flex', alignItems: 'center', gap: 8,
              color: isMe ? outInk : inInk,
            }}>
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/>
                <polyline points="14 2 14 8 20 8"/>
              </svg>
              {attachment}
            </div>
          )
        )}
      </div>
    </div>
  );
}

function TypingDots() {
  return (
    <div style={{ display: 'flex', gap: 4, padding: '2px 0' }}>
      {[0, 1, 2].map(i => (
        <div key={i} style={{
          width: 6, height: 6, borderRadius: '50%',
          background: 'currentColor', opacity: 0.4,
          animation: `gkdot 1.2s ${i * 0.15}s infinite ease-in-out`,
        }}/>
      ))}
      <style>{`@keyframes gkdot { 0%, 60%, 100% { opacity: 0.3; transform: translateY(0); } 30% { opacity: 0.9; transform: translateY(-3px); } }`}</style>
    </div>
  );
}

function DayDivider({ children, theme = 'light' }) {
  const isDark = theme === 'dark';
  return (
    <div style={{
      display: 'flex', alignItems: 'center', justifyContent: 'center',
      margin: '6px 0 10px',
    }}>
      <div style={{
        padding: '3px 10px',
        borderRadius: 10,
        background: isDark ? 'rgba(0,0,0,0.35)' : 'rgba(0,0,0,0.18)',
        color: '#fff',
        fontSize: 11,
        fontWeight: 500,
        letterSpacing: 0.1,
      }}>{children}</div>
    </div>
  );
}

// ─── Telegram-style attachment components ────────────────────

function TgDoc({ att, isMe, isDark }) {
  const iconBg = att.color || '#2AABEE';
  const panelBg = isMe
    ? (isDark ? 'rgba(255,255,255,0.08)' : 'rgba(255,255,255,0.5)')
    : (isDark ? '#0F1B27' : '#F6F8FA');
  const ink = isMe ? (isDark ? '#fff' : '#111') : (isDark ? '#E9EEF3' : '#111');
  const mute = isMe ? (isDark ? 'rgba(255,255,255,0.6)' : 'rgba(0,0,0,0.55)') : (isDark ? '#7D8A96' : '#707579');
  return (
    <div style={{
      marginTop: 6, padding: '8px 10px 8px 8px', borderRadius: 10,
      background: panelBg, display: 'flex', alignItems: 'center', gap: 10, minWidth: 240,
    }}>
      <div style={{
        width: 42, height: 42, borderRadius: '50%', background: iconBg,
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        flexShrink: 0, position: 'relative',
      }}>
        <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="white" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/>
          <polyline points="14 2 14 8 20 8"/>
        </svg>
        {att.ext && (
          <div style={{
            position: 'absolute', bottom: 2, right: -2,
            fontSize: 8, fontWeight: 700, color: iconBg,
            background: 'white', borderRadius: 3, padding: '1px 3px',
            letterSpacing: 0.3, textTransform: 'uppercase',
          }}>{att.ext}</div>
        )}
      </div>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{
          fontSize: 14, fontWeight: 500, color: ink,
          letterSpacing: -0.1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
        }}>{att.name}</div>
        <div style={{
          fontSize: 12, color: mute, marginTop: 2,
          display: 'flex', alignItems: 'center', gap: 6,
        }}>
          <span>{att.size}</span>
          {att.meta && <><span style={{ opacity: 0.5 }}>·</span><span>{att.meta}</span></>}
        </div>
      </div>
    </div>
  );
}

function TgTable({ att, isMe, isDark }) {
  const panelBg = isMe
    ? (isDark ? 'rgba(255,255,255,0.08)' : 'rgba(255,255,255,0.5)')
    : (isDark ? '#0F1B27' : '#F6F8FA');
  const ink = isMe ? (isDark ? '#fff' : '#111') : (isDark ? '#E9EEF3' : '#111');
  const mute = isMe ? (isDark ? 'rgba(255,255,255,0.6)' : 'rgba(0,0,0,0.55)') : (isDark ? '#7D8A96' : '#707579');
  const rowBorder = isMe ? (isDark ? 'rgba(255,255,255,0.08)' : 'rgba(0,0,0,0.06)') : (isDark ? 'rgba(255,255,255,0.06)' : '#E8ECEF');
  return (
    <div style={{
      marginTop: 6, borderRadius: 10, background: panelBg,
      overflow: 'hidden', minWidth: 280,
    }}>
      {att.title && (
        <div style={{
          padding: '10px 12px 8px', fontSize: 13, fontWeight: 600, color: ink,
          letterSpacing: -0.1, display: 'flex', alignItems: 'center', gap: 6,
        }}>
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
            <rect x="3" y="3" width="18" height="18" rx="2"/>
            <line x1="9" y1="3" x2="9" y2="21"/>
            <line x1="3" y1="9" x2="21" y2="9"/>
          </svg>
          {att.title}
        </div>
      )}
      <div>
        {att.rows.map((row, i) => (
          <div key={i} style={{
            display: 'grid', gridTemplateColumns: '1fr auto auto', gap: 10,
            padding: '8px 12px', borderTop: `1px solid ${rowBorder}`,
            fontSize: 13, alignItems: 'center', fontVariantNumeric: 'tabular-nums',
          }}>
            {row.map((cell, j) => {
              const isFlag = typeof cell === 'string' && cell.includes('⚑');
              const isNeg = typeof cell === 'string' && cell.includes('-') && cell.includes('%');
              const isPos = typeof cell === 'string' && cell.includes('+') && cell.includes('%');
              let color = j === 0 ? ink : mute;
              let weight = j === 0 ? 500 : 400;
              if (isFlag) { color = '#E64E4E'; weight = 600; }
              else if (isNeg) color = '#E64E4E';
              else if (isPos) color = '#4FA86C';
              return (
                <div key={j} style={{
                  color, fontWeight: weight,
                  textAlign: j === 0 ? 'left' : 'right',
                  letterSpacing: -0.05,
                }}>{cell}</div>
              );
            })}
          </div>
        ))}
      </div>
      {att.footer && (
        <div style={{
          padding: '8px 12px', borderTop: `1px solid ${rowBorder}`,
          fontSize: 12, color: mute,
          display: 'flex', alignItems: 'center', gap: 6,
        }}>
          <span style={{ color: '#E64E4E', fontWeight: 600 }}>⚑</span>
          {att.footer}
        </div>
      )}
    </div>
  );
}

function TgContacts({ att, isMe, isDark }) {
  const panelBg = isMe
    ? (isDark ? 'rgba(255,255,255,0.08)' : 'rgba(255,255,255,0.5)')
    : (isDark ? '#0F1B27' : '#F6F8FA');
  const ink = isMe ? (isDark ? '#fff' : '#111') : (isDark ? '#E9EEF3' : '#111');
  const mute = isMe ? (isDark ? 'rgba(255,255,255,0.6)' : 'rgba(0,0,0,0.55)') : (isDark ? '#7D8A96' : '#707579');
  const border = isMe ? (isDark ? 'rgba(255,255,255,0.08)' : 'rgba(0,0,0,0.06)') : (isDark ? 'rgba(255,255,255,0.06)' : '#E8ECEF');
  const palette = ['#E67E9F', '#7EB8E6', '#8FC27A', '#E6B872', '#B88FE0'];
  return (
    <div style={{
      marginTop: 6, borderRadius: 10, background: panelBg,
      overflow: 'hidden', minWidth: 260,
    }}>
      {att.contacts.map((c, i) => {
        const initials = c.name.split(' ').map(w => w[0]).slice(0, 2).join('');
        return (
          <div key={i} style={{
            display: 'flex', alignItems: 'center', gap: 10,
            padding: '8px 12px',
            borderTop: i === 0 ? 'none' : `1px solid ${border}`,
          }}>
            <div style={{
              width: 32, height: 32, borderRadius: '50%',
              background: palette[i % palette.length],
              color: 'white', fontSize: 12, fontWeight: 600,
              display: 'flex', alignItems: 'center', justifyContent: 'center',
              flexShrink: 0,
            }}>{initials}</div>
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ fontSize: 13.5, fontWeight: 500, color: ink, letterSpacing: -0.1 }}>{c.name}</div>
              <div style={{ fontSize: 11.5, color: mute, marginTop: 1 }}>{c.role}</div>
            </div>
            {c.status && (
              <div style={{
                fontSize: 10, color: c.status === 'sent' ? '#4FA86C' : mute,
                fontWeight: 500, letterSpacing: 0.3, textTransform: 'uppercase',
              }}>{c.status}</div>
            )}
          </div>
        );
      })}
    </div>
  );
}

export { ChatFrame, Bubble, TypingDots, DayDivider, TgDoc, TgTable, TgContacts };
