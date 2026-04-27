import "@mantine/core/styles.css";
import "highlight.js/styles/github-dark.min.css";
import "./styles.css";

import { createTheme, MantineProvider } from "@mantine/core";
import { createRoot } from "react-dom/client";
import { App } from "./App";

const theme = createTheme({
	primaryColor: "blue",
	fontFamily:
		'-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif',
	fontFamilyMonospace: '"SF Mono", Menlo, ui-monospace, monospace',
	defaultRadius: "md",
});

const container = document.getElementById("root");
if (container) {
	const root = createRoot(container);
	root.render(
		<MantineProvider theme={theme} defaultColorScheme="dark">
			<App />
		</MantineProvider>,
	);
}
