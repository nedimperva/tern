import { render } from "solid-js/web";
import App from "./App";
import { quietBrowserKeys } from "./browserKeys";
import "@fontsource-variable/inter";
import "@fontsource/jetbrains-mono/400.css";
// The tide's headings and reading titles; 21 kB, and only the weight they use.
import "@fontsource/source-serif-4/600.css";
import "./styles/tokens.css";
import "./styles.css";

quietBrowserKeys();
render(() => <App />, document.getElementById("root")!);
