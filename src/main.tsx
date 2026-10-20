import { render } from "solid-js/web";
import App from "./App";
import { quietBrowserKeys } from "./browserKeys";
import "@fontsource-variable/inter";
import "@fontsource/jetbrains-mono/400.css";
import "./styles/tokens.css";
import "./styles.css";

quietBrowserKeys();
render(() => <App />, document.getElementById("root")!);
