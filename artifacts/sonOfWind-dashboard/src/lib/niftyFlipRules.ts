/**
 * NIFTY Flip — one short at a time.
 * Bull sells PE, Bear sells CE, Flip books the open short and sells the other side.
 * Independent of Ladder and Snake. Do not import those files.
 */

export const UNDERLYING = "NIFTY";
export const LOT_SIZE = 65;
export const DEFAULT_QTY = 780;
export const FLIP_STORE_KEY = "sow_nifty_flip_v1";

export const FLIP_RATIOS = [
  { id: "80-100", label: "80 - 100", low: 80, high: 100 },
  { id: "60-79", label: "60 - 79", low: 60, high: 79 },
  { id: "45-59", label: "45 - 59", low: 45, high: 59 },
] as const;

export const FLIP_SIZES = [1, 2, 3] as const;

export type FlipRatioId = (typeof FLIP_RATIOS)[number]["id"];
export type FlipSize = (typeof FLIP_SIZES)[number];
export type FlipSide = "CE" | "PE";
export type FlipLogKind = "info" | "entry" | "exit" | "error";

export type FlipRatio = (typeof FLIP_RATIOS)[number];

export type FlipChainRow = {
  strike: number;
  ltp: number | null;
  instrumentId: number | null;
};

export type FlipPick = {
  strike: number;
  ltp: number;
  instrumentId: number;
};

export type FlipPosition = {
  instrumentId: number;
  strike: number;
  optionType: FlipSide;
  qty: number;
  fillPx: number;
  openedAt: number;
};

export type FlipLog = {
  id: number;
  ts: number;
  text: string;
  kind: FlipLogKind;
};

export type FlipSession = {
  v: 1;
  qtyText: string;
  ratioId: FlipRatioId;
  size: FlipSize;
  position: FlipPosition | null;
  logs: FlipLog[];
  nextLogId: number;
};

export function ratioById(id: string | null | undefined): FlipRatio {
  const key = id === "60-70" ? "60-79" : id;
  return FLIP_RATIOS.find((r) => r.id === key) ?? FLIP_RATIOS[0];
}

export function oppositeSide(side: FlipSide): FlipSide {
  return side === "CE" ? "PE" : "CE";
}

export type FlipSignal = "BULL" | "BEAR";
export type AutoFlipAction = "hold" | "enter" | "flip";

/** Bull sells PE, Bear sells CE — same mapping as the manual buttons. */
export function sideForSignal(signal: FlipSignal): FlipSide {
  return signal === "BULL" ? "PE" : "CE";
}

/**
 * Auto stays on the signal side until Stop.
 * Flat → enter. Opposite short → flip. Already on that side → hold.
 */
export function autoFlipAction(signal: FlipSignal | null, openSide: FlipSide | null): AutoFlipAction {
  if (!signal) return "hold";
  const want = sideForSignal(signal);
  if (openSide === want) return "hold";
  return openSide ? "flip" : "enter";
}

/** Highest premium inside the inclusive band. Two strikes in range: the higher price wins. Equal price keeps the higher strike. */
export function pickHighestInBand(rows: FlipChainRow[], low: number, high: number): FlipPick | null {
  const hits: FlipPick[] = [];
  for (const row of rows) {
    const ltp = row.ltp;
    const instrumentId = row.instrumentId;
    if (typeof instrumentId !== "number" || !Number.isFinite(instrumentId) || instrumentId <= 0) continue;
    if (typeof ltp !== "number" || !Number.isFinite(ltp) || ltp <= 0) continue;
    if (ltp < low || ltp > high) continue;
    if (!Number.isFinite(row.strike) || row.strike <= 0) continue;
    hits.push({ strike: row.strike, ltp, instrumentId });
  }
  if (!hits.length) return null;
  hits.sort((a, b) => {
    if (b.ltp !== a.ltp) return b.ltp - a.ltp;
    return b.strike - a.strike;
  });
  return hits[0] ?? null;
}

