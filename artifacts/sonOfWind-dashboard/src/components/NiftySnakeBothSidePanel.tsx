import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { ChainResolved } from "@/types/market";
import { useLiveLtp, peekLiveTick } from "@/context/LiveLtpContext";
import { liveTapeLtp } from "@/lib/liveQuote";
import { useSubscribeTouchline } from "@/lib/mdRegistry";
import { fmtPnl, fmtPrice } from "@/lib/formatNumber";
import { apiFetch } from "@/lib/backend";
import {
  bumpPositionsRefresh,
  fetchIxPositions,
  POSITIONS_REFRESH_EVENT,
  setLocalShortPosition,
  clearLocalPosition,
} from "@/lib/ixPortfolio";
import {
  XTS_IX_ORDER_BASE,
  expectedLadderFill,
  ixOrderRejectedMessage,
  ladderOrderPricing,
  xtsOrderFillPx,
} from "@/lib/xtsOrder";
import { liveAtmStrikeForChain } from "@/lib/liveAtmStrike";
import { toast } from "@/hooks/use-toast";
import {
  BAND_HIGH,
  BAND_LOW,
  BAND_TARGET,
  BOTHSIDE_CLOCK_MS,
  CAP_LOTS_1X,
  EOD_MINUTE,
  ENABLE_HEDGES,
  ENTRY_MINUTE,
  EV_NIFTY_BOTHSIDE_FLAT,
  LOT_SIZE,
  MANUAL_STRIKE_OFFSETS,
  MAX_PLAN_TICKS,
  SIZE_MULTS,
  STEP_PTS,
  UNDERLYING,
  applyFilledAction,
  applyHedgeClose,
  applyHedgeOpen,
  applySizeToEmptySlots,
  avgFill,
  bothSidePositionActive,
  bookLevelA,
  bookLevelB,
  capLots,
  clearBothSideSession,
  closestTo100,
  closeAllHedges,
  ensureExtraSlot,
  HEDGE_HIGH,
  HEDGE_LOW,
  hardSlPrice,
  hedgeLotsForWindow,
  hedgeWindowForLeg,
  idleEngineState,
  isEod,
  isEntryWindow,
  isHardSlReason,
  isInTrade,
  istCalendarDay,
  istMinuteOfDay,
  labelForKey,
  loadBothSideSession,
  localNewDayReset,
  manualStrikeLabel,
  netRealized,
  nextSquareAllAction,
  openLots,
  openMtm,
  persistBothSideSize,
  pickCheapHedge,
  pickManualStrike,
  pickNear100,
  planTick,
  plannedBook,
  plannedEntry,
  qtyForLots,
  resolveManualStrike,
  saveBothSideSession,
  t1CoverPrice,
  uiReset,
  visibleSlots,
  type BothSideAction,
  type BothSideEngineState,
  type ChainPremiumRow,
  type EntryMode,
  type HuntPick,
  type ManualStrikeOffset,
  type OpenDriveBias,
  type OptionType,
  type SizeMult,
} from "@/lib/niftySnakeBothSideRules";

const RECONCILE_MS = 12000;
const BROKER_CONFIRM_HITS = 2;
const DRIVE_POLL_MS = 15000;

type BsLog = { id: number; ts: number; text: string; kind: "info" | "entry" | "exit" | "warn" };

type DriveState = {
  ready: boolean;
  closed: boolean;
  open: number | null;
  close: number | null;
  bias: OpenDriveBias | null;
  suggest: OptionType | null;
  error: string | null;
};

type DriveApi = {
  ok?: boolean;
  error?: string;
  ready?: boolean;
  closed?: boolean;
  open?: number;
  close?: number;
  bias?: OpenDriveBias | null;
  suggest?: OptionType | null;
};

function isNiftyChain(chain: ChainResolved): boolean {
  return String(chain.index || "").trim().toUpperCase() === UNDERLYING;
}

function resolveIid(chain: ChainResolved, strike: number, optionType: OptionType): number | null {
  const row = chain.instrumentMap[String(strike)];
  const iid = optionType === "CE" ? row?.ce : row?.pe;
  return typeof iid === "number" && iid > 0 ? iid : null;
}

function liveTapePx(instrumentId: number | null | undefined, ltps: Record<number, number>): number | null {
  return liveTapeLtp(instrumentId, ltps);
}

function chainPremiumRows(chain: ChainResolved, ltps: Record<number, number>): ChainPremiumRow[] {
  const out: ChainPremiumRow[] = [];
  for (const [k, inst] of Object.entries(chain.instrumentMap || {})) {
    const strike = Number(k);
    if (!Number.isFinite(strike) || strike <= 0) continue;
    const ce = typeof inst?.ce === "number" && inst.ce > 0 ? inst.ce : null;
    const pe = typeof inst?.pe === "number" && inst.pe > 0 ? inst.pe : null;
    out.push({
      strike,
      call_ltp: liveTapePx(ce, ltps),
      put_ltp: liveTapePx(pe, ltps),
    });
  }
  return out;
}

function extractPosList(raw: unknown): Record<string, unknown>[] {
  const obj = (raw as { raw?: unknown })?.raw ?? raw;
  const res = (obj as { result?: unknown; Result?: unknown })?.result
    ?? (obj as { Result?: unknown })?.Result
    ?? obj;
  const lst = (res as { positionList?: unknown; PositionList?: unknown; positions?: unknown })?.positionList
    ?? (res as { PositionList?: unknown })?.PositionList
    ?? (res as { positions?: unknown })?.positions
    ?? res;
  return Array.isArray(lst) ? (lst as Record<string, unknown>[]) : [];
}

