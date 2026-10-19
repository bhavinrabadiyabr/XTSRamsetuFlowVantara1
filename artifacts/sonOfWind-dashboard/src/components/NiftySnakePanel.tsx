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
  EOD_MINUTE,
  ENTRY_MINUTE,
  LOT_SIZE,
  MANUAL_STRIKE_OFFSETS,
  MAX_PLAN_TICKS,
  SIZE_MULTS,
  SNAKE_CLOCK_MS,
  UNDERLYING,
  applyFilledAction,
  applySizeToEmptySlots,
  avgFill,
  bookLevel,
  clearSnakeSession,
  closestTo72,
  externalShortFlat,
  idleEngineState,
  readBrokerNetQty,
  isEod,
  isEntryWindow,
  isHardSlReason,
  isInTrade,
  istCalendarDay,
  istMinuteOfDay,
  loadSnakeSession,
  localNewDayReset,
  manualStrikeLabel,
  netRealized,
  nextSquareAllAction,
  openLots,
  openMtm,
  pickManualStrike,
  pickNear72,
  planTick,
  persistSnakeSize,
  qtyForLots,
  resolveHardSl,
  resolveManualStrike,
  saveSnakeSession,
  sellLevel,
  snakePositionActive,
  t1CoverPrice,
  t1HardSlPrice,
  uiReset,
  type ChainPremiumRow,
  type EntryMode,
  type HuntPick,
  type ManualStrikeOffset,
  type OptionType,
  type SizeMult,
  type SnakeAction,
  type SnakeEngineState,
} from "@/lib/niftySnakeRules";

const RECONCILE_MS = 12000;
const BROKER_CONFIRM_HITS = 2;

type NsLog = { id: number; ts: number; text: string; kind: "info" | "entry" | "exit" | "warn" };

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

function windowLabel(nowMs: number): string {
  const m = istMinuteOfDay(nowMs);
  if (m < ENTRY_MINUTE) return "Wait 09:16 IST";
  if (m >= EOD_MINUTE) return "EOD 15:15 — no new snake";
  return "Hunt 70–75";
}

