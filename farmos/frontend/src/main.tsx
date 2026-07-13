import React from "react";
import { createRoot } from "react-dom/client";
import App from "./app/App";
import { applyTheme } from "./app/theme";
import "./styles.css";

applyTheme(); // before first paint — no light-mode flash for dark-mode users

createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