function num(v: unknown): number | null {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string") {
    const n = Number(v.replace(/,/g, "").trim());
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

function positionNetQty(row: Record<string, unknown>): number {
  const qtyRaw =
    num(row.NetPosition ?? row.netPosition ?? row.Quantity ?? row.quantity) ??
    ((num(row.LongPosition) ?? 0) - (num(row.ShortPosition) ?? 0));
  const obq = num(row.OpenBuyQuantity ?? row.openBuyQuantity) ?? 0;
  const osq = num(row.OpenSellQuantity ?? row.openSellQuantity) ?? 0;
  const q = qtyRaw != null && qtyRaw !== 0 ? qtyRaw : obq - osq;
  return Number.isFinite(q) ? q : 0;
}

function positionIid(row: Record<string, unknown>): number | null {
  return num(row.ExchangeInstrumentID ?? row.ExchangeInstrumentId ?? row.exchangeInstrumentID);
}

function windowLabel(nowMs: number): string {
  const m = istMinuteOfDay(nowMs);
  if (m < ENTRY_MINUTE) return "Wait 09:16 IST";
  if (m >= EOD_MINUTE) return "EOD 15:15 — no new snake-both-side";
  return `Hunt ${BAND_LOW}–${BAND_HIGH}`;
}

export default function NiftySnakeBothSidePanel({ chain }: { chain: ChainResolved }) {
  const ltps = useLiveLtp();
  const nifty = isNiftyChain(chain);
  const seg = chain.optionSegment;
  const spotSeg = chain.spotSegment;
  const spotToken = chain.spotToken;

  const restoredRef = useRef(loadBothSideSession());
  const restored = restoredRef.current;

  const [engine, setEngine] = useState<BothSideEngineState>(() => {
    if (!restored?.engine) return idleEngineState("CE");
    const e = restored.engine;
    return {
      ...idleEngineState(e.optionType, e.sizeMult, e.entryMode ?? "auto", e.manualStrikeOffset ?? 0),
      ...e,
      entryMode: e.entryMode === "manual" ? "manual" : "auto",
      manualStrikeOffset: MANUAL_STRIKE_OFFSETS.includes(e.manualStrikeOffset)
        ? e.manualStrikeOffset
        : 0,
      slots: e.slots.map((s) => ({ ...s })),
      hedges: e.hedges.map((h) => ({ ...h })),
      resellLegs: [...e.resellLegs],
    };
  });
  const [iid, setIid] = useState<number | null>(() => restored?.iid ?? null);
  const [logs, setLogs] = useState<BsLog[]>(() => restored?.logs ?? []);
  const [busy, setBusy] = useState(false);
  const [clockMs, setClockMs] = useState(() => Date.now());
  const [targetText, setTargetText] = useState("");
  const [targetLocked, setTargetLocked] = useState(false);
  const [trailText, setTrailText] = useState("");
  const [trailLocked, setTrailLocked] = useState(false);
  const [strikeMenuOpen, setStrikeMenuOpen] = useState(false);
  const strikeMenuRef = useRef<HTMLDivElement | null>(null);
  const [drive, setDrive] = useState<DriveState>({
    ready: false,
    closed: false,
    open: null,
    close: null,
    bias: null,
    suggest: null,
    error: null,
  });

  const engineRef = useRef(engine);
  const iidRef = useRef<number | null>(iid);
  const ltpsRef = useRef(ltps);
  const chainRef = useRef(chain);
  const niftyRef = useRef(nifty);
  const busyRef = useRef(false);
  const logIdRef = useRef(restored?.nextLogId ?? 1);
  const logsRef = useRef<BsLog[]>(logs);
  const sessionDayRef = useRef(istCalendarDay());
  const lastReconcileRef = useRef(0);
  const seenBrokerShortRef = useRef(
    Boolean(restored?.engine && isInTrade(restored.engine.slots, restored.engine.t1Fill)),
  );
  const brokerCaughtUpRef = useRef(false);
  const brokerFlatHitsRef = useRef(0);
  const squareAllReqRef = useRef(false);
  const targetPxRef = useRef<number | null>(null);
  const targetLockedRef = useRef(false);
  const targetHitRef = useRef(false);
  const trailPxRef = useRef<number | null>(null);
  const trailLockedRef = useRef(false);
  const trailHitRef = useRef(false);
  const dropSessionRef = useRef(false);
  const restoreNoteRef = useRef(Boolean(restored && bothSidePositionActive(restored.engine)));

  engineRef.current = engine;
  iidRef.current = iid;
  ltpsRef.current = ltps;
  chainRef.current = chain;
  niftyRef.current = nifty;
  logsRef.current = logs;

  const inTrade = isInTrade(engine.slots, engine.t1Fill);
  const overlayIidRef = useRef<number | null>(null);

  useEffect(() => {
    const lots = openLots(engine.slots);
    const avg = avgFill(engine.slots) ?? engine.t1Fill;
    if (inTrade && iid != null && lots > 0 && avg != null && avg > 0) {
      overlayIidRef.current = iid;
      const exp = String(chain.expiryApi || "").trim();
      const sym =
        engine.strike != null
          ? `${UNDERLYING}${exp ? ` ${exp}` : ""} ${engine.strike} ${engine.optionType}`
          : undefined;
      setLocalShortPosition({
        exchangeInstrumentID: iid,
        exchangeSegment: chain.optionSegment,
        qty: qtyForLots(lots),
        fillPx: avg,
        tradingSymbol: sym,
      });
      return;
    }
    if (overlayIidRef.current != null && !inTrade) {
      clearLocalPosition(overlayIidRef.current);
      overlayIidRef.current = null;
    }
  }, [
    inTrade,
    iid,
    engine.slots,
    engine.t1Fill,
    engine.strike,
    engine.optionType,
    chain.optionSegment,
    chain.expiryApi,
  ]);

  const liveLtp = liveTapePx(iid, ltps);

  const watchIids = useMemo(() => {
    const ids: number[] = [];
    if (iid) ids.push(iid);
    for (const h of engine.hedges) {
      if (h.iid) ids.push(h.iid);
    }
    for (const inst of Object.values(chain.instrumentMap || {})) {
      if (typeof inst?.ce === "number" && inst.ce > 0) ids.push(inst.ce);
      if (typeof inst?.pe === "number" && inst.pe > 0) ids.push(inst.pe);
    }
    return Array.from(new Set(ids));
  }, [chain.instrumentMap, iid, engine.hedges]);

  useSubscribeTouchline(seg, watchIids);
  useSubscribeTouchline(spotSeg, [spotToken]);

  const persistNow = useCallback((st: BothSideEngineState) => {
    if (dropSessionRef.current) {
      clearBothSideSession();
      return;
    }
    const cur = engineRef.current;
    if (!bothSidePositionActive(cur) || !bothSidePositionActive(st)) {
      clearBothSideSession();
      return;
    }
    saveBothSideSession({
      v: 1,
      day: istCalendarDay(),
      iid: iidRef.current,
      engine: cur,
      logs: logsRef.current,
      nextLogId: logIdRef.current,
    });
  }, []);

  const sync = useCallback((next?: BothSideEngineState) => {
    const st = next ?? engineRef.current;
    engineRef.current = st;
    setEngine({
      ...st,
      slots: st.slots.map((s) => ({ ...s })),
      hedges: st.hedges.map((h) => ({ ...h })),
      resellLegs: [...st.resellLegs],
    });
    setIid(iidRef.current);
    persistNow(st);
  }, [persistNow]);

  const pushLog = useCallback((text: string, kind: BsLog["kind"] = "info") => {
    const id = logIdRef.current++;
    setLogs((prev) => {
      const next = [{ id, ts: Date.now(), text, kind }, ...prev].slice(0, 80);
      logsRef.current = next;
      persistNow(engineRef.current);
      return next;
    });
  }, [persistNow]);

  const placeOrder = useCallback(async (side: "BUY" | "SELL", instrumentId: number, lots: number) => {
    const oq = qtyForLots(lots);
    const tick = peekLiveTick(instrumentId);
    const ltp =
      tick?.ltp && tick.ltp > 0
        ? tick.ltp
        : typeof ltpsRef.current[instrumentId] === "number" && ltpsRef.current[instrumentId]! > 0
          ? ltpsRef.current[instrumentId]!
          : null;
    const r = (await apiFetch("/api/ix/place_order", {
      method: "POST",
      body: JSON.stringify({
        ...XTS_IX_ORDER_BASE,
        ...ladderOrderPricing(side, ltp, tick?.bid, tick?.ask),
        exchangeSegment: chainRef.current.optionSegment,
        exchangeInstrumentID: instrumentId,
        orderSide: side,
        orderQuantity: oq,
      }),
    })) as { ok?: boolean; error?: string; raw?: unknown; fillHint?: { ltp?: number; bid?: number; ask?: number } };
    const rejected = ixOrderRejectedMessage(r?.raw) || ixOrderRejectedMessage(r);
    if (rejected) throw new Error(rejected);
    bumpPositionsRefresh();
    const hintLtp =
      typeof r?.fillHint?.ltp === "number" && r.fillHint.ltp > 0 ? r.fillHint.ltp : ltp;
    const hintBid =
      typeof r?.fillHint?.bid === "number" && r.fillHint.bid > 0 ? r.fillHint.bid : tick?.bid ?? null;
    const hintAsk =
      typeof r?.fillHint?.ask === "number" && r.fillHint.ask > 0 ? r.fillHint.ask : tick?.ask ?? null;
    return { ltp: hintLtp, bid: hintBid, ask: hintAsk, raw: r?.raw };
  }, []);

  const maybeOpenHedge = useCallback(
    async (arm: "T1" | "A" | "B", index: number) => {
      if (!ENABLE_HEDGES) return;
      const win = hedgeWindowForLeg(arm, index);
      if (!win) return;
      const st = engineRef.current;
      if (st.hedges.some((h) => h.window === win && h.open)) return;
      const rows = chainPremiumRows(chainRef.current, ltpsRef.current);
      const pick = pickCheapHedge(rows, st.optionType, st.strike);
      if (!pick) {
        pushLog(`Hedge ${win} skipped — no ${HEDGE_LOW}–${HEDGE_HIGH} ₹ print`, "warn");
        return;
      }
      const instrumentId = resolveIid(chainRef.current, pick.strike, pick.optionType);
      if (!instrumentId) return;
      const lotsRow = st.hedges.find((h) => h.window === win);
      const lots = lotsRow?.lots || hedgeLotsForWindow(win, st.sizeMult);
      try {
        const hint = await placeOrder("BUY", instrumentId, lots);
        const fill =
          expectedLadderFill("BUY", hint.ltp, hint.bid, hint.ask) ||
          xtsOrderFillPx(hint.raw) ||
          pick.ltp;
        const next = applyHedgeOpen(engineRef.current, win, pick.strike, instrumentId, fill);
        engineRef.current = next;
        sync(next);
        pushLog(
          `HEDGE ${win} BUY ${pick.strike} ${pick.optionType} × ${lots} lots @ ${fmtPrice(fill)}`,
          "entry",
        );
      } catch (e: unknown) {
        const msg = e instanceof Error ? e.message : String(e);
        pushLog(`Hedge ${win} failed: ${msg}`, "warn");
      }
    },
    [placeOrder, pushLog, sync],
  );

  const flattenHedges = useCallback(
    async (reason: string) => {
      if (!ENABLE_HEDGES) return;
      const open = engineRef.current.hedges.filter((h) => h.open && h.iid);
      for (const h of open) {
        if (!h.iid) continue;
        try {
          const hint = await placeOrder("SELL", h.iid, h.lots);
          const fill =
            expectedLadderFill("SELL", hint.ltp, hint.bid, hint.ask) ||
            xtsOrderFillPx(hint.raw) ||
            liveTapePx(h.iid, ltpsRef.current) ||
            h.fill ||
            0;
          const next = applyHedgeClose(engineRef.current, h.window, fill > 0 ? fill : h.fill ?? 0);
          engineRef.current = next;
          sync(next);
          pushLog(`HEDGE ${h.window} SELL @ ${fmtPrice(fill)} · ${reason}`, "exit");
        } catch (e: unknown) {
          const msg = e instanceof Error ? e.message : String(e);
          pushLog(`Hedge close ${h.window} failed: ${msg}`, "warn");
        }
      }
    },
    [placeOrder, pushLog, sync],
  );

  const huntFromLive = useCallback((): HuntPick | null => {
    const st = engineRef.current;
    if (isInTrade(st.slots, st.t1Fill) || st.awaitResell) return null;
    const ch = chainRef.current;
    const rows = chainPremiumRows(ch, ltpsRef.current);
    if (st.entryMode === "manual") {
      const spotPx = liveTapePx(ch.spotToken, ltpsRef.current) ?? undefined;
      const atm = liveAtmStrikeForChain(ch, spotPx);
      const step = Number(ch.step) || 50;
      const pick = pickManualStrike(rows, st.optionType, atm, step, st.manualStrikeOffset);
      if (!pick) return null;
      const instrumentId = resolveIid(ch, pick.strike, pick.optionType);
      if (!instrumentId) return null;
      const live = liveTapePx(instrumentId, ltpsRef.current);
      if (live != null) return { ...pick, ltp: live };
      return pick;
    }
    const pick = pickNear100(rows, st.optionType);
    if (!pick) return null;
    const instrumentId = resolveIid(ch, pick.strike, pick.optionType);
    if (!instrumentId) return null;
    const live = liveTapePx(instrumentId, ltpsRef.current);
    if (live != null && (live < BAND_LOW || live > BAND_HIGH)) return null;
    if (live != null) return { ...pick, ltp: live };
    return pick;
  }, []);

  const fetchFreshPositions = useCallback(async (): Promise<Record<string, unknown>[] | null> => {
    const r = (await fetchIxPositions("NetWise", { bypassCache: true, skipOverlay: true })) as { stale?: boolean };
    if (r?.stale) return null;
    return extractPosList(r);
  }, []);

  const executeAction = useCallback(
    async (action: BothSideAction): Promise<boolean> => {
      const st = engineRef.current;
      if (action.kind === "stop") {
        await flattenHedges(action.reason);
        const next = applyFilledAction(st, action, 0);
        engineRef.current = next;
        if (!next.awaitResell && !isInTrade(next.slots, next.t1Fill)) {
          iidRef.current = null;
        }
        sync(next);
        pushLog(action.reason, "warn");
        return true;
      }
      if (action.kind === "enter_t1") {
        if (isInTrade(engineRef.current.slots, engineRef.current.t1Fill)) return true;
        const instrumentId = resolveIid(chainRef.current, action.pick.strike, action.pick.optionType);
        if (!instrumentId) {
          pushLog(`No instrument for ${action.pick.strike} ${action.pick.optionType}`, "warn");
          return false;
        }
        const t1 = st.slots.find((s) => s.key === "T1");
        const lots = t1?.lots ?? 8;
        lastReconcileRef.current = Date.now();
        const hint = await placeOrder("SELL", instrumentId, lots);
        const marketPx = expectedLadderFill("SELL", hint.ltp, hint.bid, hint.ask);
        const fill =
          marketPx ||
          xtsOrderFillPx(hint.raw) ||
          action.pick.ltp;
        iidRef.current = instrumentId;
        lastReconcileRef.current = 0;
        seenBrokerShortRef.current = false;
        brokerCaughtUpRef.current = false;
        brokerFlatHitsRef.current = 0;
        const next = applyFilledAction(engineRef.current, action, fill);
        engineRef.current = next;
        sync(next);
        const sl = hardSlPrice(next.slots, fill);
        pushLog(
          `ENTRY T1 SELL ${action.pick.strike} ${action.pick.optionType} × ${lots} lots / ${qtyForLots(lots)} qty @ ${fmtPrice(fill)} — cover ${fmtPrice(t1CoverPrice(fill))} · hard SL ${fmtPrice(sl)} · T-A/T-B gap ₹${STEP_PTS}`,
          "entry",
        );
        toast({
          title: `Snake Both Side T1 ${action.pick.optionType}`,
          description: `${action.pick.strike} @ ${fmtPrice(fill)} · ${lots} lots · snake both-way grid`,
        });
        await maybeOpenHedge("T1", 0);
        return true;
      }

      const instrumentId = iidRef.current;
      if (!instrumentId) {
        pushLog("Locked contract missing — cannot add/book", "warn");
        return false;
      }

      if (action.kind === "add" || action.kind === "resell") {
        const key = action.key;
        let working = engineRef.current.slots;
        if (action.kind === "add") {
          working = ensureExtraSlot(working, action.arm, action.index, engineRef.current.sizeMult);
          if (working !== engineRef.current.slots) {
            engineRef.current = { ...engineRef.current, slots: working };
          }
        }
        const slot = working.find((s) => s.key === key);
        if (slot?.open) return true;
        if (action.kind === "resell") {
          seenBrokerShortRef.current = false;
          brokerCaughtUpRef.current = false;
          brokerFlatHitsRef.current = 0;
        }
        lastReconcileRef.current = Date.now();
        const hint = await placeOrder("SELL", instrumentId, action.lots);
        const live = liveTapePx(instrumentId, ltpsRef.current);
        const fill =
          expectedLadderFill("SELL", hint.ltp, hint.bid, hint.ask) ||
          xtsOrderFillPx(hint.raw) ||
          live ||
          (st.t1Fill != null && action.kind === "add"
            ? plannedEntry(st.t1Fill, action.arm, action.index)
            : 0);
        if (!(fill > 0)) {
          pushLog(`${action.kind === "resell" ? "RESELL" : "ADD"} ${labelForKey(key)} skipped — no price`, "warn");
          return false;
        }
        const next = applyFilledAction(engineRef.current, action, fill);
        engineRef.current = next;
        sync(next);
        pushLog(
          action.kind === "resell"
            ? `RESELL ${labelForKey(key)} SELL × ${action.lots} lots @ ${fmtPrice(fill)} — grid from new fills`
            : `ADD ${labelForKey(key)} SELL × ${action.lots} lots @ ${fmtPrice(fill)} (lvl ${fmtPrice(
                st.t1Fill != null && action.kind === "add"
                  ? plannedEntry(st.t1Fill, action.arm, action.index)
                  : fill,
              )})`,
          "entry",
        );
        if (action.kind === "add") {
          await maybeOpenHedge(action.arm, action.index);
        }
        return true;
      }

      const slot = engineRef.current.slots.find((s) => s.key === action.key);
      if (!slot?.open) return true;
      lastReconcileRef.current = Date.now();
      const hint = await placeOrder("BUY", instrumentId, action.lots);
      const fill =
        expectedLadderFill("BUY", hint.ltp, hint.bid, hint.ask) ||
        xtsOrderFillPx(hint.raw) ||
        (st.t1Fill != null ? st.t1Fill : 0);
      const next = applyFilledAction(engineRef.current, action, fill);
      engineRef.current = next;
      const shortStill =
        isInTrade(next.slots, next.t1Fill) || next.awaitResell || next.slFlattening;
      if (!shortStill) {
        await flattenHedges(action.reason);
        if (overlayIidRef.current != null) {
          clearLocalPosition(overlayIidRef.current);
          overlayIidRef.current = null;
        }
        if (!next.awaitResell) iidRef.current = null;
        seenBrokerShortRef.current = false;
        brokerCaughtUpRef.current = false;
        brokerFlatHitsRef.current = 0;
      } else if (action.key === "T1" || isHardSlReason(action.reason)) {
        await flattenHedges(action.reason);
      }
      sync(engineRef.current);
      pushLog(
        `BOOK ${labelForKey(action.key)} BUY × ${action.lots} lots @ ${fmtPrice(fill)} · ${action.reason}`,
        "exit",
      );
      if (action.key === "T1" && !isHardSlReason(action.reason)) {
        toast({ title: "Snake Both Side book flat", description: action.reason });
      }
      return true;
    },
    [flattenHedges, maybeOpenHedge, placeOrder, pushLog, sync],
  );

  const reconcileNow = useCallback(async () => {
    const st = engineRef.current;
    if (!isInTrade(st.slots, st.t1Fill) || st.slFlattening || st.awaitResell) return;
    try {
      const list = await fetchFreshPositions();
      if (!list) return;
      const locked = iidRef.current;
      const row = locked ? list.find((p) => positionIid(p) === locked) : undefined;
      const net = row ? positionNetQty(row) : 0;
      const brokerShortLots = net < 0 ? Math.round(Math.abs(net) / LOT_SIZE) : 0;
      const uiLots = openLots(engineRef.current.slots);
      if (brokerShortLots >= uiLots && uiLots > 0) {
        seenBrokerShortRef.current = true;
        brokerCaughtUpRef.current = true;
        brokerFlatHitsRef.current = 0;
        return;
      }
      if (brokerShortLots <= 0) {
        if (!seenBrokerShortRef.current) return;
        brokerFlatHitsRef.current += 1;
        if (brokerFlatHitsRef.current < BROKER_CONFIRM_HITS) return;
        const flatIid = iidRef.current ?? overlayIidRef.current;
        if (flatIid != null) clearLocalPosition(flatIid);
        for (const h of engineRef.current.hedges) {
          if (h.iid) clearLocalPosition(h.iid);
        }
        overlayIidRef.current = null;
        iidRef.current = null;
        seenBrokerShortRef.current = false;
        brokerCaughtUpRef.current = false;
        brokerFlatHitsRef.current = 0;
        dropSessionRef.current = true;
        clearBothSideSession();
        const flat: BothSideEngineState = {
          ...idleEngineState(
            engineRef.current.optionType,
            engineRef.current.sizeMult,
            engineRef.current.entryMode,
            engineRef.current.manualStrikeOffset,
          ),
          awaitRestart: true,
        };
        engineRef.current = flat;
        sync(flat);
        clearBothSideSession();
        pushLog("Broker square-off — session + position book cleared. START AGAIN to hunt.", "warn");
      }
    } catch {
      /* ignore */
    }
  }, [fetchFreshPositions, pushLog, sync]);

  const runCycleRef = useRef<() => Promise<void>>(async () => {});

  const runCycle = useCallback(async () => {
    if (busyRef.current) return;
    busyRef.current = true;
    let uiBusy = false;
    try {
      const nowMs = Date.now();
      const day = istCalendarDay(nowMs);
      if (day !== sessionDayRef.current) {
        sessionDayRef.current = day;
        const st = engineRef.current;
        if (bothSidePositionActive(st)) {
          iidRef.current = null;
          seenBrokerShortRef.current = false;
          brokerCaughtUpRef.current = false;
          brokerFlatHitsRef.current = 0;
          const next = localNewDayReset(st);
          engineRef.current = next;
          logsRef.current = [];
          logIdRef.current = 1;
          setLogs([]);
          sync(next);
          pushLog("New IST day — Snake Both Side reset. Square leftover broker qty manually if still open.", "warn");
        }
      }

      if (!niftyRef.current) return;

      const stNow = engineRef.current;
      const tradingNow = isInTrade(stNow.slots, stNow.t1Fill);
      if (tradingNow && !stNow.slFlattening && Date.now() - lastReconcileRef.current >= RECONCILE_MS) {
        lastReconcileRef.current = Date.now();
        await reconcileNow();
      }

      if (trailLockedRef.current && trailPxRef.current != null) {
        const live = liveTapePx(iidRef.current, ltpsRef.current);
        const st = engineRef.current;
        const trading = isInTrade(st.slots, st.t1Fill);
        if ((trading || st.awaitResell) && live != null && live >= trailPxRef.current - 1e-9) {
          const paused: BothSideEngineState = { ...st, armed: false };
          engineRef.current = paused;
          sync(paused);
          pushLog(
            `TRAIL SL ${fmtPrice(trailPxRef.current)} hit — SQUARE ALL + PAUSE`,
            "warn",
          );
          toast({
            title: "Snake Both Side TRAIL SL",
            description: `LTP ${fmtPrice(live)} ≥ ${fmtPrice(trailPxRef.current)}. Squaring and pausing.`,
          });
          if (trading) {
            trailHitRef.current = true;
            squareAllReqRef.current = true;
          } else {
            const stopped = applyFilledAction(paused, { kind: "stop", reason: "TRAIL SL" }, 0);
            engineRef.current = closeAllHedges(stopped, live);
            iidRef.current = null;
            dropSessionRef.current = true;
            sync(engineRef.current);
            clearBothSideSession();
          }
        }
      }

      if (targetLockedRef.current && targetPxRef.current != null) {
        const live = liveTapePx(iidRef.current, ltpsRef.current);
        const st = engineRef.current;
        const trading = isInTrade(st.slots, st.t1Fill);
        if ((trading || st.awaitResell) && live != null && live <= targetPxRef.current + 1e-9) {
          const paused: BothSideEngineState = { ...st, armed: false };
          engineRef.current = paused;
          sync(paused);
          pushLog(
            `TARGET ${fmtPrice(targetPxRef.current)} hit — book ${st.strike ?? "strike"} and PAUSE`,
            "warn",
          );
          toast({
            title: "Snake Both Side target hit",
            description: `LTP ${fmtPrice(live)} ≤ ${fmtPrice(targetPxRef.current)}. Booking and pausing.`,
          });
          if (trading) {
            targetHitRef.current = true;
            squareAllReqRef.current = true;
          } else {
            const stopped = applyFilledAction(paused, { kind: "stop", reason: "TARGET" }, 0);
            engineRef.current = stopped;
            iidRef.current = null;
            dropSessionRef.current = true;
            sync(stopped);
            clearBothSideSession();
          }
        }
      }

      if (squareAllReqRef.current) {
        const fromTarget = targetHitRef.current;
        const fromTrail = trailHitRef.current;
        targetHitRef.current = false;
        trailHitRef.current = false;
        squareAllReqRef.current = false;
        uiBusy = true;
        setBusy(true);
        if (isInTrade(engineRef.current.slots, engineRef.current.t1Fill)) {
          pushLog(
            fromTrail
              ? "TRAIL SL — covering highest-open first"
              : fromTarget
                ? "TARGET — covering highest-open first"
                : "SQUARE ALL — covering highest-open first",
            "warn",
          );
          for (let i = 0; i < MAX_PLAN_TICKS; i++) {
            const action = nextSquareAllAction(engineRef.current.slots);
            if (!action) break;
            const ok = await executeAction(action);
            if (!ok) break;
          }
        }
        await flattenHedges(fromTrail ? "TRAIL SL" : fromTarget ? "TARGET" : "SQUARE ALL");
        const after = engineRef.current;
        if (after.awaitResell || after.resellLegs.length) {
          const stopped = applyFilledAction(after, { kind: "stop", reason: "SQUARE ALL" }, 0);
          engineRef.current = stopped;
          iidRef.current = null;
          sync(stopped);
        }
        if ((fromTarget || fromTrail) && !isInTrade(engineRef.current.slots, engineRef.current.t1Fill)) {
          dropSessionRef.current = true;
          clearBothSideSession();
          pushLog(fromTrail ? "Trail SL — session cleared" : "Target book — session cleared", "info");
        }
        return;
      }

      let hardSlBurst = false;
      for (let i = 0; i < MAX_PLAN_TICKS; i++) {
        if (squareAllReqRef.current) break;
        const st = engineRef.current;
        let locked = iidRef.current;
        if (
          !locked &&
          st.strike != null &&
          (st.awaitResell || st.slFlattening || isInTrade(st.slots, st.t1Fill))
        ) {
          locked = resolveIid(chainRef.current, st.strike, st.optionType);
          if (locked) {
            iidRef.current = locked;
            setIid(locked);
          }
        }
        const ltp = liveTapePx(locked, ltpsRef.current);
        const action = planTick({
          nowMs: Date.now(),
          armed: st.armed,
          awaitRestart: st.awaitRestart,
          awaitResell: st.awaitResell,
          resellLegs: st.resellLegs,
          hardSlPx: st.hardSlPx,
          t1Fill: st.t1Fill,
          slots: st.slots,
          ltp,
          huntPick: huntFromLive(),
          sizeMult: st.sizeMult,
          entryMode: st.entryMode,
          suppressAdds: hardSlBurst,
        });
        if (!action) break;
        if (action.kind === "book" && isHardSlReason(action.reason)) hardSlBurst = true;
        if (!uiBusy) {
          uiBusy = true;
          setBusy(true);
        }
        const ok = await executeAction(action);
        if (!ok) break;
      }
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      pushLog(`Order failed: ${msg}`, "warn");
      toast({ title: "Nifty Snake Both Side order failed", description: msg, variant: "destructive" });
    } finally {
      busyRef.current = false;
      if (uiBusy) setBusy(false);
    }
  }, [executeAction, flattenHedges, huntFromLive, pushLog, reconcileNow, sync]);

  runCycleRef.current = runCycle;

  useEffect(() => {
    const onFlat = () => {
      const next: BothSideEngineState = { ...engineRef.current, armed: false };
      engineRef.current = next;
      sync(next);
      if (isInTrade(next.slots, next.t1Fill)) {
        squareAllReqRef.current = true;
        pushLog("MTM TARGET/SL — SQUARE ALL + hunt paused", "warn");
      } else {
        pushLog("MTM TARGET/SL — hunt paused", "warn");
      }
      void runCycleRef.current();
    };
    const onPosRefresh = () => {
      if (busyRef.current) return;
      void reconcileNow();
    };
    window.addEventListener(EV_NIFTY_BOTHSIDE_FLAT, onFlat);
    window.addEventListener(POSITIONS_REFRESH_EVENT, onPosRefresh);
    return () => {
      window.removeEventListener(EV_NIFTY_BOTHSIDE_FLAT, onFlat);
      window.removeEventListener(POSITIONS_REFRESH_EVENT, onPosRefresh);
    };
  }, [pushLog, reconcileNow, sync]);

  useEffect(() => {
    const id = window.setInterval(() => {
      void runCycleRef.current();
      setClockMs(Date.now());
    }, BOTHSIDE_CLOCK_MS);
    return () => window.clearInterval(id);
  }, []);

  useEffect(() => {
    const st = engineRef.current;
    if (iidRef.current || st.strike == null) return;
    if (!st.awaitResell && !st.slFlattening && !isInTrade(st.slots, st.t1Fill)) return;
    const resolvedIid = resolveIid(chain, st.strike, st.optionType);
    if (!resolvedIid) return;
    iidRef.current = resolvedIid;
    setIid(resolvedIid);
    persistNow(st);
  }, [chain, persistNow, engine.awaitResell, engine.slFlattening, engine.strike, engine.t1Fill]);

  useEffect(() => {
    if (!restoreNoteRef.current) return;
    restoreNoteRef.current = false;
    const snap = restoredRef.current;
    if (!snap || !bothSidePositionActive(snap.engine)) return;
    const trading = isInTrade(snap.engine.slots, snap.engine.t1Fill);
    const label = trading && snap.engine.strike != null
      ? `Reload restore — ${snap.engine.strike.toLocaleString("en-IN")} ${snap.engine.optionType} still live`
      : snap.engine.awaitResell
        ? `Reload restore — waiting to re-SELL below hard SL ${fmtPrice(snap.engine.hardSlPx)}`
        : "Reload restore — still armed, hunting 70–75";
    pushLog(label, "info");
  }, [pushLog]);

  const refreshDrive = useCallback(async () => {
    if (!niftyRef.current) return;
    try {
      const liveSpot = ltpsRef.current[spotToken];
      const r = (await apiFetch("/api/md/nifty_ladder/open_drive", {
        method: "POST",
        body: JSON.stringify({
          exchangeSegment: spotSeg,
          exchangeInstrumentID: spotToken,
          liveLtp: typeof liveSpot === "number" ? liveSpot : 0,
        }),
      })) as DriveApi;
      if (!r?.ok) {
        setDrive((d) => ({ ...d, error: r?.error || "Open drive fetch failed" }));
        return;
      }
      setDrive({
        ready: Boolean(r.ready),
        closed: Boolean(r.closed),
        open: typeof r.open === "number" ? r.open : null,
        close: typeof r.close === "number" ? r.close : null,
        bias: r.bias ?? null,
        suggest: r.suggest ?? null,
        error: null,
      });
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      setDrive((d) => ({
        ...d,
        error: msg.includes("404") ? "Open-drive API 404 — restart backend" : msg,
      }));
    }
  }, [spotSeg, spotToken]);

  useEffect(() => {
    void refreshDrive();
    const id = window.setInterval(() => void refreshDrive(), DRIVE_POLL_MS);
    return () => window.clearInterval(id);
  }, [refreshDrive]);

  const start = () => {
    if (!nifty) {
      toast({ title: "Nifty Snake Both Side", description: "Switch the index to NIFTY.", variant: "destructive" });
      return;
    }
    const now = Date.now();
    const st = engineRef.current;
    const trading = isInTrade(st.slots, st.t1Fill);
    if (isEod(now) && !trading && !st.awaitResell) {
      toast({ title: "No new snake-both-side today", description: "Past 15:15 IST — wait for next session." });
      pushLog("START rejected — past 15:15 IST", "warn");
      return;
    }
    dropSessionRef.current = false;
    const next: BothSideEngineState = { ...st, armed: true, awaitRestart: false };
    engineRef.current = next;
    sync(next);
    if (trading) {
      pushLog("RESUME — T-A / T-B adds live again. Protective books stay on", "info");
      toast({ title: "Snake Both Side resumed", description: "Adds on ±3 are live again." });
    } else if (st.awaitResell) {
      pushLog("RESUME — re-SELL same legs when LTP is back below hard SL", "info");
      toast({ title: "Snake Both Side re-SELL armed", description: "Same strike, resume from new fills." });
    } else if (st.entryMode === "manual") {
      const label = manualStrikeLabel(st.manualStrikeOffset);
      if (!isEntryWindow(now)) {
        pushLog(`Armed (Manual) — waiting for 09:16 IST, then enter ${label} ${st.optionType}`, "info");
        toast({ title: "Snake Both Side armed", description: `Manual ${label} after 09:16 IST.` });
      } else {
        pushLog(`START Manual — direct entry ${label} ${st.optionType} @ live price (band skipped)`, "info");
        toast({
          title: "Snake Both Side started",
          description: `Manual ${label} ${st.optionType} — no band check.`,
        });
      }
    } else if (!isEntryWindow(now)) {
      pushLog(`Armed — waiting for 09:16 IST, then hunt ${BAND_LOW}–${BAND_HIGH}`, "info");
      toast({ title: "Snake Both Side armed", description: "Entry after 09:16 IST." });
    } else {
      pushLog(`START — hunting ~${BAND_TARGET} premium in ${BAND_LOW}–${BAND_HIGH} · snake both-way grid`, "info");
      toast({
        title: "Nifty Snake Both Side started",
        description: `Hunting ${BAND_LOW}–${BAND_HIGH}. Cap ${capLots(st.sizeMult)} lots.`,
      });
    }
    void runCycleRef.current();
  };

  const pause = () => {
    const next: BothSideEngineState = { ...engineRef.current, armed: false };
    engineRef.current = next;
    sync(next);
    pushLog("PAUSE — no hunt / no adds / no HARD-SL re-SELL. Still book extras, T1 −30%, hard SL flatten, EOD", "info");
    toast({ title: "Snake Both Side paused", description: "Protective exits stay on." });
  };

  const lockTarget = () => {
    const px = Number(targetText.replace(/,/g, "").trim());
    if (!(px > 0)) {
      toast({ title: "Target", description: "Valid price daalo.", variant: "destructive" });
      return;
    }
    targetPxRef.current = px;
    targetLockedRef.current = true;
    setTargetLocked(true);
    setTargetText(px.toFixed(2));
    toast({ title: "Target locked", description: `Book all when LTP ≤ ${fmtPrice(px)}, then pause.` });
  };

  const unlockTarget = () => {
    targetLockedRef.current = false;
    targetPxRef.current = null;
    setTargetLocked(false);
    toast({ title: "Target unlocked" });
  };

  const lockTrail = () => {
    const px = Number(trailText.replace(/,/g, "").trim());
    if (!(px > 0)) {
      toast({ title: "TRAIL SL", description: "Valid price daalo.", variant: "destructive" });
      return;
    }
    trailPxRef.current = px;
    trailLockedRef.current = true;
    setTrailLocked(true);
    setTrailText(px.toFixed(2));
    toast({ title: "TRAIL SL locked", description: `Square all + pause when LTP ≥ ${fmtPrice(px)}.` });
  };

  const unlockTrail = () => {
    trailLockedRef.current = false;
    trailPxRef.current = null;
    setTrailLocked(false);
    toast({ title: "TRAIL SL unlocked" });
  };

  const squareAll = () => {
    const st = engineRef.current;
    if (!isInTrade(st.slots, st.t1Fill) && !st.awaitResell) return;
    squareAllReqRef.current = true;
    void runCycleRef.current();
  };

  const reset = () => {
    const st = engineRef.current;
    if (iid != null) clearLocalPosition(iid);
    for (const h of st.hedges) {
      if (h.iid) clearLocalPosition(h.iid);
    }
    iidRef.current = null;
    seenBrokerShortRef.current = false;
    brokerCaughtUpRef.current = false;
    brokerFlatHitsRef.current = 0;
    const next = uiReset(st);
    engineRef.current = next;
    logsRef.current = [];
    logIdRef.current = 1;
    setLogs([]);
    clearBothSideSession();
    sync(next);
    pushLog("RESET — UI cleared (broker positions untouched)", "info");
  };

  const setSide = (optionType: OptionType) => {
    const st = engineRef.current;
    if (isInTrade(st.slots, st.t1Fill) || st.awaitResell || st.optionType === optionType) return;
    const next = { ...st, optionType };
    engineRef.current = next;
    sync(next);
  };

  const setMult = (sizeMult: SizeMult) => {
    const st = engineRef.current;
    if (isInTrade(st.slots, st.t1Fill) || st.awaitResell || st.sizeMult === sizeMult) return;
    persistBothSideSize(sizeMult);
    const next: BothSideEngineState = {
      ...st,
      sizeMult,
      slots: applySizeToEmptySlots(st.slots, sizeMult),
    };
    engineRef.current = next;
    sync(next);
  };

  const setEntryMode = (entryMode: EntryMode) => {
    const st = engineRef.current;
    if (isInTrade(st.slots, st.t1Fill) || st.awaitResell || st.entryMode === entryMode) return;
    const next: BothSideEngineState = { ...st, entryMode, manualStrikeOffset: 0 };
    engineRef.current = next;
    sync(next);
  };

  const setManualOffset = (manualStrikeOffset: ManualStrikeOffset) => {
    setStrikeMenuOpen(false);
    const st = engineRef.current;
    if (isInTrade(st.slots, st.t1Fill) || st.awaitResell || st.manualStrikeOffset === manualStrikeOffset) return;
    const next: BothSideEngineState = { ...st, manualStrikeOffset };
    engineRef.current = next;
    sync(next);
  };

  useEffect(() => {
    if (!strikeMenuOpen) return;
    const onDoc = (ev: MouseEvent) => {
      const el = strikeMenuRef.current;
      if (el && !el.contains(ev.target as Node)) setStrikeMenuOpen(false);
    };
    const onKey = (ev: KeyboardEvent) => {
      if (ev.key === "Escape") setStrikeMenuOpen(false);
    };
    document.addEventListener("mousedown", onDoc);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDoc);
      document.removeEventListener("keydown", onKey);
    };
  }, [strikeMenuOpen]);

  useEffect(() => {
    if (engine.entryMode !== "manual" || inTrade || engine.awaitResell) setStrikeMenuOpen(false);
  }, [engine.entryMode, inTrade, engine.awaitResell]);

  const rows = useMemo(
    () => chainPremiumRows(chain, ltps),
    [chain, ltps, clockMs],
  );
  const spotPx = liveTapePx(spotToken, ltps) ?? undefined;
  const liveAtm = useMemo(
    () => liveAtmStrikeForChain(chain, spotPx),
    [chain, spotPx, clockMs],
  );
  const chainStep = Number(chain.step) || 50;
  const huntPick =
    !inTrade && !engine.awaitResell
      ? engine.entryMode === "manual"
        ? pickManualStrike(rows, engine.optionType, liveAtm, chainStep, engine.manualStrikeOffset)
        : pickNear100(rows, engine.optionType)
      : null;
  const nearest = closestTo100(rows, engine.optionType);
  const avg = avgFill(engine.slots);
  const lotsOpen = openLots(engine.slots);
  const mtm = openMtm(avg, liveLtp, lotsOpen);
  const gridOn = Boolean((inTrade || engine.awaitResell) && engine.t1Fill != null && engine.t1Fill > 0);
  const gridFill = gridOn ? engine.t1Fill : null;
  const coverPx = gridFill != null ? t1CoverPrice(gridFill) : null;
  const hardSlPx =
    inTrade || engine.awaitResell
      ? engine.hardSlPx ?? hardSlPrice(engine.slots, engine.t1Fill)
      : null;
  const net = netRealized(engine);
  const primaryLabel = engine.awaitRestart ? "START AGAIN" : "START";
  const sideLocked = inTrade || engine.awaitResell;
  const uiSlots = visibleSlots(engine.slots);
  const huntIid = huntPick ? resolveIid(chain, huntPick.strike, huntPick.optionType) : null;
  const huntLive = liveTapePx(huntIid, ltps) ?? huntPick?.ltp ?? null;

  const statusNote = !nifty
    ? "NIFTY only — switch index"
    : engine.awaitResell
      ? "Hard SL flat — re-SELL same legs when LTP < hard SL"
      : engine.awaitRestart && !inTrade
        ? "Booked. START AGAIN to hunt a new 70–75"
        : inTrade && engine.armed
          ? "In trade · T-A up / T-B down · books live"
          : inTrade
            ? "In trade · paused (exits still live)"
            : engine.armed
              ? engine.entryMode === "manual"
                ? `Armed · Manual ${manualStrikeLabel(engine.manualStrikeOffset)} · ${windowLabel(clockMs)}`
                : `Armed · ${windowLabel(clockMs)}`
              : engine.entryMode === "manual"
                ? `Idle · Manual ${manualStrikeLabel(engine.manualStrikeOffset)}`
                : "Idle";

  return (
    <div className="flex flex-1 min-h-0 min-w-0 flex-col overflow-hidden text-[11px] ramsetu-glass-panel">
      <div className="shrink-0 ramsetu-glass-toolbar ns-toolbar">
        <div className="flex flex-wrap items-center gap-2">
          <span className={`ns-chip${engine.armed ? " ns-chip--on" : ""}`}>Armed</span>
          <span className={`ns-chip${engine.awaitResell ? " ns-chip--wait" : ""}`}>Re-SELL</span>
          <span className={`ns-chip${inTrade ? " ns-chip--trade" : ""}`}>In Trade</span>
          <span className="text-muted-foreground font-semibold">{statusNote}</span>
        </div>

        <div className="mt-2 flex flex-wrap items-end gap-3">
          <div className="flex flex-col gap-1">
            <span className="ramsetu-glass-toolbar__label">Side</span>
            <div className="ns-toggle">
              {(["CE", "PE"] as const).map((side) => (
                <button
                  key={side}
                  type="button"
                  disabled={sideLocked}
                  onClick={() => setSide(side)}
                  className={`ns-toggle__btn${engine.optionType === side ? " ns-toggle__btn--on" : ""}${
                    side === "PE" ? " ns-toggle__btn--pe" : ""
                  }`}
                >
                  {side}
                </button>
              ))}
            </div>
          </div>

          <div className="flex flex-col gap-1">
            <span className="ramsetu-glass-toolbar__label">Size</span>
            <div className="ns-toggle">
              {SIZE_MULTS.map((m) => (
                <button
                  key={m}
                  type="button"
                  disabled={sideLocked}
                  onClick={() => setMult(m)}
                  className={`ns-toggle__btn${engine.sizeMult === m ? " ns-toggle__btn--on" : ""}`}
                >
                  {m}x
                </button>
              ))}
            </div>
          </div>

          <div className="flex flex-col gap-1">
            <span className="ramsetu-glass-toolbar__label">Entry</span>
            <div className="ns-toggle">
              {(["auto", "manual"] as const).map((mode) => (
                <button
                  key={mode}
                  type="button"
                  disabled={sideLocked}
                  onClick={() => setEntryMode(mode)}
                  className={`ns-toggle__btn${engine.entryMode === mode ? " ns-toggle__btn--on" : ""}`}
                >
                  {mode === "auto" ? "Auto" : "Manual"}
                </button>
              ))}
            </div>
          </div>

          {engine.entryMode === "manual" && (
            <div className="flex flex-col gap-1" ref={strikeMenuRef}>
              <span className="ramsetu-glass-toolbar__label">Strike</span>
              <div className="nl-strike-dd">
                <button
                  type="button"
                  disabled={sideLocked}
                  className={`nl-strike-dd__trigger${strikeMenuOpen ? " nl-strike-dd__trigger--open" : ""}${
                    engine.optionType === "PE" ? " nl-strike-dd__trigger--pe" : ""
                  }`}
                  onClick={() => setStrikeMenuOpen((o) => !o)}
                  aria-haspopup="listbox"
                  aria-expanded={strikeMenuOpen}
                >
                  <span className="nl-strike-dd__label">{manualStrikeLabel(engine.manualStrikeOffset)}</span>
                  <span className="nl-strike-dd__strike tabular-nums">
                    {resolveManualStrike(liveAtm, chainStep, engine.manualStrikeOffset).toLocaleString("en-IN")}
                  </span>
                  <span className={`nl-strike-dd__side${engine.optionType === "PE" ? " nl-strike-dd__side--pe" : ""}`}>
                    {engine.optionType}
                  </span>
                  <span className="nl-strike-dd__chev" aria-hidden>
                    ▾
                  </span>
                </button>
                {strikeMenuOpen && (
                  <div className="nl-strike-dd__menu" role="listbox">
                    <div className="nl-strike-dd__head">
                      ATM {liveAtm.toLocaleString("en-IN")} · {engine.optionType}
                    </div>
                    {MANUAL_STRIKE_OFFSETS.map((off) => {
                      const strike = resolveManualStrike(liveAtm, chainStep, off);
                      const on = engine.manualStrikeOffset === off;
                      return (
                        <button
                          key={off}
                          type="button"
                          role="option"
                          aria-selected={on}
                          className={`nl-strike-dd__opt${on ? " nl-strike-dd__opt--on" : ""}${
                            off === 0 ? " nl-strike-dd__opt--atm" : ""
                          }`}
                          onClick={() => setManualOffset(off)}
                        >
                          <span className="nl-strike-dd__opt-label">{manualStrikeLabel(off)}</span>
                          <span className="nl-strike-dd__opt-strike tabular-nums">
                            {strike.toLocaleString("en-IN")}
                          </span>
                          <span
                            className={`nl-strike-dd__opt-side${
                              engine.optionType === "PE" ? " nl-strike-dd__opt-side--pe" : ""
                            }`}
                          >
                            {engine.optionType}
                          </span>
                        </button>
                      );
                    })}
                  </div>
                )}
              </div>
            </div>
          )}

          <div className="flex flex-col gap-1 min-w-[88px]">
            <span className="ramsetu-glass-toolbar__label">Window</span>
            <span className="font-semibold tabular-nums text-foreground">{windowLabel(clockMs)}</span>
          </div>

          <div className="ml-auto flex flex-wrap items-center gap-2 pb-0.5">
            <button
              type="button"
              disabled={busy || engine.armed || !nifty}
              onClick={start}
              className={engine.awaitRestart ? "ns-btn-again" : "ramsetu-glass-exec min-w-[88px]"}
            >
              {primaryLabel}
            </button>
            <button
              type="button"
              disabled={busy || !engine.armed}
              onClick={pause}
              className="ramsetu-glass-stop"
            >
              PAUSE
            </button>
            <button
              type="button"
              disabled={busy || (!inTrade && !engine.awaitResell)}
              onClick={squareAll}
              className="ramsetu-glass-stop"
            >
              SQUARE ALL
            </button>
            <button
              type="button"
              disabled={busy}
              onClick={reset}
              className="ns-btn-reset"
              title="Clear Snake Both Side UI only — does not square XTS"
            >
              RESET
            </button>
          </div>
        </div>
      </div>

      <div className="ramsetu-glass-table-wrap flex flex-col gap-3">
        {!nifty && (
          <div className="ramsetu-glass-empty">
            Nifty Snake Both Side trades NIFTY options only. Switch the top index to NIFTY.
          </div>
        )}

        <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
          <button
            type="button"
            disabled={inTrade || engine.awaitResell || !drive.suggest}
            onClick={() => drive.suggest && setSide(drive.suggest)}
            className={`ramsetu-glass-card ramsetu-glass-card--center nl-drive${
              drive.bias === "UP" ? " nl-drive--up" : drive.bias === "DOWN" ? " nl-drive--down" : ""
            }`}
          >
            <div className="ramsetu-glass-card__badge">09:15 DRIVE</div>
            <div className="ramsetu-glass-card__strike tabular-nums">
              {drive.bias ?? (drive.closed ? "—" : "Wait 09:16")}
            </div>
            <div className="ramsetu-glass-card__rule">
              {drive.suggest
                ? `Suggest ${drive.suggest}`
                : drive.bias === "FLAT"
                  ? "FLAT — no auto side"
                  : drive.error || "Hint only · not auto-entry"}
            </div>
            {(drive.open != null || drive.close != null) && (
              <div className="ramsetu-glass-card__rule">
                O {fmtPrice(drive.open)} → C {fmtPrice(drive.close)}
              </div>
            )}
          </button>

          <div className="ramsetu-glass-card ramsetu-glass-card--center">
            <div className="ramsetu-glass-card__badge">
              {engine.entryMode === "manual" ? "MANUAL PICK" : "HUNT"} · {engine.optionType}
            </div>
            <div
              className={`ramsetu-glass-card__strike tabular-nums ${
                engine.optionType === "PE" ? "ramsetu-glass-card__strike--pe" : "text-cd-green"
              }`}
            >
              {engine.strike != null
                ? `${engine.strike.toLocaleString("en-IN")} ${engine.optionType}`
                : huntPick
                  ? `${huntPick.strike.toLocaleString("en-IN")} ${engine.optionType}`
                  : "—"}
            </div>
            <div className="ramsetu-glass-card__rule">
              {inTrade || engine.awaitResell
                ? "Strike locked"
                : engine.entryMode === "manual"
                  ? huntPick
                    ? `LIVE ${fmtPrice(huntLive)} · ${manualStrikeLabel(engine.manualStrikeOffset)} · no band`
                    : `Waiting print · ${manualStrikeLabel(engine.manualStrikeOffset)} ${engine.optionType}`
                  : huntPick
                    ? `LIVE ${fmtPrice(huntLive)} · band ${BAND_LOW}–${BAND_HIGH}`
                    : nearest
                      ? `Nearest ${nearest.strike} @ ${fmtPrice(nearest.ltp)} (outside ${BAND_LOW}–${BAND_HIGH})`
                      : `No print in ${BAND_LOW}–${BAND_HIGH}`}
            </div>
          </div>

          <div className="ramsetu-glass-card ramsetu-glass-card--center">
            <div className="ramsetu-glass-card__badge">T1 FILL · snake both-way GRID</div>
            <div className="ramsetu-glass-card__strike tabular-nums">
              {gridFill != null ? fmtPrice(gridFill) : "—"}
            </div>
            <div className="ramsetu-glass-card__rule">
              {gridFill != null
                ? `Cover ${fmtPrice(coverPx)} · hard SL ${fmtPrice(hardSlPx)} · gap ₹${STEP_PTS}`
                : `Cover −30% · Hard SL +30% from cheapest open fill`}
            </div>
          </div>

          <div className="ramsetu-glass-card ramsetu-glass-card--center">
            <div className="ramsetu-glass-card__badge">LIVE</div>
            <div className="ramsetu-glass-card__strike tabular-nums">{fmtPrice(inTrade || engine.awaitResell ? liveLtp : huntLive)}</div>
            <div
              className={`ramsetu-glass-card__rule ${
                mtm != null && mtm >= 0 ? "text-cd-green" : mtm != null ? "ramsetu-glass-table__strike--pe" : ""
              }`}
            >
              MTM {fmtPnl(mtm ?? 0)} · {lotsOpen}/{capLots(engine.sizeMult)} lots · qty {lotsOpen * LOT_SIZE}
            </div>
            <div className="sow-live-target">
              <span className="sow-live-target__label">Target</span>
              <input
                className="sow-live-target__input"
                inputMode="decimal"
                value={targetText}
                disabled={targetLocked}
                placeholder="0.00"
                onChange={(e) => setTargetText(e.target.value)}
              />
              <button
                type="button"
                className={`sow-live-target__btn${targetLocked ? "" : " sow-live-target__btn--lock"}`}
                disabled={targetLocked}
                onClick={lockTarget}
              >
                Lock
              </button>
              <button type="button" className="sow-live-target__btn" disabled={!targetLocked} onClick={unlockTarget}>
                Unlock
              </button>
            </div>
            <div className="sow-live-target mt-1">
              <span className="sow-live-target__label">Trail SL</span>
              <input
                className="sow-live-target__input"
                inputMode="decimal"
                value={trailText}
                disabled={trailLocked}
                placeholder="0.00"
                onChange={(e) => setTrailText(e.target.value)}
              />
              <button
                type="button"
                className={`sow-live-target__btn${trailLocked ? "" : " sow-live-target__btn--lock"}`}
                disabled={trailLocked}
                onClick={lockTrail}
              >
                Lock
              </button>
              <button type="button" className="sow-live-target__btn" disabled={!trailLocked} onClick={unlockTrail}>
                Unlock
              </button>
            </div>
          </div>
        </div>

        <div className="ramsetu-glass-card ramsetu-glass-card--center">
          <div className="ramsetu-glass-card__badge">REALIZED · CAP {CAP_LOTS_1X}×{engine.sizeMult}</div>
          <div
            className={`ramsetu-glass-card__strike tabular-nums ${
              net > 0 ? "text-cd-green" : net < 0 ? "ramsetu-glass-table__strike--pe" : ""
            }`}
          >
            {fmtPnl(net)}
          </div>
          <div className="ramsetu-glass-card__rule">
            Gross {fmtPnl(engine.gross)} · exp {fmtPnl(engine.expense)} · {engine.roundTrips} lot RT
            {engine.peakLots > 0
              ? ` · peak A${engine.peakA || "—"}/B${engine.peakB || "—"} · ${engine.peakLots} lots`
              : ""}
          </div>
        </div>

        <div className="ns-blocks overflow-auto">
          {uiSlots.map((s) => {
            const addPx =
              s.arm === "T1"
                ? gridFill
                : gridFill != null
                  ? plannedEntry(gridFill, s.arm, s.index)
                  : null;
            const bookPx =
              s.arm === "T1"
                ? coverPx
                : s.open && s.fill != null
                  ? s.arm === "A"
                    ? bookLevelA(s.fill)
                    : bookLevelB(s.fill)
                  : gridFill != null
                    ? plannedBook(gridFill, s.arm, s.index)
                    : null;
            const waitingResell = engine.awaitResell && engine.resellLegs.includes(s.key) && !s.open;
            return (
              <div key={s.key} className={`ns-block${s.open ? " ns-block--open" : ""}`}>
                <div className="ns-block__top">
                  <span className="ns-block__tranche">{labelForKey(s.key)}</span>
                  <span
                    className={
                      s.open
                        ? "ns-block__status ns-block__status--open"
                        : waitingResell
                          ? "ns-block__status ns-block__status--wait"
                          : "ns-block__status"
                    }
                  >
                    {s.open ? "Open" : waitingResell ? "Re-SELL" : "Empty"}
                  </span>
                </div>
                <div className="ns-block__grid">
                  <div className="ns-block__cell">
                    <span className="ns-block__label">Lots</span>
                    <span className="ns-block__num">{s.lots}</span>
                  </div>
                  <div className="ns-block__cell">
                    <span className="ns-block__label">Qty</span>
                    <span className="ns-block__num">{qtyForLots(s.lots)}</span>
                  </div>
                  <div className="ns-block__cell">
                    <span className="ns-block__label">Add</span>
                    <span className="ns-block__num">
                      {s.arm === "T1"
                        ? gridFill != null
                          ? fmtPrice(gridFill)
                          : fmtPrice(huntLive)
                        : fmtPrice(addPx)}
                    </span>
                  </div>
                  <div className="ns-block__cell">
                    <span className="ns-block__label">{s.arm === "T1" ? "Cover" : "Book"}</span>
                    <span className="ns-block__num">{fmtPrice(bookPx)}</span>
                  </div>
                  <div className="ns-block__cell ns-block__cell--wide">
                    <span className="ns-block__label">Fill</span>
                    <span className="ns-block__num">{s.open ? fmtPrice(s.fill) : "—"}</span>
                  </div>
                </div>
              </div>
            );
          })}
        </div>

        <div className="min-h-0 flex-1 overflow-auto">
          <div className="ramsetu-glass-toolbar__label mb-2">Event log</div>
          {!logs.length ? (
            <p className="ramsetu-glass-empty text-[12px]">
              START — Auto: 09:16 ke baad {BAND_LOW}–{BAND_HIGH} (~{BAND_TARGET}). Manual: ATM±N pe direct
              entry. T1 sell, then T-A up / T-B down (gap ₹{STEP_PTS}). Cap {CAP_LOTS_1X} lots @ 1x. Hard SL
              = cheapest open × 1.30.
            </p>
          ) : (
            <ul className="space-y-1.5">
              {logs.map((l) => (
                <li
                  key={l.id}
                  className={`font-mono text-[12px] leading-snug ${
                    l.kind === "entry"
                      ? "text-cd-green"
                      : l.kind === "exit"
                        ? "ramsetu-glass-table__strike--pe"
                        : l.kind === "warn"
                          ? "text-amber-500"
                          : "text-muted-foreground"
                  }`}
                >
                  {new Date(l.ts).toLocaleTimeString("en-IN", { hour12: false })} · {l.text}
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>
    </div>
  );
}
