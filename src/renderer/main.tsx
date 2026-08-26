import React from "react";
import ReactDOM from "react-dom/client";
import { App } from "./App";
import { CaptionApp } from "./CaptionApp";

const isCaptionWindow = new URLSearchParams(location.search).get("view") === "caption";
const isWorkbenchWindow = new URLSearchParams(location.search).get("window") === "workbench";
if (isCaptionWindow) document.body.classList.add("caption-page");
if (isWorkbenchWindow) {
  document.body.classList.add("workbench-page");
}

const root = ReactDOM.createRoot(document.getElementById("root")!);

async function render(): Promise<void> {
  if (isCaptionWindow) {
    await import("./caption.css");
    root.render(
      <React.StrictMode>
      <CaptionApp />
      </React.StrictMode>,
    );
    return;
  }

  if (isWorkbenchWindow) {
    const [, { TooltipProvider }, { Toaster }] = await Promise.all([
      import("./ui.css"),
      import("./components/ui/tooltip"),
      import("./components/ui/sonner"),
    ]);
    root.render(
      <React.StrictMode>
      <TooltipProvider>
        <App />
        <Toaster />
      </TooltipProvider>
      </React.StrictMode>,
    );
    return;
  }

  await Promise.all([
    import("./styles.css"),
    import("./pet.css"),
    import("./pixel-theme.css"),
  ]);

  root.render(
    <React.StrictMode>
      <App />
    </React.StrictMode>,
  );
}

void render();
