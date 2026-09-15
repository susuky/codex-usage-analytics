import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { BrowserRouter } from "react-router-dom";
import { App } from "./App";
import { DataProvider } from "./lib/data";
import { CloudProvider } from "./lib/cloud";
import "./styles.css";

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <BrowserRouter>
      <DataProvider>
        <CloudProvider><App /></CloudProvider>
      </DataProvider>
    </BrowserRouter>
  </StrictMode>
);