export function resolveOrderQty(
  qtyText: string,
  size: FlipSize,
): { qty: number; base: number } | { error: string } {
  const raw = String(qtyText ?? "").replace(/,/g, "").trim();
  if (!raw) return { error: "Qty box empty hai" };
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0 || !Number.isInteger(n)) {
    return { error: "Qty positive whole number honi chahiye" };
  }
  if (n % LOT_SIZE !== 0) {
    return { error: `Qty ${n} NIFTY lot ${LOT_SIZE} ka multiple nahi` };
  }
  const qty = n * size;
  if (!Number.isInteger(qty) || qty <= 0 || qty % LOT_SIZE !== 0) {
    return { error: "Order qty lot size ke bahar chali gayi" };
  }
  return { qty, base: n };
}

export function shortMtm(fillPx: number, ltp: number | null, qty: number): number | null {
  if (!(fillPx > 0) || ltp == null || !(ltp > 0) || !(qty > 0)) return null;
  return (fillPx - ltp) * qty;
}

function isRatioId(v: unknown): v is FlipRatioId {
  return v === "60-70" || FLIP_RATIOS.some((r) => r.id === v);
}

function isSize(v: unknown): v is FlipSize {
  return v === 1 || v === 2 || v === 3;
}

function isSide(v: unknown): v is FlipSide {
  return v === "CE" || v === "PE";
}

function readPosition(raw: unknown): FlipPosition | null {
  if (!raw || typeof raw !== "object") return null;
  const p = raw as Partial<FlipPosition>;
  if (!isSide(p.optionType)) return null;
  if (typeof p.instrumentId !== "number" || p.instrumentId <= 0) return null;
  if (typeof p.strike !== "number" || p.strike <= 0) return null;
  if (typeof p.qty !== "number" || p.qty <= 0) return null;
  if (typeof p.fillPx !== "number" || !(p.fillPx > 0)) return null;
  return {
    instrumentId: p.instrumentId,
    strike: p.strike,
    optionType: p.optionType,
    qty: Math.floor(p.qty),
    fillPx: p.fillPx,
    openedAt: typeof p.openedAt === "number" ? p.openedAt : Date.now(),
  };
}

function readLogs(raw: unknown): FlipLog[] {
  if (!Array.isArray(raw)) return [];
  const out: FlipLog[] = [];
  for (const row of raw) {
    if (!row || typeof row !== "object") continue;
    const l = row as Partial<FlipLog>;
    if (typeof l.id !== "number" || typeof l.text !== "string") continue;
    const kind: FlipLogKind =
      l.kind === "entry" || l.kind === "exit" || l.kind === "error" || l.kind === "info" ? l.kind : "info";
    out.push({
      id: l.id,
      ts: typeof l.ts === "number" ? l.ts : Date.now(),
      text: l.text,
      kind,
    });
  }
  return out.slice(0, 120);
}

export function loadFlipSession(): FlipSession | null {
  let raw: string | null = null;
  try {
    raw = sessionStorage.getItem(FLIP_STORE_KEY);
  } catch {
    raw = null;
  }
  if (!raw) {
    try {
      raw = localStorage.getItem(FLIP_STORE_KEY);
    } catch {
      raw = null;
    }
  }
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as Partial<FlipSession>;
    if (!parsed || parsed.v !== 1) return null;
    const logs = readLogs(parsed.logs);
    const nextFromLogs = logs.reduce((m, l) => Math.max(m, l.id), 0) + 1;
    return {
      v: 1,
      qtyText: typeof parsed.qtyText === "string" && parsed.qtyText.trim() ? parsed.qtyText : String(DEFAULT_QTY),
      ratioId: ratioById(isRatioId(parsed.ratioId) ? parsed.ratioId : FLIP_RATIOS[0].id).id,
      size: isSize(parsed.size) ? parsed.size : 1,
      position: readPosition(parsed.position),
      logs,
      nextLogId: typeof parsed.nextLogId === "number" && parsed.nextLogId > 0 ? parsed.nextLogId : nextFromLogs,
    };
  } catch {
    return null;
  }
}

export function saveFlipSession(snap: FlipSession): void {
  const raw = JSON.stringify(snap);
  try {
    sessionStorage.setItem(FLIP_STORE_KEY, raw);
  } catch {
    /* ignore */
  }
  try {
    localStorage.setItem(FLIP_STORE_KEY, raw);
  } catch {
    /* ignore */
  }
}

export function clearFlipSession(): void {
  try {
    sessionStorage.removeItem(FLIP_STORE_KEY);
  } catch {
    /* ignore */
  }
  try {
    localStorage.removeItem(FLIP_STORE_KEY);
  } catch {
    /* ignore */
  }
}
