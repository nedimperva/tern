import { render } from "solid-js/web";
import App from "./App";
import { OwnWindow, ownWindowId } from "./components/OwnWindow";
import { quietBrowserKeys } from "./browserKeys";
import "@fontsource-variable/inter";
import "@fontsource/jetbrains-mono/400.css";
// The tide's headings and reading titles; 21 kB, and only the weight they use.
import "@fontsource/source-serif-4/600.css";
import "./styles/tokens.css";
import "./styles.css";

quietBrowserKeys();
// A conversation's own window loads the same page (idea 123).
const own = ownWindowId();
render(() => (own != null ? <OwnWindow id={own} /> : <App />), document.getElementById("root")!);
