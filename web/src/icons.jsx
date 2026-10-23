/* The page's icons: 16-unit stroke glyphs, the set the design canvas uses.
 * Every one is decorative (aria-hidden); the control that carries it names
 * itself. `I(paths, size, weight)` makes one; the named exports are the ones
 * used in more than one place. */
import React from "react";

export const I = (d, w = 15, sw = 1.4, extra = {}) => (
  <svg width={w} height={w} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth={sw} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" {...extra}
    dangerouslySetInnerHTML={{ __html: d }} />
);

export const Dots = ({ w = 14 }) => (
  <svg width={w} height={w} viewBox="0 0 16 16" fill="currentColor" aria-hidden="true"><circle cx="3.5" cy="8" r="1.3" /><circle cx="8" cy="8" r="1.3" /><circle cx="12.5" cy="8" r="1.3" /></svg>
);
export const Up = () => <svg width="10" height="10" viewBox="0 0 10 10" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M5 8.5v-7M2 4.5l3-3 3 3" /></svg>;
export const Dn = () => <svg width="10" height="10" viewBox="0 0 10 10" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M5 1.5v7M2 5.5l3 3 3-3" /></svg>;
export const Caret = ({ w = 10 }) => <svg width={w} height={w} viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden="true"><path d="M3 4.5l3 3 3-3" /></svg>;
export const Caret8 = () => <svg width="8" height="8" viewBox="0 0 10 10" fill="currentColor" aria-hidden="true"><path d="M1.5 3h7L5 7.5z" /></svg>;
export const Chev = () => <svg className="chev" width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden="true"><path d="M4.5 3l3 3-3 3" /></svg>;
export const Search = ({ w = 15 }) => I('<circle cx="7" cy="7" r="4.5"></circle><path d="M10.5 10.5L14 14"></path>', w);
export const Cal = ({ w = 13 }) => I('<rect x="2" y="3" width="12" height="11" rx="2"></rect><path d="M2 6.5h12M5.5 1.5v3M10.5 1.5v3"></path>', w, 1.5);
export const Clock = ({ w = 13 }) => I('<circle cx="8" cy="8" r="6"></circle><path d="M8 4.5V8l2.5 1.5"></path>', w, 1.5);
export const Target = ({ w = 14, color }) => I('<circle cx="8" cy="8" r="6"></circle><circle cx="8" cy="8" r="2.5"></circle>', w, 1.5, color ? { style: { color } } : {});
export const Bmk = ({ w = 14 }) => <svg width={w} height={w} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeDasharray="1.5 2.2" strokeLinecap="round" aria-hidden="true"><circle cx="8" cy="8" r="6" /></svg>;
export const Ring = ({ w = 14 }) => <svg width={w} height={w} viewBox="0 0 16 16" fill="none" stroke="#a1a1aa" strokeWidth="1.5" strokeDasharray="2 2.2" aria-hidden="true"><circle cx="8" cy="8" r="6" /></svg>;
export const Wallet = ({ w = 14 }) => I('<rect x="2" y="4" width="12" height="8" rx="1.5"></rect><circle cx="8" cy="8" r="1.6"></circle>', w);
export const Trend = ({ w = 14 }) => I('<path d="M2.5 11l4-4 2.5 2.5L13.5 5"></path><path d="M10 5h3.5v3.5"></path>', w);
export const People = ({ w = 14 }) => I('<circle cx="8" cy="5.5" r="2.5"></circle><path d="M3 13.5c.8-2.6 2.8-4 5-4s4.2 1.4 5 4"></path>', w);
export const Img = ({ w = 16 }) => I('<rect x="2.5" y="2.5" width="11" height="11" rx="2"></rect><circle cx="6" cy="6.5" r="1.2"></circle><path d="M3 12l3.5-3.5 2.5 2.5 2-2 2.5 2.5"></path>', w);
export const Basket = ({ w = 13 }) => I('<path d="M2.5 6h11l-1.2 7.5h-8.6z"></path><path d="M5.5 6l2.5-3.5L10.5 6"></path>', w);
export const Lines = ({ w = 13 }) => I('<path d="M3 4h10M3 8h10M3 12h6"></path>', w);
export const Arrow = ({ w = 13 }) => I('<path d="M8 13V3M8 3L4 7M8 3l4 4"></path>', w);
export const X = ({ w = 14 }) => I('<path d="M4 4l8 8M12 4l-8 8"></path>', w, 1.6);
export const Plus = ({ w = 14 }) => I('<path d="M8 3v10M3 8h10"></path>', w, 1.5);
export const Check = ({ w = 14 }) => I('<path d="M3 8.5l3.2 3L13 4.5"></path>', w, 1.6);
export const Undo = ({ w = 14 }) => I('<path d="M3 8a5 5 0 1 0 1.5-3.5"></path><path d="M3 2.5v2.5h2.5"></path>', w, 1.5);
export const Send = ({ w = 15 }) => I('<path d="M2.5 8L13.5 3l-3.5 10.5-2.5-4.5z"></path>', w);
export const Agent = ({ w = 14 }) => <svg width={w} height={w} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round" aria-hidden="true"><path d="M3 2.5l10 4.2-4.3 1.6L7 12.8z" /></svg>;
export const History = () => I('<path d="M3 8a5 5 0 1 0 1.5-3.5"></path><path d="M3 2.5v2.5h2.5"></path><path d="M8 5.5V8l1.8 1.2"></path>');
export const Minimise = () => I('<path d="M4 11h8"></path>');
export const Expand = () => I('<path d="M9.5 3H13v3.5M13 3L9 7M6.5 13H3V9.5M3 13l4-4"></path>');
export const Hamburger = () => I('<path d="M2.5 4h11M2.5 8h11M2.5 12h11"></path>', 15, 1.5);
export const Releases = () => I('<rect x="2" y="2.5" width="12" height="11" rx="2"></rect><path d="M2 6h12"></path>');
export const Targets = () => I('<circle cx="8" cy="8" r="5.5"></circle><circle cx="8" cy="8" r="2.5"></circle>');
export const Book = () => I('<path d="M3 3.5h4a1.5 1.5 0 0 1 1.5 1.5v8A1.5 1.5 0 0 0 7 11.5H3z"></path><path d="M13 3.5H9.5A1.5 1.5 0 0 0 8 5v8a1.5 1.5 0 0 1 1.5-1.5H13z"></path>');
export const Key = () => I('<circle cx="5.5" cy="10.5" r="2.5"></circle><path d="M7.3 8.7L13 3M11 5l1.5 1.5M9.5 6.5L11 8"></path>');
export const SignOut = () => I('<path d="M6 3H3.5v10H6"></path><path d="M10 5l3 3-3 3M13 8H6.5"></path>');
export const Display = () => <svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden="true"><path d="M2 4h12M4 8h8M6 12h4" /></svg>;
export const Panel = () => I('<rect x="2" y="2.5" width="12" height="11" rx="2"></rect><path d="M10 2.5v11"></path>');
export const Filter = ({ w = 12 }) => I('<path d="M2.5 4h11M4.5 8h7M6.5 12h3"></path>', w, 1.5);
export const Bars = ({ w = 12 }) => I('<rect x="2" y="7" width="3" height="6" rx="0.5"></rect><rect x="6.5" y="4" width="3" height="9" rx="0.5"></rect><rect x="11" y="2" width="3" height="11" rx="0.5"></rect>', w);
export const Euro = ({ w = 12 }) => I('<path d="M11.5 4.5a4.5 4.5 0 1 0 0 7M3 7h6M3 9.5h6"></path>', w, 1.5);
export const Frame = ({ w = 12 }) => I('<rect x="2" y="2" width="12" height="12" rx="1"></rect><rect x="5" y="5" width="6" height="6"></rect>', w);
export const Scatter = ({ w = 14 }) => I('<circle cx="5" cy="10" r="1.6"></circle><circle cx="10.5" cy="5.5" r="1.6"></circle><circle cx="11" cy="11.5" r="1.6"></circle>', w);
export const Slack = ({ w = 15 }) => I('<path d="M6 2.5v11M10 2.5v11M2.5 6h11M2.5 10h11"></path>', w);
export const Diamond = ({ w = 14, filled = true }) => <svg width={w} height={w} viewBox="0 0 12 12" aria-hidden="true"><path d="M6 1l5 5-5 5-5-5z" fill={filled ? "#5e6ad2" : "none"} stroke={filled ? "#5e6ad2" : "#8a8a8e"} strokeWidth="1.3" /></svg>;
export const Warn = ({ w = 14 }) => <svg width={w} height={w} viewBox="0 0 16 16" fill="none" aria-hidden="true"><path d="M8 2.2l6 10.6H2z" fill="#e8743b" /><path d="M8 6.4v3.2" stroke="#fff" strokeWidth="1.5" strokeLinecap="round" /><circle cx="8" cy="11.4" r="0.85" fill="#fff" /></svg>;
export const Spinner = ({ w = 11 }) => <svg className="spin" width={w} height={w} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true"><path d="M8 2a6 6 0 1 1-6 6" /></svg>;
export const Meta = () => <span style={{ width: 16, height: 16, flex: "0 0 16px", borderRadius: 4, background: "#1877f2", color: "#fff", display: "inline-flex", alignItems: "center", justifyContent: "center", fontSize: 9, fontWeight: 700 }} aria-hidden="true">M</span>;

/* a progress ring, `pct` of the way round, for the status chip */
export const ProgressRing = ({ pct, color = "#5e6ad2" }) => (
  <svg width="12" height="12" viewBox="0 0 14 14" aria-hidden="true">
    <circle cx="7" cy="7" r="5.5" fill="none" stroke="#e0e0e3" strokeWidth="2" />
    <circle cx="7" cy="7" r="5.5" fill="none" stroke={color} strokeWidth="2" strokeDasharray={`${(Math.max(0, Math.min(1, pct)) * 34.6).toFixed(1)} 34.6`} transform="rotate(-90 7 7)" />
  </svg>
);
