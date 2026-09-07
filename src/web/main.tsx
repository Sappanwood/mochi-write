import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App.js";
import "./style.css";
const initialization = import("./auth.js").then(({ createAuthClient }) =>
  createAuthClient(),
);
createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App initialization={initialization} />
  </StrictMode>,
);
