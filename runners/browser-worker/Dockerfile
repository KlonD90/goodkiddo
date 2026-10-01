FROM mcr.microsoft.com/playwright:v1.63.0-noble@sha256:eff16c30e6f3f4af0a03fa4b706120d5e9b0891c344a27d64559aff5900a4a27
USER root
WORKDIR /app
# Dependencies are the frozen Bun installation of playwright 1.63.0 with scripts
# disabled. The native executable is extracted by the reviewed integrity checker.
COPY node_modules/playwright /app/node_modules/playwright
COPY node_modules/playwright-core /app/node_modules/playwright-core
COPY agent-browser /app/agent-browser
COPY controller.mjs agent-browser.json action-policy.json /app/
RUN chmod 555 /app/agent-browser && chmod -R a-w /app
USER 1000:1000
ENTRYPOINT ["node", "/app/controller.mjs"]
