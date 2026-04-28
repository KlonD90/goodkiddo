import { PostHog } from "posthog-node";

let _client: PostHog | null = null;

function getClient(): PostHog | null {
	if (_client !== null) return _client;
	const key = process.env.POSTHOG_KEY;
	if (!key) return null;
	_client = new PostHog(key, {
		host: process.env.POSTHOG_HOST ?? "https://us.i.posthog.com",
	});
	return _client;
}

export async function shutdownAnalytics(): Promise<void> {
	if (_client) await _client.shutdown();
}

export function trackBotStarted(
	distinctId: string,
	source: string,
): void {
	getClient()?.capture({ distinctId, event: "bot_started", properties: { source } });
}

export function trackUserCreated(
	distinctId: string,
	entrypoint: string,
): void {
	getClient()?.capture({ distinctId, event: "user_created", properties: { entrypoint } });
}