export default function NiftySnakePanel({ chain }: { chain: ChainResolved }) {
  const ltps = useLiveLtp();
  const nifty = isNiftyChain(chain);
  const seg = chain.optionSegment;
  const spotSeg = chain.spotSegment;
  const spotToken = chain.spotToken;

  const restoredRef = useRef(loadSnakeSession());
  const restored = restoredRef.current;

  const [engine, setEngine] = useState<SnakeEngineState>(() => {
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
  const [logs, setLogs] = useState<NsLog[]>(() => restored?.logs ?? []);
  const [busy, setBusy] = useState(false);
  const [clockMs, setClockMs] = useState(() => Date.now());
  const [targetText, setTargetText] = useState("");
  const [targetLocked, setTargetLocked] = useState(false);
  const [slText, setSlText] = useState("");
  const [slLocked, setSlLocked] = useState(true);
  const [strikeMenuOpen, setStrikeMenuOpen] = useState(false);
  const strikeMenuRef = useRef<HTMLDivElement | null>(null);

  const engineRef = useRef(engine);
  const iidRef = useRef<number | null>(iid);
  const ltpsRef = useRef(ltps);
  const chainRef = useRef(chain);
  const niftyRef = useRef(nifty);
  const busyRef = useRef(false);
  const logIdRef = useRef(restored?.nextLogId ?? 1);
  const logsRef = useRef<NsLog[]>(logs);
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
  const dropSessionRef = useRef(false);
  const restoreNoteRef = useRef(Boolean(restored && snakePositionActive(restored.engine)));

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
    for (const inst of Object.values(chain.instrumentMap || {})) {
      if (typeof inst?.ce === "number" && inst.ce > 0) ids.push(inst.ce);
      if (typeof inst?.pe === "number" && inst.pe > 0) ids.push(inst.pe);
    }
    return Array.from(new Set(ids));
  }, [chain.instrumentMap, iid]);

  useSubscribeTouchline(seg, watchIids);
  useSubscribeTouchline(spotSeg, [spotToken]);

  const persistNow = useCallback((st: SnakeEngineState) => {
    if (dropSessionRef.current) {
      clearSnakeSession();
      return;
    }
    const cur = engineRef.current;
    if (!snakePositionActive(cur) && cur.gross === 0 && cur.roundTrips === 0 && logsRef.current.length === 0) {
      clearSnakeSession();
      return;
    }
    saveSnakeSession({
      v: 1,
      day: istCalendarDay(),
      iid: snakePositionActive(cur) ? iidRef.current : null,
      engine: cur,
      logs: logsRef.current,
      nextLogId: logIdRef.current,
    });
    if (st !== cur && !snakePositionActive(st)) {
      /* caller may pass a stale snapshot; store follows the live ref */
    }
  }, []);

  const sync = useCallback((next?: SnakeEngineState) => {
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

  const pushLog = useCallback((text: string, kind: NsLog["kind"] = "info") => {
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
    const pick = pickNear72(rows, st.optionType);
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
    async (action: SnakeAction): Promise<boolean> => {
      const st = engineRef.current;
      if (action.kind === "stop") {
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
        const t1 = st.slots.find((s) => s.index === 1);
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
        pushLog(
          `ENTRY T1 SELL ${action.pick.strike} ${action.pick.optionType} × ${lots} lots / ${qtyForLots(lots)} qty @ ${fmtPrice(fill)} — cover ${fmtPrice(t1CoverPrice(fill))} · hard SL ${fmtPrice(t1HardSlPrice(fill))}`,
          "entry",
        );
        toast({
          title: `Nifty Snake T1 ${action.pick.optionType}`,
          description: `${action.pick.strike} @ ${fmtPrice(fill)} · ${lots} lots · gap ₹3`,
        });
        return true;
      }

      const instrumentId = iidRef.current;
      if (!instrumentId) {
        pushLog("Locked contract missing — cannot add/book", "warn");
        return false;
      }

      if (action.kind === "add" || action.kind === "resell") {
        const slot = engineRef.current.slots.find((s) => s.index === action.index);
        if (slot?.open) return true;
        if (action.kind === "resell") {
          const sl = resolveHardSl(st.t1Fill, st.hardSlPx);
          const liveNow = liveTapePx(instrumentId, ltpsRef.current);
          if (sl != null && (liveNow == null || liveNow >= sl - 1e-9)) return false;
        }
        lastReconcileRef.current = Date.now();
        const hint = await placeOrder("SELL", instrumentId, action.lots);
        const live = liveTapePx(instrumentId, ltpsRef.current);
        const fill =
          expectedLadderFill("SELL", hint.ltp, hint.bid, hint.ask) ||
          xtsOrderFillPx(hint.raw) ||
          live ||
          (st.t1Fill != null && st.t1Fill > 0 ? sellLevel(st.t1Fill, action.index) : 0);
        if (!(fill > 0)) {
          pushLog(`${action.kind === "resell" ? "RESELL" : "ADD"} T${action.index} skipped — no price`, "warn");
          return false;
        }
        const next = applyFilledAction(engineRef.current, action, fill);
        engineRef.current = next;
        if (action.kind === "resell") {
          // Previous cycle's short is closed. A flat/lagging book is not a
          // square-off until this new SELL shows up at XTS.
          lastReconcileRef.current = 0;
          seenBrokerShortRef.current = false;
          brokerCaughtUpRef.current = false;
          brokerFlatHitsRef.current = 0;
        }
        sync(next);
        const lvl = st.t1Fill != null ? sellLevel(st.t1Fill, action.index) : fill;
        pushLog(
          action.kind === "resell"
            ? `RESELL T${action.index} SELL × ${action.lots} lots / ${qtyForLots(action.lots)} qty @ ${fmtPrice(fill)} — grid still from T1 ${fmtPrice(st.t1Fill)}`
            : `ADD T${action.index} SELL × ${action.lots} lots / ${qtyForLots(action.lots)} qty @ ${fmtPrice(fill)} (lvl ${fmtPrice(lvl)})`,
          "entry",
        );
        return true;
      }

      const slot = engineRef.current.slots.find((s) => s.index === action.index);
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
      if (next.awaitResell) {
        seenBrokerShortRef.current = false;
        brokerCaughtUpRef.current = false;
        brokerFlatHitsRef.current = 0;
      }
      if (!shortStill) {
        if (overlayIidRef.current != null) {
          clearLocalPosition(overlayIidRef.current);
          overlayIidRef.current = null;
        }
        if (!next.awaitResell) iidRef.current = null;
        seenBrokerShortRef.current = false;
        brokerCaughtUpRef.current = false;
        brokerFlatHitsRef.current = 0;
      }
      sync(next);
      pushLog(
        `BOOK T${action.index} BUY × ${action.lots} lots / ${qtyForLots(action.lots)} qty @ ${fmtPrice(fill)} · ${action.reason}`,
        "exit",
      );
      if (action.index === 1 && !isHardSlReason(action.reason)) {
        toast({
          title: "Nifty Snake book flat",
          description: action.reason,
        });
      }
      return true;
    },
    [placeOrder, pushLog, sync],
  );

  const reconcileNow = useCallback(async () => {
    const st = engineRef.current;
    if (!isInTrade(st.slots, st.t1Fill) || st.slFlattening || st.awaitResell) return;
    try {
      const list = await fetchFreshPositions();
      if (!list) return;
      const book = readBrokerNetQty(list, iidRef.current);
      if (book.bookEmpty) return;
      const net = book.netQty;
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
        iidRef.current = null;
        seenBrokerShortRef.current = false;
        brokerCaughtUpRef.current = false;
        brokerFlatHitsRef.current = 0;
        const flat = externalShortFlat(engineRef.current);
        engineRef.current = flat;
        sync(flat);
        pushLog("Broker square-off — Snake short book cleared. START AGAIN to hunt.", "warn");
        return;
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
        if (snakePositionActive(st)) {
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
          pushLog("New IST day — Snake reset. Square leftover broker qty manually if still open.", "warn");
        }
      }

      if (!niftyRef.current) return;

      const stNow = engineRef.current;
      const tradingNow = isInTrade(stNow.slots, stNow.t1Fill);
      if (tradingNow && !stNow.slFlattening && Date.now() - lastReconcileRef.current >= RECONCILE_MS) {
        lastReconcileRef.current = Date.now();
        await reconcileNow();
      }

      if (targetLockedRef.current && targetPxRef.current != null) {
        const live = liveTapePx(iidRef.current, ltpsRef.current);
        const st = engineRef.current;
        const trading = isInTrade(st.slots, st.t1Fill);
        if ((trading || st.awaitResell) && live != null && live <= targetPxRef.current + 1e-9) {
          const paused: SnakeEngineState = { ...st, armed: false };
          engineRef.current = paused;
          sync(paused);
          pushLog(
            `TARGET ${fmtPrice(targetPxRef.current)} hit — book ${st.strike ?? "strike"} and PAUSE`,
            "warn",
          );
          toast({
            title: "Snake target hit",
            description: `LTP ${fmtPrice(live)} ≤ ${fmtPrice(targetPxRef.current)}. Booking this strike and pausing.`,
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
            clearSnakeSession();
            pushLog("Target book — session storage cleared", "info");
          }
        }
      }

      if (squareAllReqRef.current) {
        const fromTarget = targetHitRef.current;
        targetHitRef.current = false;
        squareAllReqRef.current = false;
        uiBusy = true;
        setBusy(true);
        if (isInTrade(engineRef.current.slots, engineRef.current.t1Fill)) {
          pushLog(fromTarget ? "TARGET — covering highest-open first" : "SQUARE ALL — covering highest-open first", "warn");
          for (let i = 0; i < MAX_PLAN_TICKS; i++) {
            const action = nextSquareAllAction(engineRef.current.slots);
            if (!action) break;
            const ok = await executeAction(action);
            if (!ok) break;
          }
        }
        const after = engineRef.current;
        if (after.awaitResell || after.resellLegs.length) {
          const stopped = applyFilledAction(after, { kind: "stop", reason: "SQUARE ALL" }, 0);
          engineRef.current = stopped;
          iidRef.current = null;
          sync(stopped);
        }
        if (fromTarget && !isInTrade(engineRef.current.slots, engineRef.current.t1Fill)) {
          dropSessionRef.current = true;
          clearSnakeSession();
          pushLog("Target book — session storage cleared", "info");
        }
        return;
      }

      for (let i = 0; i < MAX_PLAN_TICKS; i++) {
        if (squareAllReqRef.current) break;
        const st = engineRef.current;
        const locked = iidRef.current;
        const ltp = liveTapePx(locked, ltpsRef.current);
        const action = planTick({
          nowMs: Date.now(),
          armed: st.armed,
          awaitRestart: st.awaitRestart,
          awaitResell: st.awaitResell,
          resellLegs: st.resellLegs,
          t1Fill: st.t1Fill,
          slots: st.slots,
          ltp,
          huntPick: huntFromLive(),
          entryMode: st.entryMode,
          hardSlPx: st.hardSlPx,
        });
        if (!action) break;
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
      toast({ title: "Nifty Snake order failed", description: msg, variant: "destructive" });
    } finally {
      busyRef.current = false;
      if (uiBusy) setBusy(false);
    }
  }, [executeAction, huntFromLive, pushLog, reconcileNow, sync]);

  runCycleRef.current = runCycle;

  useEffect(() => {
    const onPosRefresh = () => {
      if (busyRef.current) return;
      void reconcileNow();
    };
    window.addEventListener(POSITIONS_REFRESH_EVENT, onPosRefresh);
    return () => window.removeEventListener(POSITIONS_REFRESH_EVENT, onPosRefresh);
  }, [reconcileNow]);

  useEffect(() => {
    const id = window.setInterval(() => {
      void runCycleRef.current();
      setClockMs(Date.now());
    }, SNAKE_CLOCK_MS);
    return () => window.clearInterval(id);
  }, []);

  useEffect(() => {
    const st = engineRef.current;
    if (iidRef.current || st.strike == null) return;
    const resolvedIid = resolveIid(chain, st.strike, st.optionType);
    if (!resolvedIid) return;
    iidRef.current = resolvedIid;
    setIid(resolvedIid);
    persistNow(st);
  }, [chain, persistNow]);

  useEffect(() => {
    if (!restoreNoteRef.current) return;
    restoreNoteRef.current = false;
    const snap = restoredRef.current;
    if (!snap || !snakePositionActive(snap.engine)) return;
    const trading = isInTrade(snap.engine.slots, snap.engine.t1Fill);
    const label = trading && snap.engine.strike != null
      ? `Reload restore — ${snap.engine.strike.toLocaleString("en-IN")} ${snap.engine.optionType} still live`
      : snap.engine.awaitResell
        ? `Reload restore — waiting to re-SELL below hard SL ${fmtPrice(resolveHardSl(snap.engine.t1Fill, snap.engine.hardSlPx))}`
        : "Reload restore — still armed, hunting 70–75";
    pushLog(label, "info");
  }, [pushLog]);

  const start = () => {
    if (!nifty) {
      toast({ title: "Nifty Snake", description: "Switch the index to NIFTY.", variant: "destructive" });
      return;
    }
    const now = Date.now();
    const st = engineRef.current;
    const trading = isInTrade(st.slots, st.t1Fill);
    if (isEod(now) && !trading && !st.awaitResell) {
      toast({ title: "No new snake today", description: "Past 15:15 IST — wait for next session." });
      pushLog("START rejected — past 15:15 IST", "warn");
      return;
    }
    dropSessionRef.current = false;
    const next: SnakeEngineState = { ...st, armed: true, awaitRestart: false };
    engineRef.current = next;
    sync(next);
    if (trading) {
      pushLog("RESUME — extras on the +3 grid. Protective books stay live", "info");
      toast({ title: "Nifty Snake resumed", description: "Adds on +3 are live again." });
    } else if (st.awaitResell) {
      pushLog("RESUME — re-SELL same legs when LTP is back below hard SL", "info");
      toast({ title: "Nifty Snake re-SELL armed", description: "No 70–75 wait. Same strike, original T1 grid." });
    } else if (st.entryMode === "manual") {
      const label = manualStrikeLabel(st.manualStrikeOffset);
      if (!isEntryWindow(now)) {
        pushLog(`Armed (Manual) — waiting for 09:16 IST, then enter ${label} ${st.optionType} (no band)`, "info");
        toast({ title: "Nifty Snake armed", description: `Manual ${label} after 09:16 IST.` });
      } else {
        pushLog(`START Manual — direct entry ${label} ${st.optionType} @ live price (band skipped)`, "info");
        toast({
          title: "Nifty Snake started",
          description: `Manual ${label} ${st.optionType} — no band check.`,
        });
      }
    } else if (!isEntryWindow(now)) {
      pushLog(`Armed — waiting for 09:16 IST, then hunt ${BAND_LOW}–${BAND_HIGH}`, "info");
      toast({ title: "Nifty Snake armed", description: "Entry after 09:16 IST." });
    } else {
      pushLog(`START — hunting ~${BAND_TARGET} premium in ${BAND_LOW}–${BAND_HIGH}`, "info");
      toast({
        title: "Nifty Snake started",
        description: `Hunting ${BAND_LOW}–${BAND_HIGH} on selected side. Saved across reload.`,
      });
    }
    void runCycleRef.current();
  };

  const pause = () => {
    const next: SnakeEngineState = { ...engineRef.current, armed: false };
    engineRef.current = next;
    sync(next);
    pushLog("PAUSE — no hunt, no new extras, no re-SELL. Books, cover, hard SL, EOD still fire", "info");
    toast({ title: "Nifty Snake paused", description: "Protective exits stay on." });
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
    toast({ title: "Target locked", description: `Book all of this strike when LTP ≤ ${fmtPrice(px)}, then pause.` });
  };

  const unlockTarget = () => {
    targetLockedRef.current = false;
    targetPxRef.current = null;
    setTargetLocked(false);
    toast({ title: "Target unlocked", description: "Live target is off. Not saved in session." });
  };

  const lockSl = () => {
    const px = Number(slText.replace(/,/g, "").trim());
    if (!(px > 0)) {
      toast({ title: "SL", description: "Valid price daalo.", variant: "destructive" });
      return;
    }
    const st = engineRef.current;
    if (st.t1Fill == null || !(st.t1Fill > 0)) {
      toast({ title: "SL", description: "Trade start hone ke baad SL lock hoga.", variant: "destructive" });
      return;
    }
    const next: SnakeEngineState = { ...st, hardSlPx: px };
    engineRef.current = next;
    sync(next);
    setSlLocked(true);
    setSlText(px.toFixed(2));
    toast({
      title: "SL locked",
      description: `Hard SL ${fmtPrice(px)}. Re-entry when LTP < ${fmtPrice(px)}.`,
    });
    void runCycleRef.current();
  };

  const unlockSl = () => {
    const st = engineRef.current;
    if (st.t1Fill == null || !(st.t1Fill > 0)) return;
    const shown = resolveHardSl(st.t1Fill, st.hardSlPx);
    if (shown != null) setSlText(shown.toFixed(2));
    setSlLocked(false);
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
    clearSnakeSession();
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
    persistSnakeSize(sizeMult);
    const next: SnakeEngineState = {
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
    const next: SnakeEngineState = { ...st, entryMode, manualStrikeOffset: 0 };
    engineRef.current = next;
    sync(next);
  };

  const setManualOffset = (manualStrikeOffset: ManualStrikeOffset) => {
    setStrikeMenuOpen(false);
    const st = engineRef.current;
    if (isInTrade(st.slots, st.t1Fill) || st.awaitResell || st.manualStrikeOffset === manualStrikeOffset) return;
    const next: SnakeEngineState = { ...st, manualStrikeOffset };
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
        : pickNear72(rows, engine.optionType)
      : null;
  const nearest = closestTo72(rows, engine.optionType);
  const avg = avgFill(engine.slots);
  const lotsOpen = openLots(engine.slots);
  const mtm = openMtm(avg, liveLtp, lotsOpen);
  const gridOn = Boolean((inTrade || engine.awaitResell) && engine.t1Fill != null && engine.t1Fill > 0);
  const gridFill = gridOn ? engine.t1Fill : null;
  const coverPx = gridFill != null ? t1CoverPrice(gridFill) : null;
  const hardSlPx = resolveHardSl(gridFill, engine.hardSlPx);
  const slFillRef = useRef<number | null>(engine.t1Fill);
  useEffect(() => {
    const fillChanged = slFillRef.current !== engine.t1Fill;
    if (fillChanged) slFillRef.current = engine.t1Fill;
    if (fillChanged && !slLocked) {
      setSlLocked(true);
      return;
    }
    if (!slLocked) return;
    setSlText(hardSlPx != null ? hardSlPx.toFixed(2) : "");
  }, [slLocked, hardSlPx, engine.t1Fill]);
  const net = netRealized(engine);
  const primaryLabel = engine.awaitRestart ? "START AGAIN" : "START";
  const sideLocked = inTrade || engine.awaitResell;

  const huntIid = huntPick ? resolveIid(chain, huntPick.strike, huntPick.optionType) : null;
  const huntLive = liveTapePx(huntIid, ltps) ?? huntPick?.ltp ?? null;

  const statusNote = !nifty
    ? "NIFTY only — switch index"
      : engine.awaitResell
      ? `Hard SL flat — re-SELL same legs when LTP < ${fmtPrice(hardSlPx)}`
      : engine.awaitRestart && !inTrade
        ? "Booked. START AGAIN to hunt a new 70–75"
        : inTrade && engine.armed
          ? "In trade · adds on +3 · books on −3"
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
                  title={`ATM ${liveAtm.toLocaleString("en-IN")} · ${engine.optionType}`}
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
              title="Clear Snake UI only — does not square XTS"
            >
              RESET
            </button>
          </div>
        </div>
      </div>

      <div className="ramsetu-glass-table-wrap flex flex-col gap-3">
        {!nifty && (
          <div className="ramsetu-glass-empty">
            Nifty Snake trades NIFTY options only. Switch the top index to NIFTY.
          </div>
        )}

        <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
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
            <div className="sow-live-sl">
              <span className="sow-live-target__label">SL</span>
              <input
                className="sow-live-target__input sow-live-sl__input"
                inputMode="decimal"
                value={slText}
                disabled={slLocked || hardSlPx == null}
                placeholder="SL"
                aria-label="Stop loss price"
                onChange={(e) => setSlText(e.target.value)}
              />
              <div className="sow-live-sl__row">
                <button
                  type="button"
                  className={`sow-live-target__btn${slLocked ? "" : " sow-live-target__btn--lock"}`}
                  disabled={slLocked || hardSlPx == null}
                  onClick={lockSl}
                >
                  Lock
                </button>
                <button
                  type="button"
                  className="sow-live-target__btn"
                  disabled={!slLocked || hardSlPx == null}
                  onClick={unlockSl}
                >
                  Unlock
                </button>
              </div>
            </div>
          </div>

          <div className="ramsetu-glass-card ramsetu-glass-card--center">
            <div className="ramsetu-glass-card__badge">T1 FILL · GRID LOCK</div>
            <div className="ramsetu-glass-card__strike tabular-nums">
              {gridFill != null ? fmtPrice(gridFill) : "—"}
            </div>
            <div className="ramsetu-glass-card__rule">
              {gridFill != null
                ? `Cover ${fmtPrice(coverPx)} · hard SL ${fmtPrice(hardSlPx)} · gap ₹3`
                : "Cover −30% · Hard SL +30% from actual T1 fill"}
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
              MTM {fmtPnl(mtm ?? 0)} · {lotsOpen} lots · qty {lotsOpen * LOT_SIZE}
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
              <button
                type="button"
                className="sow-live-target__btn"
                disabled={!targetLocked}
                onClick={unlockTarget}
              >
                Unlock
              </button>
            </div>
          </div>

          <div className="ramsetu-glass-card ramsetu-glass-card--center">
            <div className="ramsetu-glass-card__badge">REALIZED</div>
            <div
              className={`ramsetu-glass-card__strike tabular-nums ${
                net > 0 ? "text-cd-green" : net < 0 ? "ramsetu-glass-table__strike--pe" : ""
              }`}
            >
              {fmtPnl(net)}
            </div>
            <div className="ramsetu-glass-card__rule">
              Gross {fmtPnl(engine.gross)} · exp {fmtPnl(engine.expense)} · {engine.roundTrips} lot RT
              {engine.peakLots > 0 ? ` · peak T${engine.peakTranche || "—"} / ${engine.peakLots} lots` : ""}
            </div>
          </div>
        </div>

        <div className="ns-blocks overflow-auto">
          {engine.slots.map((s) => {
            const addPx = gridFill != null ? sellLevel(gridFill, s.index) : null;
            const bookPx =
              s.index === 1
                ? coverPx
                : gridFill != null
                  ? bookLevel(gridFill, s.index)
                  : null;
            const addVal =
              s.index === 1
                ? gridFill != null
                  ? fmtPrice(gridFill)
                  : fmtPrice(huntLive)
                : fmtPrice(addPx);
            const waitingResell = engine.awaitResell && engine.resellLegs.includes(s.index) && !s.open;
            return (
              <div key={s.index} className={`ns-block${s.open ? " ns-block--open" : ""}`}>
                <div className="ns-block__top">
                  <span className="ns-block__tranche">T{s.index}</span>
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
                    <span className="ns-block__num">{addVal}</span>
                  </div>
                  <div className="ns-block__cell">
                    <span className="ns-block__label">{s.index === 1 ? "Cover" : "Book"}</span>
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
              START — Auto: 09:16 ke baad 70–75 premium (prefer ~{BAND_TARGET}). Manual: ATM−3…ATM+3 pe
              direct entry (band skip). T1–T7 gap ₹3. Cover −30%, hard SL +30% original T1 fill se.
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
