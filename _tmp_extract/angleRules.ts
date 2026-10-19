/** Angle strategy — 7 closed-candle range breakout with MID SL / trail / target. */

export type AngleTimeframe = "1m" | "3m" | "5m" | "15m" | "30m";
export type AngleMinGap = 50 | 75;
export type AngleOptType = "CE" | "PE";
export type AnglePhase = "STOPPED" | "IDLE" | "IN_TRADE";
export type AngleExitReason =
  | "OPPOSITE_BREAK"
  | "MID_SL"
  | "MANUAL_SL"
  | "TRAIL"
  | "TARGET"
  | "MANUAL"
  | "EOD";

export type AngleRange = {
  high: number;
  low: number;
  mid: number;
  gap: number;
};

export type AnglePosition = {
  optType: AngleOptType;
  strike: number;
  iid: number;
  label: string;
  entryPremium: number;
  /** MID from the entry-time range — fixed for the life of the trade. */
  entryMid: number;
  entryHigh: number;
  entryLow: number;
  entryReason: "BREAKOUT_HIGH" | "BREAKOUT_LOW";
  trailArmed: boolean;
  enteredAt: number;
};

export function angleRangeFromBars(bars: { high: number; low: number }[]): AngleRange | null {
  if (!bars.length) return null;
  let high = -Infinity;
  let low = Infinity;
  for (const b of bars) {
    const h = Number(b.high);
    const l = Number(b.low);
    if (!(Number.isFinite(h) && Number.isFinite(l) && h > 0 && l > 0)) continue;
    if (h > high) high = h;
    if (l < low) low = l;
  }
  if (!(Number.isFinite(high) && Number.isFinite(low) && high >= low && low > 0)) return null;
  return { high, low, mid: (high + low) / 2, gap: high - low };
}

export function angleGapOk(gap: number, minGap: AngleMinGap): boolean {
  return Number.isFinite(gap) && gap >= minGap;
}

/** Instant entry on live spot vs current rolling range (GAP must already be valid). */
export function angleEntrySignal(
  spot: number,
  range: AngleRange,
): { optType: AngleOptType; reason: "BREAKOUT_HIGH" | "BREAKOUT_LOW" } | null {
  if (!(Number.isFinite(spot) && spot > 0)) return null;
  if (spot > range.high) return { optType: "PE", reason: "BREAKOUT_HIGH" };
  if (spot < range.low) return { optType: "CE", reason: "BREAKOUT_LOW" };
  return null;
}

/**
 * Exit priority (first match wins).
 * 1 Opposite range break (rolling 7× TF, valid GAP)
 * 2 MID SL (entry mid, fixed)
 * 3 Manual SL (optional premium ≥ level)
 * 4 Trail (after 20% decay → exit if premium returns to entry)
 * 5 Target (50% premium decay)
 */
export function angleEvaluateExit(args: {
  spot: number;
  premium: number;
  pos: AnglePosition;
  rolling: AngleRange | null;
  rollingGapOk: boolean;
  manualSl: number | null;
}): { action: "none" } | { action: "arm_trail" } | { action: "exit"; reason: AngleExitReason } {
  const { spot, premium, pos, rolling, rollingGapOk, manualSl } = args;
  if (!(Number.isFinite(spot) && spot > 0 && Number.isFinite(premium) && premium > 0)) {
    return { action: "none" };
  }

  if (rolling && rollingGapOk) {
    if (pos.optType === "CE" && spot > rolling.high) {
      return { action: "exit", reason: "OPPOSITE_BREAK" };
    }
    if (pos.optType === "PE" && spot < rolling.low) {
      return { action: "exit", reason: "OPPOSITE_BREAK" };
    }
  }

  if (pos.optType === "CE" && spot >= pos.entryMid) {
    return { action: "exit", reason: "MID_SL" };
  }
  if (pos.optType === "PE" && spot <= pos.entryMid) {
    return { action: "exit", reason: "MID_SL" };
  }

  if (manualSl != null && Number.isFinite(manualSl) && manualSl > 0 && premium >= manualSl) {
    return { action: "exit", reason: "MANUAL_SL" };
  }

  const decay20 = pos.entryPremium * 0.8;
  const trailArmed = pos.trailArmed || premium <= decay20;

  if (trailArmed && premium >= pos.entryPremium) {
    return { action: "exit", reason: "TRAIL" };
  }

  if (premium <= pos.entryPremium * 0.5) {
    return { action: "exit", reason: "TARGET" };
  }

  if (trailArmed && !pos.trailArmed) {
    return { action: "arm_trail" };
  }

  return { action: "none" };
}

/** After 15:30 IST — freeze live entries/exits. */
export function angleIsAfterCutoff(nowMs: number = Date.now()): boolean {
  try {
    const parts = new Intl.DateTimeFormat("en-GB", {
      timeZone: "Asia/Kolkata",
      hour: "2-digit",
      minute: "2-digit",
      hour12: false,
    }).formatToParts(new Date(nowMs));
    const hh = Number(parts.find((p) => p.type === "hour")?.value ?? "0");
    const mm = Number(parts.find((p) => p.type === "minute")?.value ?? "0");
    return hh > 15 || (hh === 15 && mm >= 30);
  } catch {
    const d = new Date(nowMs);
    return d.getHours() > 15 || (d.getHours() === 15 && d.getMinutes() >= 30);
  }
}

export function angleExitReasonLabel(reason: AngleExitReason): string {
  switch (reason) {
    case "OPPOSITE_BREAK":
      return "Opposite break";
    case "MID_SL":
      return "MID SL";
    case "MANUAL_SL":
      return "Manual SL";
    case "TRAIL":
      return "Trail";
    case "TARGET":
      return "Target 50%";
    case "MANUAL":
      return "Manual";
    case "EOD":
      return "EOD";
    default:
      return reason;
  }
}

export function angleShortPnlPts(entryPremium: number, exitPremium: number): number {
  return entryPremium - exitPremium;
}
