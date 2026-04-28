<wizard-report>
# PostHog post-wizard report

The wizard has completed a deep integration of PostHog analytics into the Good Kiddo landing page. PostHog is initialized in `src/main.jsx` using environment variables, and five conversion/engagement events are tracked across the three key source files. Autocapture is enabled by default, so clicks, form interactions, and pageviews are also captured automatically in addition to the custom events below.

| Event | Description | File |
|---|---|---|
| `nav_telegram_clicked` | User clicked "Open in Telegram →" in the top navigation bar | `src/hero.jsx` |
| `hero_cta_clicked` | User clicked the primary "Start talking" CTA in the hero section | `src/hero.jsx` |
| `use_case_section_viewed` | User scrolled to the use cases section (top of conversion funnel, fired once via IntersectionObserver) | `src/usecases.jsx` |
| `final_cta_clicked` | User clicked the primary "Open in Telegram" CTA in the final conversion section | `src/dossier.jsx` |
| `final_secondary_cta_clicked` | User clicked the "Re-read the dossier" secondary CTA in the final section | `src/dossier.jsx` |

## Next steps

We've built some insights and a dashboard for you to keep an eye on user behavior, based on the events we just instrumented:

- **Dashboard**: [Analytics basics](https://us.posthog.com/project/399284/dashboard/1514465)
- **Full landing page funnel** (pageview → use cases → CTA): [View insight](https://us.posthog.com/project/399284/insights/u6TIZX5k)
- **Landing page conversion funnel** (use cases viewed → final CTA click): [View insight](https://us.posthog.com/project/399284/insights/vY1YW6d4)
- **Telegram CTA clicks over time** (all three buttons, daily trend): [View insight](https://us.posthog.com/project/399284/insights/PpBd0pwl)
- **CTA click breakdown by button** (bar chart of each button's total clicks): [View insight](https://us.posthog.com/project/399284/insights/Y1QEEsqM)
- **Use case section engagement rate** (visitors vs. those who scrolled far enough): [View insight](https://us.posthog.com/project/399284/insights/gz7GQU05)

### Agent skill

We've left an agent skill folder in your project. You can use this context for further agent development when using Claude Code. This will help ensure the model provides the most up-to-date approaches for integrating PostHog.

</wizard-report>
