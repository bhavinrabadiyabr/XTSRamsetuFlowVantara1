import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { ChainResolved } from "@/types/market";
import { useLiveLtp, peekLiveTick } from "@/context/LiveLtpContext";
import { liveTapeLtp } from "@/lib/liveQuote";
import { useSubscribeTouchline } from "@/lib/mdRegistry";
import { fmtPnl, fmtPrice } from "@/lib/formatNumber";
import { apiFetch } from "@/lib/backend";
import { bumpPositionsRefresh, fetchIxPositions, POSITIONS_REFRESH_EVENT, setLocalShortPosition, clearLocalPosition } from "@/lib/ixPortfolio";
import { XTS_IX_ORDER_BASE, expectedLadderFill, ixOrderRejectedMessage, ladderOrderPricing, xtsOrderFillPx } from "@/lib/xtsOrder";
import { liveAtmStrikeForChain } from "@/lib/liveAtmStrike";
import { toast } from "@/hooks/use-toast";
import {
  BAND_HIGH,
  BAND_LOW,
  BAND_TARGET,
  EOD_MINUTE,
  ENTRY_MINUTE,
  LADDER_CLOCK_MS,
  LOT_SIZE,
  MANUAL_STRIKE_OFFSETS,
  MAX_PLAN_TICKS,
  SIZE_MULTS,
  UNDERLYING,
  addLevel,
  applyFilledAction,
  applySizeToEmptySlots,
  avgFill,
  bookLevel,
  clearLadderSession,
  closestTo100,
  EV_NIFTY_LADDER_FLAT,
  emptySlots,
  idleEngineState,
  isEod,
  isEntryWindow,
  isHardSlReason,
  isInTrade,
  istCalendarDay,
  istMinuteOfDay,
  ladderSessionActive,
  loadLadderSession,
  localNewDayReset,
  manualStrikeLabel,
  maybeConfirmT1Fill,
  nextSquareAllAction,
  openLots,
  openMtm,
  pickManualStrike,
  pickNear100,
  planTick,
  qtyForLots,
  reconcileBrokerShortLots,
  resolveHardSl,
  resolveManualStrike,
  saveLadderSession,
  t1CoverPrice,
  t1HardSlPrice,
  uiReset,
  type ChainPremiumRow,
  type EntryMode,
  type HuntPick,
  type LadderAction,
  type LadderEngineState,
  type ManualStrikeOffset,
  type OpenDriveBias,
  type OptionType,
  type SizeMult,
} from "@/lib/niftyLadderRules";

const DRIVE_POLL_MS = 10000;
const RECONCILE_MS = 12000;
const RECONCILE_T1_MS = 2000;
const BROKER_CONFIRM_HITS = 2;

type NlLog = { id: number; ts: number; text: string; kind: "info" | "entry" | "exit" | "warn" };

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
  ready?: boolean;
  closed?: boolean;
  open?: number | null;
  close?: number | null;
  bias?: OpenDriveBias | null;
  suggest?: OptionType | null;
  error?: string;
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
  if (m >= EOD_MINUTE) return "EOD 15:15 — no new ladder";
  return "Hunt window open";
}

