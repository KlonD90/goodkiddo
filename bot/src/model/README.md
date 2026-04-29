# model

LLM provider chooser.

- `model_chooser.ts` — `modelChooser(type, name, apiKey, baseUrl, options)` returns a LangChain chat model for `anthropic | openai | openrouter`

The runtime passes `AI_TEMPERATURE` to the main agent model and `AI_SUB_AGENT_TEMPERATURE` to delegated sub-agents such as research/web-search agents.
