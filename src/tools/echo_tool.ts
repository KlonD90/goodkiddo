import { tool } from "langchain";
import { z } from "zod";

export const EchoTool = tool(
	({ input }: { input: string }) => {
		return input;
	},
	{
		name: "echo_tool",
		description: "A tool that echoes the input string.",
		schema: z.object({
			input: z.string().describe("The string to be echoed."),
		}),
	},
);
