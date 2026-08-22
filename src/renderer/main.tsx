import React from "react";
import ReactDOM from "react-dom/client";
import { App } from "./App";
import { CaptionApp } from "./CaptionApp";
import "./styles.css";
import "./pet.css";
import "./pixel-theme.css";
import "./caption.css";

const isCaptionWindow = new URLSearchParams(location.search).get("view") === "caption";
if (isCaptionWindow) document.body.classList.add("caption-page");

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    {isCaptionWindow ? <CaptionApp /> : <App />}
  </React.StrictMode>,
);
