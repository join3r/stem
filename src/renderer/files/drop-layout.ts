// Sizing + ordering for the drop overlay's folder tiles (see DropOverlay.tsx).
// Pure so it can be unit-tested; the overlay measures the window and asks here
// how many columns to use and whether everything fits.

export const ROOT = '__root__';
export const OTHER = '__other__';

/** Share of the window height the "Top level" zone keeps when folders exist. */
export const ROOT_SHARE = 0.34;
const TILE_MIN_H = 44;
const TILE_MIN_W = 160;
const GAP = 8;
const PAD = 24;
/** Room kept at the bottom for the "Esc to cancel" footer. */
const FOOT = 56;
const MAX_COLS = 3;

export interface TileLayout {
  cols: number;
  /** How many tiles fit, including the "Other folder…" tile when overflowing. */
  capacity: number;
  /** More folders than tiles: show the recent ones plus "Other folder…". */
  overflow: boolean;
  /** Few folders with tall tiles: there is room for a second line. */
  roomy: boolean;
}

export function dropTileLayout(count: number, halfWidth: number, height: number): TileLayout {
  const areaH = Math.max(height * (1 - ROOT_SHARE) - FOOT - PAD * 2, TILE_MIN_H);
  const areaW = Math.max(halfWidth - PAD * 2, TILE_MIN_W);
  const maxCols = Math.max(1, Math.min(MAX_COLS, Math.floor((areaW + GAP) / (TILE_MIN_W + GAP))));
  const rowsFit = Math.max(1, Math.floor((areaH + GAP) / (TILE_MIN_H + GAP)));

  for (let cols = 1; cols <= maxCols; cols++) {
    const rows = Math.ceil(count / cols);
    if (rows <= rowsFit) {
      const tileH = rows ? (areaH - GAP * (rows - 1)) / rows : 0;
      return {
        cols,
        capacity: cols * rowsFit,
        overflow: false,
        roomy: cols === 1 && tileH >= 72
      };
    }
  }
  return {
    cols: maxCols,
    capacity: maxCols * rowsFit,
    overflow: true,
    roomy: false
  };
}

const RECENT_KEY = 'stem.dropRecentDirs';
const RECENT_MAX = 50;

function readRecent(): string[] {
  try {
    const raw = JSON.parse(localStorage.getItem(RECENT_KEY) ?? '[]');
    return Array.isArray(raw) ? raw.filter((d): d is string => typeof d === 'string') : [];
  } catch {
    return [];
  }
}

/** Remember a folder a file was dropped into, most recent first. */
export function recordDropDir(dir: string): void {
  try {
    const next = [dir, ...readRecent().filter((d) => d !== dir)].slice(0, RECENT_MAX);
    localStorage.setItem(RECENT_KEY, JSON.stringify(next));
  } catch {
    /* storage unavailable: ordering just falls back to alphabetical */
  }
}

/** Recently used folders first (that still exist), then the rest in listing order. */
export function orderDropDirs(dirs: string[], recent: string[] = readRecent()): string[] {
  const have = new Set(dirs);
  const first = recent.filter((d) => have.has(d));
  const seen = new Set(first);
  return [...first, ...dirs.filter((d) => !seen.has(d))];
}
