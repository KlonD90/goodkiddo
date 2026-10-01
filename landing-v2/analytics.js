(function () {
  'use strict';
  var config = window.GOODKIDDO_ANALYTICS || {};
  if (
    !config.projectKey ||
    ['https://us.i.posthog.com', 'https://eu.i.posthog.com'].indexOf(
      config.apiHost,
    ) < 0
  )
    return;
  if (
    window.navigator.doNotTrack === '1' ||
    window.navigator.globalPrivacyControl === true ||
    new URLSearchParams(window.location.search).has('draft')
  )
    return;

  // A random browser pseudonym; never derive it from Telegram, URLs, or device data.
  var distinctId;
  try {
    distinctId = window.localStorage.getItem('goodkiddo_analytics_id');
  } catch (_) {}
  if (!/^l_[a-f0-9-]{36}$/.test(distinctId || '')) {
    if (!window.crypto || !window.crypto.randomUUID) return;
    distinctId = 'l_' + window.crypto.randomUUID();
    try {
      window.localStorage.setItem('goodkiddo_analytics_id', distinctId);
    } catch (_) {}
  }
  function capture(event, properties) {
    try {
      window
        .fetch(config.apiHost + '/capture/', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          credentials: 'omit',
          referrerPolicy: 'no-referrer',
          keepalive: true,
          body: JSON.stringify({
            api_key: config.projectKey,
            event: event,
            timestamp: new Date().toISOString(),
            properties: Object.assign(
              {
                distinct_id: distinctId,
                $insert_id: window.crypto.randomUUID(),
                $process_person_profile: false,
                $geoip_disable: true,
                app: 'goodkiddo_landing',
                schema_version: 2,
                page_path: '/',
                is_test: config.testMode === true,
              },
              properties,
            ),
          }),
        })
        .catch(function () {});
    } catch (_) {
      /* Navigation and UI never depend on analytics. */
    }
  }
  // No browser SDK: no autocapture, replay, URL/referrer collection, flags or surveys.
  capture('landing_pageview', {});
  var ctas = {
    nav_telegram_clicked: ['nav', 'private', 'landing_nav'],
    hero_cta_clicked: ['hero', 'private', 'landing_hero'],
    hero_add_to_chat_clicked: ['hero', 'group', 'landing_hero'],
    meet_add_to_chat_clicked: ['meet', 'group', 'landing_meet'],
    dm_cta_clicked: ['dm', 'private', 'landing_dm'],
    steps_add_to_chat_clicked: ['steps', 'group', 'landing_steps'],
    final_cta_clicked: ['final', 'private', 'landing_final'],
    final_add_to_chat_clicked: ['final', 'group', 'landing_final'],
  };
  document.querySelectorAll('[data-ph-event]').forEach(function (link) {
    var cta = ctas[link.dataset.phEvent];
    if (!cta) return;
    link.addEventListener('click', function () {
      capture('landing_cta_clicked', {
        cta_location: cta[0],
        destination: cta[1],
        source: cta[2],
      });
    });
  });
})();
