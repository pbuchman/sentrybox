import { createRoot } from "react-dom/client";
import { App } from "./app.js";

const root = document.getElementById("root");
if (root === null) throw new Error("Error Hub root element is missing");

createRoot(root).render(<App />);
