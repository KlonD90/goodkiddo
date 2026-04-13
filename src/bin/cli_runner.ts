import { createAppAgent } from "../app";
import type { AppConfig } from "../config";

export const runCliEntrypoint = async (config: AppConfig): Promise<void> => {
	const agent = await createAppAgent(config);
	const stream = agent.streamEvents({
		messages: [
			{
				role: "user",
				content:
					"Write little script with bun that will take file host.txt with google.com and ya.ru (file with list of hosts) and fetch each host and return http status code for each host. Execute it please then and tell me how result.",
			},
		],
	});

	let counter = 0;
	for await (const message of stream) {
		console.log(message);
		counter++;
		if (counter > 300) {
			break;
		}
	}
};