export default function NiftyLadderPanel({ chain }: { chain: ChainResolved; qty?: number }) {
  const ltps = useLiveLtp();
  const nifty = isNiftyChain(chain);
  const seg = chain.optionSegment;
  const spotSeg = chain.spotSegment;
  const spotToken = chain.spotToken;

  const restoredRef = useRef(loadLadderSession());
  const restored = restoredRef.current;

  const [engine, setEngine] = useState<LadderEngineState>(() => {
    if (!restored?.engine) return idleEngineState("CE", 1);
    const e = restored.engine;
    return {
      ...idleEngineState(e.optionType, e.sizeMult, e.entryMode ?? "auto", e.manualStrikeOffset ?? 0),
      ...e,
      entryMode: e.entryMode === "manual" ? "manual" : "auto",
      manualStrikeOffset: MANUAL_STRIKE_OFFSETS.includes(e.manualStrikeOffset)
        ? e.manualStrikeOffset
        : 0,
      slots: e.slots.map((s) => ({ ...s })),
    };
  });
  const [iid, setIid] = useState<number | null>(() => restored?.iid ?? null);
  const [logs, setLogs] = useState<NlLog[]>(() => restored?.logs ?? []);
  const [busy, setBusy] = useState(false);
  const [clockMs, setClockMs] = useState(() => Date.now());
  const [drive, setDrive] = useState<DriveState>({
    ready: false,
    closed: false,
    open: null,
    close: null,
    bias: null,
    suggest: null,
    error: null,
  });
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
  const logsRef = useRef<NlLog[]>(logs);
  const sessionDayRef = useRef(istCalendarDay());
  const lastReconcileRef = useRef(0);
  const seenBrokerShortRef = useRef(
    Boolean(restored?.engine && isInTrade(restored.engine.slots, restored.engine.t1Fill)),
  );
  const brokerCaughtUpRef = useRef(false);
  const brokerFlatHitsRef = useRef(0);
  const phantomHitsRef = useRef(0);
  const squareAllReqRef = useRef(false);
  const targetPxRef = useRef<number | null>(null);
  const targetLockedRef = useRef(false);
  const targetHitRef = useRef(false);
  const restoreNoteRef = useRef(Boolean(restored));

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

  const persistNow = useCallback((st: LadderEngineState) => {
    if (!ladderSessionActive(st)) {
      clearLadderSession();
      return;
    }
    const cur = engineRef.current;
    if (!ladderSessionActive(cur)) {
      clearLadderSession();
      return;
    }
    saveLadderSession({
      v: 1,
      day: istCalendarDay(),
      iid: iidRef.current,
      engine: cur,
      logs: logsRef.current,
      nextLogId: logIdRef.current,
    });
  }, []);

  const sync = useCallback((next?: LadderEngineState) => {
    const st = next ?? engineRef.current;
    engineRef.current = st;
    setEngine({ ...st, slots: st.slots.map((s) => ({ ...s })) });
    setIid(iidRef.current);
    persistNow(st);
  }, [persistNow]);

  const pushLog = useCallback((text: string, kind: NlLog["kind"] = "info") => {
    const id = logIdRef.current++;
    setLogs((prev) => {
      const next = [{ id, ts: Date.now(), text, kind }, ...prev].slice(0, 60);
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
    if (isInTrade(st.slots, st.t1Fill)) return null;
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
    // Auto: live must stay inside 98–105. Manual already skipped band above.
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
    async (action: LadderAction): Promise<boolean> => {
      const st = engineRef.current;
      if (action.kind === "enter_t1") {
        if (isInTrade(engineRef.current.slots, engineRef.current.t1Fill)) return true;
        const instrumentId = resolveIid(chainRef.current, action.pick.strike, action.pick.optionType);
        if (!instrumentId) {
          pushLog(`No instrument for ${action.pick.strike} ${action.pick.optionType}`, "warn");
          return false;
        }
        const t1 = st.slots.find((s) => s.index === 1);
        const lots = t1?.lots ?? 5 * st.sizeMult;
        lastReconcileRef.current = Date.now();
        const hint = await placeOrder("SELL", instrumentId, lots);
        const marketPx = expectedLadderFill("SELL", hint.ltp, hint.bid, hint.ask);
        const xtsPx = xtsOrderFillPx(hint.raw);
        const fill = marketPx || xtsPx || action.pick.ltp;
        iidRef.current = instrumentId;
        lastReconcileRef.current = 0;
        seenBrokerShortRef.current = false;
        brokerCaughtUpRef.current = false;
        brokerFlatHitsRef.current = 0;
        phantomHitsRef.current = 0;
        const next = applyFilledAction(engineRef.current, action, fill);
        engineRef.current = next;
        sync(next);
        pushLog(
          `T1 SELL ${action.pick.strike} ${action.pick.optionType} × ${lots} lots @ ${fmtPrice(fill)}${marketPx ? "" : xtsPx ? " XTS" : ""} — T2 add ${fmtPrice(addLevel(fill, 2))} / book ${fmtPrice(bookLevel(fill, 2))} / hard SL ${fmtPrice(t1HardSlPrice(fill))}`,
          "entry",
        );
        toast({
          title: `Nifty Ladder T1 ${action.pick.optionType}`,
          description: `${action.pick.strike} @ ${fmtPrice(fill)} · ${lots} lots · extras live on +3 / −3`,
        });
        return true;
      }

      const instrumentId = iidRef.current;
      if (!instrumentId) {
        pushLog("Locked contract missing — cannot add/book", "warn");
        return false;
      }
      if (action.kind === "add") {
        const through =
          typeof action.through === "number" && action.through >= action.index
            ? action.through
            : action.index;
        const alreadyOpen = engineRef.current.slots.filter(
          (s) => s.index >= action.index && s.index <= through && s.open,
        );
        if (alreadyOpen.length === through - action.index + 1) return true;
        const tick = peekLiveTick(instrumentId);
        const live = liveTapePx(instrumentId, ltpsRef.current);
        const fillGuess =
          expectedLadderFill("SELL", live, tick?.bid ?? null, tick?.ask ?? null) ||
          (st.t1Fill != null && st.t1Fill > 0 ? addLevel(st.t1Fill, through) : 0);
        if (!(fillGuess > 0)) {
          pushLog(`ADD T${action.index} skipped — no live price`, "warn");
          return false;
        }
        lastReconcileRef.current = Date.now();
        brokerCaughtUpRef.current = false;
        phantomHitsRef.current = 0;
        const reserved = applyFilledAction(engineRef.current, action, fillGuess);
        engineRef.current = reserved;
        sync(reserved);
        const hint = await placeOrder("SELL", instrumentId, action.lots);
        const fill =
          expectedLadderFill("SELL", hint.ltp, hint.bid, hint.ask) || fillGuess;
        const next = applyFilledAction(engineRef.current, action, fill);
        engineRef.current = next;
        sync(next);
        const band =
          through > action.index ? `T${action.index}–T${through}` : `T${action.index}`;
        const lvl =
          st.t1Fill != null && st.t1Fill > 0
            ? addLevel(st.t1Fill, through)
            : fill;
        pushLog(
          through > action.index
            ? `ADD ${band} SELL × ${action.lots} lots @ ${fmtPrice(fill)} — gap fill (no skip) · last lvl ${fmtPrice(lvl)}`
            : `ADD ${band} SELL × ${action.lots} lots @ ${fmtPrice(fill)} (lvl ${fmtPrice(lvl)})`,
          "entry",
        );
        return true;
      }

      if (action.kind === "reload") {
        const slot = engineRef.current.slots.find((s) => s.index === action.index);
        if (slot?.open) return true;
        const tick = peekLiveTick(instrumentId);
        const live = liveTapePx(instrumentId, ltpsRef.current);
        const fillGuess =
          expectedLadderFill("SELL", live, tick?.bid ?? null, tick?.ask ?? null) || live || 0;
        if (!(fillGuess > 0)) {
          pushLog(`RELOAD T${action.index} skipped — no live price`, "warn");
          return false;
        }
        const hardSl = resolveHardSl(st.t1Fill, st.hardSlPx);
        if (hardSl != null && fillGuess >= hardSl) return false;
        lastReconcileRef.current = Date.now();
        if (action.index === 1) {
          seenBrokerShortRef.current = false;
          brokerCaughtUpRef.current = false;
          brokerFlatHitsRef.current = 0;
          phantomHitsRef.current = 0;
        }
        const hint = await placeOrder("SELL", instrumentId, action.lots);
        const fill =
          expectedLadderFill("SELL", hint.ltp, hint.bid, hint.ask) || fillGuess;
        const next = applyFilledAction(engineRef.current, action, fill);
        engineRef.current = next;
        sync(next);
        pushLog(
          `RELOAD T${action.index} SELL × ${action.lots} lots @ ${fmtPrice(fill)} — same ${st.strike ?? ""} ${st.optionType} grid · hard SL ${fmtPrice(hardSl)}`,
          "entry",
        );
        return true;
      }

      const slot = engineRef.current.slots.find((s) => s.index === action.index);
      if (!slot?.open) return true;
      lastReconcileRef.current = Date.now();
      phantomHitsRef.current = 0;
      if (action.index > 1) {
        const reserved = applyFilledAction(engineRef.current, action, 1);
        engineRef.current = reserved;
        sync(reserved);
      }
      const hint = await placeOrder("BUY", instrumentId, action.lots);
      const fill =
        expectedLadderFill("BUY", hint.ltp, hint.bid, hint.ask) ||
        (st.t1Fill != null && st.t1Fill > 0 ? st.t1Fill : 0);
      const next = applyFilledAction(engineRef.current, action, fill);
      engineRef.current = next;
      if (action.index === 1) {
        seenBrokerShortRef.current = false;
        brokerCaughtUpRef.current = false;
        brokerFlatHitsRef.current = 0;
        phantomHitsRef.current = 0;
        if (!next.awaitReload) iidRef.current = null;
      }
      sync(next);
      const hardSl = next.awaitReload ? resolveHardSl(next.t1Fill, next.hardSlPx) : null;
      pushLog(
        hardSl != null
          ? `BOOK T${action.index} BUY × ${action.lots} lots @ ${fmtPrice(fill)} · ${action.reason} — reload ${next.strike ?? ""} ${next.optionType} when LTP < ${fmtPrice(hardSl)}`
          : `BOOK T${action.index} BUY × ${action.lots} lots @ ${fmtPrice(fill)} · ${action.reason}`,
        "exit",
      );
      toast({
        title:
          action.index === 1
            ? next.awaitReload
              ? "Hard SL flat — reload armed"
              : "Nifty Ladder flat"
            : `T${action.index} booked`,
        description:
          hardSl != null
            ? `Same strike re-SELL when LTP < ${fmtPrice(hardSl)}. PAUSE blocks it.`
            : action.reason,
      });
      return true;
    },
    [placeOrder, pushLog, sync],
  );

  const reconcileNow = useCallback(async () => {
    const st = engineRef.current;
    if (!isInTrade(st.slots, st.t1Fill)) return;
    try {
      const list = await fetchFreshPositions();
      if (!list) return;
      const locked = iidRef.current;
      const openShorts = list.filter((p) => positionNetQty(p) < 0);
      if (!locked && openShorts.length > 0) return;
      const row = locked ? list.find((p) => positionIid(p) === locked) : undefined;
      const net = row ? positionNetQty(row) : 0;
      const brokerShortLots = net < 0 ? Math.round(Math.abs(net) / LOT_SIZE) : 0;
      const uiLots = openLots(engineRef.current.slots);

      if (brokerShortLots >= uiLots && uiLots > 0) {
        seenBrokerShortRef.current = true;
        brokerCaughtUpRef.current = true;
        brokerFlatHitsRef.current = 0;
        phantomHitsRef.current = 0;
        if (!engineRef.current.t1GridLocked) {
          const next = maybeConfirmT1Fill(engineRef.current);
          if (next.t1GridLocked && !engineRef.current.t1GridLocked) {
            engineRef.current = next;
            sync(next);
          }
        }
        return;
      }

      if (brokerShortLots <= 0) {
        phantomHitsRef.current = 0;
        // Fresh T1: empty/stale book is not a square-off (seenBrokerShort is false).
        // Reload restore: seenBrokerShort is already true — XTS may already be net 0.
        // Do not also require brokerCaughtUp, or a booked-in-XTS session stays stuck IN TRADE.
        if (!seenBrokerShortRef.current) return;
        brokerFlatHitsRef.current += 1;
        if (brokerFlatHitsRef.current < BROKER_CONFIRM_HITS) return;
        iidRef.current = null;
        seenBrokerShortRef.current = false;
        brokerCaughtUpRef.current = false;
        brokerFlatHitsRef.current = 0;
        const flat: LadderEngineState = {
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
        pushLog("Broker square-off — Nifty Ladder session cleared. START AGAIN to hunt.", "warn");
        return;
      }

      // broker has some short but fewer lots than UI — only phantom after a live catch-up
      if (!brokerCaughtUpRef.current) return;
      const result = reconcileBrokerShortLots(engineRef.current, brokerShortLots);
      if (!result.phantomClosed.length) {
        phantomHitsRef.current = 0;
        return;
      }
      phantomHitsRef.current += 1;
      if (phantomHitsRef.current < BROKER_CONFIRM_HITS) return;
      phantomHitsRef.current = 0;
      brokerCaughtUpRef.current = false;
      engineRef.current = result.state;
      sync(result.state);
      pushLog(`Phantom extras closed: T${result.phantomClosed.join(", T")}`, "warn");
    } catch {
      /* ignore */
    }
  }, [fetchFreshPositions, pushLog, sync]);

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
        if (isInTrade(st.slots, st.t1Fill)) {
          iidRef.current = null;
          seenBrokerShortRef.current = false;
          brokerCaughtUpRef.current = false;
          brokerFlatHitsRef.current = 0;
          phantomHitsRef.current = 0;
          const next = localNewDayReset(st);
          engineRef.current = next;
          sync(next);
          pushLog("New IST day — local reset. Square leftover broker qty manually if still open.", "warn");
        }
      }

      if (!niftyRef.current) return;

      const stNow = engineRef.current;
      const tradingNow = isInTrade(stNow.slots, stNow.t1Fill);
      const reconcileEvery = tradingNow && !stNow.t1GridLocked ? RECONCILE_T1_MS : RECONCILE_MS;
      if (tradingNow && Date.now() - lastReconcileRef.current >= reconcileEvery) {
        lastReconcileRef.current = Date.now();
        await reconcileNow();
      }

      if (targetLockedRef.current && targetPxRef.current != null) {
        const live = liveTapePx(iidRef.current, ltpsRef.current);
        const st = engineRef.current;
        const trading = isInTrade(st.slots, st.t1Fill);
        if ((trading || st.awaitReload) && live != null && live <= targetPxRef.current + 1e-9) {
          const paused: LadderEngineState = { ...st, armed: false, awaitReload: false };
          engineRef.current = paused;
          sync(paused);
          pushLog(
            `TARGET ${fmtPrice(targetPxRef.current)} hit — book ${st.strike ?? "strike"} and PAUSE`,
            "warn",
          );
          toast({
            title: "Ladder target hit",
            description: `LTP ${fmtPrice(live)} ≤ ${fmtPrice(targetPxRef.current)}. Booking this strike and pausing.`,
          });
          if (trading) {
            targetHitRef.current = true;
            squareAllReqRef.current = true;
          } else {
            clearLadderSession();
            pushLog("Target book — session storage cleared", "info");
          }
        }
      }

      if (squareAllReqRef.current) {
        const fromTarget = targetHitRef.current;
        targetHitRef.current = false;
        squareAllReqRef.current = false;
        if (isInTrade(engineRef.current.slots, engineRef.current.t1Fill)) {
          uiBusy = true;
          setBusy(true);
          pushLog(fromTarget ? "TARGET — covering highest-open first" : "SQUARE ALL — covering highest-open first", "warn");
          for (let i = 0; i < MAX_PLAN_TICKS; i++) {
            const action = nextSquareAllAction(engineRef.current.slots);
            if (!action) break;
            const ok = await executeAction(action);
            if (!ok) break;
          }
        }
        if (fromTarget && !isInTrade(engineRef.current.slots, engineRef.current.t1Fill)) {
          clearLadderSession();
          pushLog("Target book — session storage cleared", "info");
        }
        const afterSq = engineRef.current;
        if (afterSq.awaitReload) {
          const cancelled = idleEngineState(
            afterSq.optionType,
            afterSq.sizeMult,
            afterSq.entryMode,
            afterSq.manualStrikeOffset,
          );
          iidRef.current = null;
          engineRef.current = cancelled;
          sync(cancelled);
          pushLog("SQUARE ALL — hard-SL reload cancelled", "warn");
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
          (st.awaitReload || isInTrade(st.slots, st.t1Fill))
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
          awaitReload: st.awaitReload,
          t1Fill: st.t1Fill,
          t1GridLocked: st.t1GridLocked,
          slots: st.slots,
          ltp,
          huntPick: huntFromLive(),
          entryMode: st.entryMode,
          hardSlPx: st.hardSlPx,
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
      toast({ title: "Nifty Ladder order failed", description: msg, variant: "destructive" });
    } finally {
      busyRef.current = false;
      if (uiBusy) setBusy(false);
    }
  }, [executeAction, huntFromLive, pushLog, reconcileNow, sync]);

  const runCycleRef = useRef(runCycle);
  runCycleRef.current = runCycle;

  useEffect(() => {
    const onFlat = () => {
      const next: LadderEngineState = { ...engineRef.current, armed: false };
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
    window.addEventListener(EV_NIFTY_LADDER_FLAT, onFlat);
    window.addEventListener(POSITIONS_REFRESH_EVENT, onPosRefresh);
    return () => {
      window.removeEventListener(EV_NIFTY_LADDER_FLAT, onFlat);
      window.removeEventListener(POSITIONS_REFRESH_EVENT, onPosRefresh);
    };
  }, [pushLog, reconcileNow, sync]);

  useEffect(() => {
    const id = window.setInterval(() => {
      void runCycleRef.current();
      setClockMs(Date.now());
    }, LADDER_CLOCK_MS);
    return () => window.clearInterval(id);
  }, []);

  useEffect(() => {
    const st = engineRef.current;
    if (iidRef.current || st.strike == null) return;
    if (!st.awaitReload && !isInTrade(st.slots, st.t1Fill)) return;
    const resolvedIid = resolveIid(chain, st.strike, st.optionType);
    if (!resolvedIid) return;
    iidRef.current = resolvedIid;
    setIid(resolvedIid);
    persistNow(st);
  }, [chain, persistNow, engine.awaitReload, engine.strike, engine.t1Fill]);

  useEffect(() => {
    if (!restoreNoteRef.current) return;
    restoreNoteRef.current = false;
    const snap = restoredRef.current;
    if (!snap) return;
    const trading = isInTrade(snap.engine.slots, snap.engine.t1Fill);
    const label =
      trading && snap.engine.strike != null
        ? `Reload restore — ${snap.engine.strike.toLocaleString("en-IN")} ${snap.engine.optionType} still live`
        : "Reload restore — still armed, hunting";
    pushLog(label, "info");
    if (trading) {
      lastReconcileRef.current = 0;
      void reconcileNow();
    }
  }, [pushLog, reconcileNow]);

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
      toast({ title: "Nifty Ladder", description: "Switch the index to NIFTY.", variant: "destructive" });
      return;
    }
    const now = Date.now();
    const st = engineRef.current;
    const trading = isInTrade(st.slots, st.t1Fill);
    if (isEod(now) && !trading) {
      toast({ title: "No new ladder today", description: "Past 15:15 IST — wait for next session." });
      pushLog("START rejected — past 15:15 IST", "warn");
      return;
    }
    const next: LadderEngineState = { ...st, armed: true, awaitRestart: false };
    engineRef.current = next;
    sync(next);
    if (st.awaitReload && st.t1Fill != null && st.t1Fill > 0 && st.strike != null) {
      pushLog(
        `RESUME — reload ${st.strike.toLocaleString("en-IN")} ${st.optionType} T1–T9 when LTP < hard SL ${fmtPrice(resolveHardSl(st.t1Fill, st.hardSlPx))}`,
        "info",
      );
      toast({
        title: "Hard SL reload armed",
        description: "Same strike. Full book sells again only while premium is under the +30% line.",
      });
    } else if (trading) {
      pushLog("RESUME extras on +3 (protective exits stay live)", "info");
      toast({ title: "Nifty Ladder resumed", description: "Adds on +3 are live again." });
    } else if (st.entryMode === "manual") {
      const label = manualStrikeLabel(st.manualStrikeOffset);
      if (!isEntryWindow(now)) {
        pushLog(`Armed (Manual) — waiting for 09:16 IST, then enter ${label} ${st.optionType} (no band)`, "info");
        toast({ title: "Nifty Ladder armed", description: `Manual ${label} after 09:16 IST.` });
      } else {
        pushLog(`START Manual — direct entry ${label} ${st.optionType} @ live price (band skipped)`, "info");
        toast({
          title: "Nifty Ladder started",
          description: `Manual ${label} ${st.optionType} — no band check.`,
        });
      }
    } else if (!isEntryWindow(now)) {
      pushLog(`Armed — waiting for 09:16 IST, then hunt ${BAND_LOW}–${BAND_HIGH}`, "info");
      toast({ title: "Nifty Ladder armed", description: "Entry after 09:16 IST." });
    } else {
      pushLog(`START — hunting ~${BAND_TARGET} premium in ${BAND_LOW}–${BAND_HIGH}`, "info");
      toast({
        title: "Nifty Ladder started",
        description: `Hunting ${BAND_LOW}–${BAND_HIGH} on selected side.`,
      });
    }
    void runCycleRef.current();
  };

  const pause = () => {
    const next: LadderEngineState = { ...engineRef.current, armed: false };
    engineRef.current = next;
    sync(next);
    pushLog(
      "PAUSE — no hunt / no new adds / no hard-SL reload. Extras −3, T1 −30%, hard SL flatten, EOD still fire",
      "info",
    );
    toast({ title: "Nifty Ladder paused", description: "Exits stay on. Reload stays off until START." });
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
    const next: LadderEngineState = { ...st, hardSlPx: px };
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
    if (!isInTrade(st.slots, st.t1Fill) && !st.awaitReload) return;
    squareAllReqRef.current = true;
    void runCycleRef.current();
  };

  const reset = () => {
    const st = engineRef.current;
    if (iid != null) clearLocalPosition(iid);
    iidRef.current = null;
    seenBrokerShortRef.current = false;
    brokerCaughtUpRef.current = false;
    brokerFlatHitsRef.current = 0;
    phantomHitsRef.current = 0;
    const next = uiReset(st);
    engineRef.current = next;
    logsRef.current = [];
    logIdRef.current = 1;
    setLogs([]);
    sync(next);
    pushLog("RESET — UI cleared (broker positions untouched)", "info");
  };

  const setSide = (optionType: OptionType) => {
    const st = engineRef.current;
    if (isInTrade(st.slots, st.t1Fill) || st.awaitReload || st.optionType === optionType) return;
    const next = { ...st, optionType };
    engineRef.current = next;
    sync(next);
  };

  const setMult = (sizeMult: SizeMult) => {
    const st = engineRef.current;
    if (isInTrade(st.slots, st.t1Fill) || st.awaitReload || st.sizeMult === sizeMult) return;
    const next: LadderEngineState = {
      ...st,
      sizeMult,
      slots: isInTrade(st.slots, st.t1Fill) ? st.slots : applySizeToEmptySlots(emptySlots(sizeMult), sizeMult),
    };
    engineRef.current = next;
    sync(next);
  };

  const setEntryMode = (entryMode: EntryMode) => {
    const st = engineRef.current;
    if (isInTrade(st.slots, st.t1Fill) || st.awaitReload || st.entryMode === entryMode) return;
    const next: LadderEngineState = { ...st, entryMode, manualStrikeOffset: 0 };
    engineRef.current = next;
    sync(next);
  };

  const setManualOffset = (manualStrikeOffset: ManualStrikeOffset) => {
    setStrikeMenuOpen(false);
    const st = engineRef.current;
    if (isInTrade(st.slots, st.t1Fill) || st.awaitReload || st.manualStrikeOffset === manualStrikeOffset) return;
    const next: LadderEngineState = { ...st, manualStrikeOffset };
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
    if (engine.entryMode !== "manual" || inTrade) setStrikeMenuOpen(false);
  }, [engine.entryMode, inTrade]);

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
  const huntPick = !inTrade
    ? engine.entryMode === "manual"
      ? pickManualStrike(rows, engine.optionType, liveAtm, chainStep, engine.manualStrikeOffset)
      : pickNear100(rows, engine.optionType)
    : null;
  const nearest = closestTo100(rows, engine.optionType);
  const avg = avgFill(engine.slots);
  const lotsOpen = openLots(engine.slots);
  const mtm = openMtm(avg, liveLtp, lotsOpen);
  const gridOn = Boolean((inTrade || engine.awaitReload) && engine.t1Fill != null && engine.t1Fill > 0);
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
  const t2AddPx = gridFill != null ? addLevel(gridFill, 2) : null;
  const t2BookPx = gridFill != null ? bookLevel(gridFill, 2) : null;
  const primaryLabel = engine.awaitRestart ? "START AGAIN" : "START";

  const huntIid = huntPick ? resolveIid(chain, huntPick.strike, huntPick.optionType) : null;
  const huntLive = liveTapePx(huntIid, ltps) ?? huntPick?.ltp ?? null;

  const reloadIid =
    engine.awaitReload && engine.strike != null
      ? resolveIid(chain, engine.strike, engine.optionType)
      : null;
  const bookLtp = liveTapePx(iid ?? reloadIid, ltps);

  const statusNote = !nifty
    ? "NIFTY only — switch index"
    : engine.awaitRestart
      ? "Await Restart — press START AGAIN to hunt a new ~100"
      : engine.awaitReload
        ? engine.armed
          ? `Hard SL flat — reload ${engine.strike ?? ""} ${engine.optionType} when LTP < ${fmtPrice(hardSlPx)}`
          : `Hard SL flat — paused. START reloads under ${fmtPrice(hardSlPx)}`
      : inTrade && engine.armed
        ? "In Trade · adds on +3 · books on −3"
        : inTrade
          ? "In Trade · paused (exits still live)"
          : engine.armed
            ? engine.entryMode === "manual"
              ? `Armed · Manual ${manualStrikeLabel(engine.manualStrikeOffset)} · ${windowLabel(clockMs)}`
              : `Armed · ${windowLabel(clockMs)}`
            : engine.entryMode === "manual"
              ? `Idle · Manual ${manualStrikeLabel(engine.manualStrikeOffset)}`
              : "Idle";

  return (
    <div className="flex flex-1 min-h-0 min-w-0 flex-col overflow-hidden text-[11px] ramsetu-glass-panel">
      <div className="shrink-0 ramsetu-glass-toolbar nl-toolbar">
        <div className="flex flex-wrap items-center gap-2">
          <span className={`nl-chip${engine.armed ? " nl-chip--on" : ""}`}>Armed</span>
          <span className={`nl-chip${engine.awaitRestart ? " nl-chip--wait" : ""}`}>Await Restart</span>
          <span className={`nl-chip${inTrade ? " nl-chip--trade" : ""}`}>In Trade</span>
          <span className="text-muted-foreground font-semibold">{statusNote}</span>
        </div>

        <div className="mt-2 flex flex-wrap items-end gap-3">
          <div className="flex flex-col gap-1">
            <span className="ramsetu-glass-toolbar__label">Side</span>
            <div className="nl-toggle">
              {(["CE", "PE"] as const).map((side) => (
                <button
                  key={side}
                  type="button"
                  disabled={inTrade || engine.awaitReload}
                  onClick={() => setSide(side)}
                  className={`nl-toggle__btn${engine.optionType === side ? " nl-toggle__btn--on" : ""}${
                    side === "PE" ? " nl-toggle__btn--pe" : ""
                  }`}
                >
                  {side}
                </button>
              ))}
            </div>
          </div>

          <div className="flex flex-col gap-1">
            <span className="ramsetu-glass-toolbar__label">Size</span>
            <div className="nl-toggle">
              {SIZE_MULTS.map((m) => (
                <button
                  key={m}
                  type="button"
                  disabled={inTrade || engine.awaitReload}
                  onClick={() => setMult(m)}
                  className={`nl-toggle__btn${engine.sizeMult === m ? " nl-toggle__btn--on" : ""}`}
                >
                  {m}x
                </button>
              ))}
            </div>
          </div>

          <div className="flex flex-col gap-1">
            <span className="ramsetu-glass-toolbar__label">Entry</span>
            <div className="nl-toggle">
              {(["auto", "manual"] as const).map((mode) => (
                <button
                  key={mode}
                  type="button"
                  disabled={inTrade || engine.awaitReload}
                  onClick={() => setEntryMode(mode)}
                  className={`nl-toggle__btn${engine.entryMode === mode ? " nl-toggle__btn--on" : ""}`}
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
                  disabled={inTrade || engine.awaitReload}
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
              className={engine.awaitRestart ? "nl-btn-again" : "ramsetu-glass-exec min-w-[88px]"}
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
              disabled={busy || (!inTrade && !engine.awaitReload)}
              onClick={squareAll}
              className="ramsetu-glass-stop"
            >
              SQUARE ALL
            </button>
            <button
              type="button"
              disabled={busy}
              onClick={reset}
              className="nl-btn-reset"
              title="Clear this ladder UI only — does not square XTS"
            >
              RESET
            </button>
          </div>
        </div>
      </div>

      <div className="ramsetu-glass-table-wrap flex flex-col gap-3">
        {!nifty && (
          <div className="ramsetu-glass-empty">
            Nifty Ladder trades NIFTY options only. Switch the top index to NIFTY.
          </div>
        )}

        <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
          <button
            type="button"
            disabled={inTrade || engine.awaitReload || !drive.suggest}
            onClick={() => drive.suggest && setSide(drive.suggest)}
            className={`ramsetu-glass-card ramsetu-glass-card--center nl-drive${
              drive.bias === "UP" ? " nl-drive--up" : drive.bias === "DOWN" ? " nl-drive--down" : ""
            }`}
            title="Hint only — click to set CE/PE if not in trade"
          >
            <div className="ramsetu-glass-card__badge">09:15 OPEN DRIVE</div>
            <div className="ramsetu-glass-card__strike tabular-nums">
              {drive.bias ?? (drive.closed ? "—" : "Wait 09:16")}
            </div>
            <div className="ramsetu-glass-card__rule">
              {drive.suggest ? `Suggest ${drive.suggest}` : drive.error || "Hint only · not auto-entry"}
            </div>
            {(drive.open != null || drive.close != null) && (
              <div className="text-[10px] text-muted-foreground mt-1 tabular-nums">
                O {fmtPrice(drive.open)} → C {fmtPrice(drive.close)}
              </div>
            )}
          </button>

          <div className="ramsetu-glass-card ramsetu-glass-card--center">
            <div className="ramsetu-glass-card__badge">
              {engine.entryMode === "manual" ? "MANUAL PICK" : "HUNT PICK"} · {engine.optionType}
            </div>
            <div
              className={`ramsetu-glass-card__strike tabular-nums ${
                engine.optionType === "PE" ? "ramsetu-glass-card__strike--pe" : "text-cd-green"
              }`}
            >
              {(inTrade || engine.awaitReload) && engine.strike != null
                ? `${engine.strike.toLocaleString("en-IN")} ${engine.optionType}`
                : huntPick
                  ? `${huntPick.strike.toLocaleString("en-IN")} ${engine.optionType}`
                  : "—"}
            </div>
            <div className="ramsetu-glass-card__rule">
              {engine.awaitReload
                ? `Same strike · reload only if LTP < ${fmtPrice(hardSlPx)}`
                : inTrade
                ? "Strike locked"
                : engine.entryMode === "manual"
                  ? huntPick
                    ? `LIVE ${fmtPrice(huntLive)} · ${manualStrikeLabel(engine.manualStrikeOffset)} · no band`
                    : `Waiting print · ${manualStrikeLabel(engine.manualStrikeOffset)} ${engine.optionType}`
                  : huntPick
                    ? `LIVE ${fmtPrice(huntLive)} · band ${BAND_LOW}–${BAND_HIGH}`
                    : nearest
                      ? `Nearest ${nearest.strike} @ ${fmtPrice(nearest.ltp)} (outside band)`
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
            <div className="ramsetu-glass-card__badge">T1 FILL</div>
            <div className="ramsetu-glass-card__strike tabular-nums">
              {gridFill != null ? fmtPrice(gridFill) : "—"}
            </div>
            <div className="ramsetu-glass-card__rule">
              {gridFill != null
                ? `T2 add ${fmtPrice(t2AddPx)} · book ${fmtPrice(t2BookPx)} · hard SL ${fmtPrice(hardSlPx)}`
                : `Cover −30% · Hard SL +30%`}
            </div>
          </div>

          <div className="ramsetu-glass-card ramsetu-glass-card--center">
            <div className="ramsetu-glass-card__badge">LIVE</div>
            <div className="ramsetu-glass-card__strike tabular-nums">{fmtPrice(inTrade || engine.awaitReload ? bookLtp : huntLive)}</div>
            <div
              className={`ramsetu-glass-card__rule ${
                mtm != null && mtm >= 0 ? "text-cd-green" : mtm != null ? "ramsetu-glass-table__strike--pe" : ""
              }`}
            >
              MTM {fmtPnl(mtm ?? 0)} · {lotsOpen} lots · Lot {LOT_SIZE}
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
        </div>

        <div className="nl-blocks overflow-auto">
          {engine.slots.map((s) => {
            const addPx = gridFill != null ? addLevel(gridFill, s.index) : null;
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
            return (
              <div key={s.index} className={`nl-block${s.open ? " nl-block--open" : ""}`}>
                <div className="nl-block__top">
                  <span className="nl-block__tranche">T{s.index}</span>
                  <span className={s.open ? "nl-block__status nl-block__status--open" : "nl-block__status"}>
                    {s.open ? "Open" : "Empty"}
                  </span>
                </div>
                <div className="nl-block__grid">
                  <div className="nl-block__cell">
                    <span className="nl-block__label">Lots</span>
                    <span className="nl-block__num">{s.lots}</span>
                  </div>
                  <div className="nl-block__cell">
                    <span className="nl-block__label">Add</span>
                    <span className="nl-block__num">{addVal}</span>
                  </div>
                  <div className="nl-block__cell">
                    <span className="nl-block__label">{s.index === 1 ? "Book" : "Exit"}</span>
                    <span className="nl-block__num">{fmtPrice(bookPx)}</span>
                  </div>
                  <div className="nl-block__cell">
                    <span className="nl-block__label">Fill</span>
                    <span className="nl-block__num">
                      {s.open ? fmtPrice(s.fill) : "—"}
                    </span>
                  </div>
                </div>
              </div>
            );
          })}
        </div>

        <div className="min-h-0 flex-1 overflow-auto">
          <div className="ramsetu-glass-toolbar__label mb-2">Log</div>
          {!logs.length ? (
            <p className="ramsetu-glass-empty text-[12px]">
              START dabao — Auto: 09:16 ke baad ~{BAND_TARGET} premium band hunt. Manual: ATM−3…ATM+3
              pe direct entry (band skip). Same strike ladder, extras +3, book −3, T1 −30% / hard SL +30%,
              flatten 15:15.
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
