/**
 * CD range rules. Run: node --experimental-strip-types src/lib/cdRangeRules.test.ts
 */
import {
  CD_DEFAULTS,
  atmStrike,
  breakout,
  closeScore,
  dayStopHit,
  decideExit,
  draftFromSettings,
  entrySide,
  firstEntryLabel,
  formatSaved,
  insideRange,
  isUnsaved,
  nearestThursdayExpiry,
  orderQty,
  pastCutoff,
  squareTime,
  stopPx,
  targetPx,
  targetReached,
  trailArmPx,
  trailStopPx,
  validateCdDraft,
} from "./cdRangeRules.ts";

function assert(cond: unknown, msg: string): asserts cond {
  if (!cond) throw new Error(msg);
}

assert(orderQty(CD_DEFAULTS.lots) === 40, "default 2 lots is 40");
assert(orderQty(10) === 200, "10 lots is 200");
assert(orderQty(1) === 20, "1 lot is 20");
assert(orderQty(50) === 1000, "50 lots is the top");
assert(orderQty(0) == null, "0 lots is refused");
assert(orderQty(51) == null, "51 lots is refused");
assert(atmStrike(80450, 100) === 80500 || atmStrike(80440, 100) === 80400, "step 100 ATM");
assert(atmStrike(80450, 100) === 80500, "80450 rounds to 80500");

assert(breakout(110, 100, 50) === "PE", "spot above HIGH sells PE");
assert(breakout(40, 100, 50) === "CE", "spot below LOW sells CE");
assert(breakout(100, 100, 50) == null, "a print on HIGH is not a break");
assert(breakout(50, 100, 50) == null, "a print on LOW is not a break");
assert(insideRange(80, 100, 50), "80 is inside 50–100");
assert(!insideRange(100, 100, 50), "HIGH itself is not inside");

assert(targetPx(100) === 90, "target is 90");
assert(stopPx(100) === 112, "stop-loss is 112");
assert(trailArmPx(100) === 95, "trail arms at 95");
assert(trailStopPx(100) === 100, "trail lock 0 covers at the sell fill");
assert(trailStopPx(100, 2) === 98, "lock 2 covers at 98");
assert(trailArmPx(100, 5) === 95, "arm 5 is 95");
assert(firstEntryLabel(4, 15) === "10:15", "4 x 15m starts at 10:15");
assert(firstEntryLabel(2, 5) === "09:25", "2 x 5m starts at 09:25");

const flat = {
  hh: 11,
  mm: 0,
  spot: 110,
  high: 100,
  low: 50,
  tradable: true,
  hunting: true,
  needInside: false,
  seenInside: false,
};
assert(entrySide(flat) === "PE", "a fresh break sells");
assert(entrySide({ ...flat, hh: 14, mm: 30 }) == null, "14:30 blocks a new entry");
assert(entrySide({ ...flat, hh: 14, mm: 29 }) === "PE", "14:29 can still enter");
assert(entrySide({ ...flat, tradable: false }) == null, "a gap under 50 is no trade");
assert(entrySide({ ...flat, needInside: true, seenInside: false }) == null, "wait for a print back inside");
assert(entrySide({ ...flat, needInside: true, seenInside: true }) === "PE", "a new break after the inside print can sell");
assert(pastCutoff(14, 30) && squareTime(15, 14) && !squareTime(15, 13), "clock gates");

const held = {
  hh: 11,
  mm: 0,
  spot: 80,
  high: 100,
  low: 50,
  mid: 75,
  tradable: true,
  side: "PE" as const,
  sold: 100,
  ltp: 100,
  trailArmed: false,
  canFlip: true,
  midOn: false,
};

assert(decideExit({ ...held, ltp: 112 }).kind === "SL", "112 is the stop-loss");
assert(decideExit({ ...held, ltp: 96 }).armTrail === false, "96 has not armed the trail");
assert(decideExit({ ...held, ltp: 95 }).kind === "NONE" && decideExit({ ...held, ltp: 95 }).armTrail === true, "95 arms the trail");
assert(decideExit({ ...held, ltp: 100, trailArmed: true }).kind === "TRAIL", "armed trail covers at the fill");
assert(decideExit({ ...held, ltp: 89, trailArmed: true }).kind === "TARGET", "a jump through 10% is a target");
assert(
  decideExit({ ...held, ltp: 89, trailArmed: true, targetPct: 10, trailArmPct: 15, trailLockPct: 12 }).kind === "TARGET",
  "target wins when the print is also through the trail",
);
assert(decideExit({ ...held, ltp: 98, trailArmed: true, trailLockPct: 2 }).kind === "TRAIL", "lock 2 covers at 98");
assert(decideExit({ ...held, ltp: 97, trailArmed: true, trailLockPct: 2 }).kind === "NONE", "97 is still under the lock-2 cover");
assert(decideExit({ ...held, ltp: 100, slPct: 0, targetPct: 0 }).kind === "SL", "stop-loss ranks ahead of a zero target");
assert(decideExit({ ...held, ltp: 112, trailArmed: true }).kind === "SL", "stop-loss ranks ahead of the trail");
assert(decideExit({ ...held, hh: 15, mm: 14, ltp: 89 }).kind === "SQUARE", "15:14 square ranks first");

