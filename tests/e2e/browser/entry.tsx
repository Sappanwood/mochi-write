import { createRoot } from "react-dom/client";
import { App } from "../../../src/web/App.js";
import "../../../src/web/style.css";
const initialization = Promise.resolve({
  async login() {
    sessionStorage.setItem("fixture-session", "signed");
  },
  async token() {
    if (!sessionStorage.getItem("fixture-session"))
      throw new Error("登录已过期");
    return (await (await fetch("/fixture-token")).json()).token as string;
  },
  async logout() {
    sessionStorage.removeItem("fixture-session");
  },
});
createRoot(document.getElementById("root")!).render(
  <App initialization={initialization} />,
);
