/* The Spend levels mock (9 November 2026): the live card and its proposed
 * replacement side by side on the same synthetic release, for the owner's
 * go-ahead before anything ships. Data from scratch levels_mc.py. */
import React from "react";
import { createRoot } from "react-dom/client";
import SpendLevels from "../modules/SpendLevels.jsx";
import SpendLevelsNext from "./SpendLevelsNext.jsx";
import data from "./levels.json";
import "../tokens.css";

const params = new URLSearchParams(window.location.search);
const which = params.get("which") || "both";
const W = Number(params.get("w") || 516);

const snapOld = { type: "LE", paid: { levels: data.old } };
const snapNext = { type: "LE", paid: { levels: data.old, levelsNext: data.next } };

function Frame({ label, children }) {
  return (
    <div style={{ width: W, display: "flex", flexDirection: "column", gap: 8 }}>
      {label ? <div className="sect" style={{ padding: "0 2px" }}>{label}</div> : null}
      {children}
    </div>
  );
}

function Mock() {
  return (
    <div style={{ padding: 24, background: "#fbfbfb", display: "inline-flex", gap: 24, alignItems: "flex-start" }}>
      {(which === "both" || which === "old") && <Frame label={which === "both" ? "Today" : null}><SpendLevels snap={snapOld} /></Frame>}
      {(which === "both" || which === "next") && <Frame label={which === "both" ? "Proposed" : null}><SpendLevelsNext snap={snapNext} /></Frame>}
    </div>
  );
}

createRoot(document.getElementById("root")).render(<Mock />);
