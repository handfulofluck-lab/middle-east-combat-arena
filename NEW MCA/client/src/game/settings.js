// Client-side settings + match records, persisted in localStorage.
// Presentation-only: the sim never reads these.

export const MCA_VERSION = '0.5.2';
// build_singlefile.py stamps this at build time; dev builds keep the placeholder
export const MCA_BUILD = '__MCA_BUILD_TS__';

const SETTINGS_KEY = 'mca.settings.v1';
const RECORDS_KEY = 'mca.records.v1';

export const DEFAULT_SETTINGS = {
  volume: 0.7,
  muted: false,
  screenShake: true,
  showHints: true,
};

export function loadSettings() {
  try {
    if (typeof localStorage === 'undefined') return { ...DEFAULT_SETTINGS };
    const raw = localStorage.getItem(SETTINGS_KEY);
    if (!raw) return { ...DEFAULT_SETTINGS };
    return { ...DEFAULT_SETTINGS, ...JSON.parse(raw) };
  } catch (e) {
    return { ...DEFAULT_SETTINGS };
  }
}

export function saveSettings(s) {
  try {
    if (typeof localStorage === 'undefined') return;
    localStorage.setItem(SETTINGS_KEY, JSON.stringify(s));
  } catch (e) { /* best-effort */ }
}

// ---- match records ------------------------------------------------------------

export function loadRecords() {
  try {
    if (typeof localStorage === 'undefined') return { wins: 0, losses: 0, byFaction: {} };
    const raw = localStorage.getItem(RECORDS_KEY);
    if (!raw) return { wins: 0, losses: 0, byFaction: {} };
    const r = JSON.parse(raw);
    return { wins: r.wins || 0, losses: r.losses || 0, byFaction: r.byFaction || {} };
  } catch (e) {
    return { wins: 0, losses: 0, byFaction: {} };
  }
}

// won: boolean; faction: player faction name; stats: AAR object for last-match memory
export function recordResult(won, faction, stats) {
  const r = loadRecords();
  if (won) r.wins++; else r.losses++;
  const f = r.byFaction[faction] || { w: 0, l: 0 };
  if (won) f.w++; else f.l++;
  r.byFaction[faction] = f;
  r.lastMatch = { won, faction, when: Date.now(), stats: stats || null };
  try {
    if (typeof localStorage !== 'undefined') {
      localStorage.setItem(RECORDS_KEY, JSON.stringify(r));
    }
  } catch (e) { /* best-effort */ }
  return r;
}