const flip = decideExit({ ...held, side: "CE", spot: 110, ltp: 100 });
assert(flip.kind === "OPPOSITE" && flip.kind === "OPPOSITE" && flip.next === "PE" && flip.flip, "HIGH break while short the CE flips to PE");
const late = decideExit({ ...held, side: "CE", spot: 110, hh: 14, mm: 30, canFlip: true });
assert(late.kind === "OPPOSITE" && late.flip === false, "14:30 covers and does not flip");
const noFlip = decideExit({ ...held, side: "PE", spot: 40, canFlip: false });
assert(noFlip.kind === "OPPOSITE" && noFlip.next === "CE" && noFlip.flip === false, "day stop covers without a flip");
const tightGap = decideExit({ ...held, side: "CE", spot: 110, tradable: false, canFlip: true });
assert(tightGap.kind === "OPPOSITE" && tightGap.flip === false, "a gap under the minimum covers and does not flip");
assert(decideExit({ ...held, side: "CE", spot: 80, midOn: true, ltp: 100 }).kind === "MID", "MID covers a CE at the mid when it is on");
assert(decideExit({ ...held, side: "CE", spot: 80, midOn: false, ltp: 100 }).kind === "NONE", "MID stays off");

assert(closeScore("TARGET", 100, 90) === 1, "a 10% cover scores +1");
assert(closeScore("TARGET", 100, 91) === 1, "one point of slack still scores +1");
assert(closeScore("TARGET", 100, 92) === 0, "a target label near the sell scores 0");
assert(closeScore("TARGET", 772.32, 766.1) === 0, "772.32 covered at 766.10 is 0");
assert(targetReached(772.32, 766.1) === false, "766.10 never reached 10%");
assert(closeScore("TRAIL", 100, 105) === 0, "a trail scores 0 even when it loses");
assert(closeScore("OPPOSITE", 100, 110) === -0.5, "a losing opposite break scores −0.5");
assert(closeScore("OPPOSITE", 100, 90) === 0, "a winning opposite break is not a loss");
assert(closeScore("SL", 100, 112) === -1, "a losing stop scores −1");
assert(closeScore("SQUARE", 100, 80) === 0, "a winning square scores 0");
assert(dayStopHit(2) && !dayStopHit(1.5) && !dayStopHit(9, 0), "net 2 stops the day, and 0 turns it off");

const saved = validateCdDraft(draftFromSettings(CD_DEFAULTS));
assert(saved.ok, "defaults save");
assert(formatSaved(CD_DEFAULTS).includes("Lots 2") && formatSaved(CD_DEFAULTS).includes("Qty 40"), "save log prints the set");
assert(!isUnsaved(draftFromSettings(CD_DEFAULTS), CD_DEFAULTS), "a matching draft is saved");
assert(isUnsaved({ ...draftFromSettings(CD_DEFAULTS), lots: "3" }, CD_DEFAULTS), "a typed lots change is unsaved");
assert(validateCdDraft({ ...draftFromSettings(CD_DEFAULTS), lots: "0" }).ok === false, "lots 0 is refused");
assert(validateCdDraft({ ...draftFromSettings(CD_DEFAULTS), tfMin: "61" }).ok === false, "TF 61 is refused");
assert(validateCdDraft({ ...draftFromSettings(CD_DEFAULTS), candles: "21" }).ok === false, "21 candles is refused");
assert(validateCdDraft({ ...draftFromSettings(CD_DEFAULTS), minGap: "5001" }).ok === false, "gap 5001 is refused");
assert(validateCdDraft({ ...draftFromSettings(CD_DEFAULTS), slPct: "101" }).ok === false, "SL 101 is refused");
assert(
  validateCdDraft({ ...draftFromSettings(CD_DEFAULTS), trailArmPct: "5", trailLockPct: "5" }).ok === false,
  "lock must be below the arm",
);
assert(validateCdDraft({ ...draftFromSettings(CD_DEFAULTS), trailArmPct: "5", trailLockPct: "2" }).ok, "lock 2 under arm 5 saves");
assert(validateCdDraft({ ...draftFromSettings(CD_DEFAULTS), trailArmPct: "0", trailLockPct: "0" }).ok, "lock 0 with arm 0 saves");
assert(validateCdDraft({ ...draftFromSettings(CD_DEFAULTS), extra: "5000" }).ok, "extra 5000 saves");
assert(breakout(106, 100, 50, 5) === "PE", "spot must clear HIGH by extra");
assert(breakout(104, 100, 50, 5) == null, "a short extra clearance is not a break");
assert(entrySide({ ...flat, spot: 104, extra: 5 }) == null, "entry uses the saved extra");

const rows = [
  { label: "28Oct2026", api: "wed" },
  { label: "29Oct2026", api: "thu" },
  { label: "30Oct2026", api: "fri" },
  { label: "05Nov2026", api: "next" },
];
const monday = new Date("2026-10-26T04:30:00Z");
const thursday = new Date("2026-10-29T04:30:00Z");
assert(nearestThursdayExpiry(rows, monday)?.label === "29Oct2026", "Monday uses the coming Thursday");
assert(nearestThursdayExpiry(rows, thursday)?.label === "05Nov2026", "Thursday itself is skipped");

console.log("cdRangeRules ok");
