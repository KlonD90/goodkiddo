import "@mantine/core/styles.css";
import "highlight.js/styles/github.min.css";
import "./styles.css";

import { createTheme, MantineProvider } from "@mantine/core";
import { createRoot } from "react-dom/client";
import { App } from "./App";

const theme = createTheme({
	primaryColor: "gray",
	fontFamily:
		'"SF Pro Display", "Geist Sans", "Helvetica Neue", "Switzer", Arial, sans-serif',
	fontFamilyMonospace: '"Geist Mono", "SF Mono", "JetBrains Mono", monospace',
	defaultRadius: "sm",
});

const container = document.getElementById("root");
if (container) {
	const root = createRoot(container);
	root.render(
		<MantineProvider theme={theme} defaultColorScheme="light">
			<App />
		</MantineProvider>,
	);
}
