/* When a refresh has landed while a page has been open.
 *
 * The page fetches a release once and then watches /api/refresh/status. A
 * refresh that finishes behind its back leaves it holding numbers the server
 * has already replaced, so it has to notice and re-fetch. Telling "finished
 * while we were watching" from "finished before we arrived" is the whole
 * problem: the second must not re-fetch, because the page has just loaded that
 * very data, and the first must, because it has not.
 *
 * The timestamp alone cannot tell them apart. A refresh that has never
 * completed in this process reports no timestamp at all, so the first one
 * after a deploy moves it from nothing to something - indistinguishable, by
 * that field, from an ordinary load arriving after a refresh that finished an
 * hour ago. That is the case that most needs the re-fetch: the page was served
 * the committed fallback and the refresh is what replaces it.
 *
 * So the run is watched rather than the timestamp. Any status saying a refresh
 * has not finished - running now, or never run at all - arms the watch, and
 * the next status carrying a timestamp has landed. A timestamp that changes
 * from a known earlier one lands too, for the hourly case where the whole run
 * fell between two polls.
 *
 * `state` is opaque and starts as `initial()`; feed each status to `step` and
 * re-fetch when it returns `reload`. */
export const initial = () => ({ at: undefined, armed: false });

export function step(state, st) {
  if (!st) return { reload: false, state };
  if (st.running || !st.at) return { reload: false, state: { at: st.at, armed: true } };
  const moved = state.at !== undefined && st.at !== state.at;
  return { reload: moved || state.armed, state: { at: st.at, armed: false } };
}
