import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { peekLiveTick, useLiveLtp } from "@/context/LiveLtpContext";
import { apiFetch } from "@/lib/backend";
import {
  CD,
  CD_DEFAULTS,
  EMPTY_LOG,
  atmStrike,
  breakout,
  closeScore,
  coerceSettings,
  dayStopHit,
  decideExit,
  draftFromSettings,
  entrySide,
  firstEntryLabel,
  formatSaved,
  fmtScore,
  insideRange,
  istParts,
  isUnsaved,
  nearestThursdayExpiry,
  orderQty,
  pastCutoff,
  roundScore,
  squareTime,
  stopPx,
  targetPx,
  trailArmPx,
  trailStopPx,
  validateCdDraft,
  waitInsideAfter,
  badPremiumTick,
  shortMtm,
  signedPts,
  type CdDraft,
  type CdRangePayload,
  type CdSettings,
  type CloseLabel,
  type LogKind,
  type OptionSide,
} from "@/lib/cdRangeRules";
import { fmtPrice, fmtQty } from "@/lib/formatNumber";
import { bumpPositionsRefresh, clearLocalPosition, setLocalShortPosition } from "@/lib/ixPortfolio";
import { liveTapeLtp } from "@/lib/liveQuote";
import { useSubscribeTouchline } from "@/lib/mdRegistry";
import type { ChainExpiriesResponse, ChainResolveResponse, ChainResolved } from "@/types/market";
import { xtsOrderFillPx } from "@/lib/xtsOrder";

type CdPosition = {
  instrumentId: number;
  strike: number;
  optionType: OptionSide;
  qty: number;
  fillPx: number;
  segment: number;
  trailArmed: boolean;
};

type CdLog = { id: number; text: string; kind: LogKind };

type CdSession = {
  v: 2;
  sessionDate: string;
  settings: CdSettings;
  draft: CdDraft;
  running: boolean;
  position: CdPosition | null;
  logs: CdLog[];
  nextLogId: number;
  score: number;
  squared: boolean;
  needInside: boolean;
  seenInside: boolean;
  sellRetryAt: number;
};

type LegacySession = {
  v?: number;
  sessionDate?: string;
  lots?: string;
  running?: boolean;
  position?: CdPosition | null;
  logs?: CdLog[];
  nextLogId?: number;
  score?: number;
  squared?: boolean;
  needInside?: boolean;
  seenInside?: boolean;
  sellRetryAt?: number;
  settings?: CdSettings;
  draft?: CdDraft;
};

const MAX_LOG = 80;
const GUARD_MS = 200;
const COVER_RETRY_MS = 1_000;

function readStore(key: string): LegacySession | null {
  try {
    const raw = sessionStorage.getItem(key);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as LegacySession;
    return parsed && typeof parsed === "object" ? parsed : null;
  } catch {
    return null;
  }
}

function loadSession(): CdSession | null {
  const today = istParts().date;
  const current = readStore(CD.storeKey);
  if (current?.v === 2 && current.sessionDate === today && current.settings && current.draft) {
    const settings = coerceSettings(current.settings);
    return {
      v: 2,
      sessionDate: today,
      settings,
      draft: current.draft,
      running: current.running === true,
      position: current.position ?? null,
      logs: Array.isArray(current.logs) ? current.logs : [],
      nextLogId: current.nextLogId || 1,
      score: typeof current.score === "number" ? current.score : 0,
      squared: current.squared === true,
      needInside: current.needInside === true,
      seenInside: current.seenInside === true,
      sellRetryAt: current.sellRetryAt || 0,
    };
  }
  const old = readStore(CD.legacyStoreKey);
  if (!old || old.sessionDate !== today) return null;
  const settings = CD_DEFAULTS;
  return {
    v: 2,
    sessionDate: today,
    settings,
    draft: draftFromSettings(settings),
    running: old.running === true,
    position: old.position ?? null,
    logs: Array.isArray(old.logs) ? old.logs : [],
    nextLogId: old.nextLogId || 1,
    score: typeof old.score === "number" ? old.score : 0,
    squared: old.squared === true,
    needInside: old.needInside === true,
    seenInside: old.seenInside === true,
    sellRetryAt: old.sellRetryAt || 0,
  };
}

function premiumOf(iid: number | null, ltps: Record<number, number>): number | null {
  if (iid == null) return null;
  const tick = peekLiveTick(iid);
  if (tick?.ltp && tick.ltp >= 0.01 && tick.ltp <= 1_000_000) return tick.ltp;
  return liveTapeLtp(iid, ltps);
}

type OrderResult = { ok: true; filledQty: number; fill: number } | { ok: false; error: string };

export default function CdRangePanel({
  chain,
  active = true,
}: {
  chain: ChainResolved;
  active?: boolean;
}) {
  const restored = useRef(loadSession());
  const initialSettings = restored.current?.settings ?? CD_DEFAULTS;
  const onIndex = String(chain.index || "").trim().toUpperCase() === CD.underlying;
  const ltps = useLiveLtp();

  const [live, setLive] = useState<CdSettings>(initialSettings);
  const [draft, setDraft] = useState<CdDraft>(restored.current?.draft ?? draftFromSettings(initialSettings));
  const [running, setRunning] = useState(restored.current?.running ?? false);
  const [position, setPosition] = useState<CdPosition | null>(restored.current?.position ?? null);
  const [logs, setLogs] = useState<CdLog[]>(restored.current?.logs ?? []);
  const [score, setScore] = useState(restored.current?.score ?? 0);
  const [squared, setSquared] = useState(restored.current?.squared ?? false);
  const [needInside, setNeedInside] = useState(restored.current?.needInside ?? false);
  const [seenInside, setSeenInside] = useState(restored.current?.seenInside ?? false);
  const [range, setRange] = useState<CdRangePayload | null>(null);
  const [busy, setBusy] = useState(false);
  const [clock, setClock] = useState(() => istParts());
  const [book, setBook] = useState<ChainResolved | null>(null);
  const [expiryLabel, setExpiryLabel] = useState("");

  const logIdRef = useRef(restored.current?.nextLogId ?? 1);
  const posRef = useRef(position);
  const busyRef = useRef(false);
  const chainRef = useRef(chain);
  const bookRef = useRef<ChainResolved | null>(book);
  const ltpsRef = useRef(ltps);
  const liveRef = useRef(live);
  const runningRef = useRef(running);
  const scoreRef = useRef(score);
  const squaredRef = useRef(squared);
  const needInsideRef = useRef(needInside);
  const seenInsideRef = useRef(seenInside);
  const rangeRef = useRef(range);
  const liveSpotRef = useRef<number | null>(null);
  const sellRetryRef = useRef(restored.current?.sellRetryAt ?? 0);
  const coverRetryRef = useRef(0);
  const sessionDateRef = useRef(restored.current?.sessionDate ?? istParts().date);
  const levelKeyRef = useRef("");
  const expiryNoteRef = useRef("");

  posRef.current = position;
  chainRef.current = chain;
  bookRef.current = book;
  ltpsRef.current = ltps;
  liveRef.current = live;
  runningRef.current = running;
  scoreRef.current = score;
  squaredRef.current = squared;
  needInsideRef.current = needInside;
  seenInsideRef.current = seenInside;
  rangeRef.current = range;

  const liveSpot =
    typeof ltps[chain.spotToken] === "number" && ltps[chain.spotToken]! > 0 ? ltps[chain.spotToken]! : null;
  liveSpotRef.current = liveSpot;

  const step = CD.strikeStep;
  const bookMap = book?.instrumentMap;
  const atm = atmStrike(liveSpot && liveSpot > 0 ? liveSpot : chain.spotLtp || chain.atmStrike, step);
  const ceIid = bookMap?.[String(atm)]?.ce ?? null;
  const peIid = bookMap?.[String(atm)]?.pe ?? null;
  const cePx = premiumOf(typeof ceIid === "number" ? ceIid : null, ltps);
  const pePx = premiumOf(typeof peIid === "number" ? peIid : null, ltps);
  const qty = orderQty(live.lots);
  const signal = breakout(liveSpot, range?.high, range?.low, live.extra);
  const unsaved = isUnsaved(draft, live);
  const firstEntry = firstEntryLabel(live.candles, live.tfMin);

  const watchIds = useMemo(() => {
    const ids: number[] = [];
    if (position?.instrumentId) ids.push(position.instrumentId);
    if (active || running) {
      if (typeof ceIid === "number" && ceIid > 0) ids.push(ceIid);
      if (typeof peIid === "number" && peIid > 0) ids.push(peIid);
    }
    return Array.from(new Set(ids));
  }, [active, ceIid, peIid, position?.instrumentId, running]);

  useSubscribeTouchline(book?.optionSegment || chain.optionSegment, watchIds);
  useSubscribeTouchline(chain.spotSegment, chain.spotToken > 0 ? [chain.spotToken] : []);

  const pushLog = useCallback((text: string, kind: LogKind) => {
    const id = logIdRef.current++;
    const stamp = `${String(istParts().hh).padStart(2, "0")}:${String(istParts().mm).padStart(2, "0")}:${String(istParts().ss).padStart(2, "0")}`;
    setLogs((prev) => [{ id, text: `${stamp}  ${text}`, kind }, ...prev].slice(0, MAX_LOG));
  }, []);

  const remember = useCallback((pos: CdPosition) => {
    posRef.current = pos;
    setPosition(pos);
    setLocalShortPosition({
      exchangeInstrumentID: pos.instrumentId,
      exchangeSegment: pos.segment || bookRef.current?.optionSegment || chainRef.current.optionSegment,
      qty: pos.qty,
      fillPx: pos.fillPx,
      tradingSymbol: `SENSEX ${pos.strike} ${pos.optionType}`,
      productType: "NRML",
    });
  }, []);

  const forget = useCallback((instrumentId: number) => {
    posRef.current = null;
    setPosition(null);
    clearLocalPosition(instrumentId);
  }, []);

  useEffect(() => {
    const row: CdSession = {
      v: 2,
      sessionDate: sessionDateRef.current,
      settings: live,
      draft,
      running,
      position,
      logs,
      nextLogId: logIdRef.current,
      score,
      squared,
      needInside,
      seenInside,
      sellRetryAt: sellRetryRef.current,
    };
    try {
      sessionStorage.setItem(CD.storeKey, JSON.stringify(row));
    } catch {
      /* ignore */
    }
  }, [draft, live, logs, needInside, position, running, score, seenInside, squared]);

  useEffect(() => {
    const pos = restored.current?.position;
    if (!pos) return;
    setLocalShortPosition({
      exchangeInstrumentID: pos.instrumentId,
      exchangeSegment: pos.segment || chain.optionSegment,
      qty: pos.qty,
      fillPx: pos.fillPx,
      tradingSymbol: `SENSEX ${pos.strike} ${pos.optionType}`,
      productType: "NRML",
    });
  }, [chain.optionSegment]);

  useEffect(() => {
    if (!onIndex) return;
    let stop = false;
    const pull = async () => {
      const saved = liveRef.current;
      const query = new URLSearchParams({
        tf: String(saved.tfMin),
        candles: String(saved.candles),
        minGap: String(saved.minGap),
      });
      try {
        const raw = (await apiFetch(`${CD.apiPath}?${query.toString()}`)) as CdRangePayload;
        if (!stop) setRange(raw);
      } catch (err) {
        if (!stop) {
          setRange({
            ok: false,
            ready: false,
            tradable: false,
            error: err instanceof Error ? err.message : "Sensex range fetch failed",
          });
        }
      }
    };
    void pull();
    const timer = window.setInterval(() => void pull(), 3_000);
    return () => {
      stop = true;
      window.clearInterval(timer);
    };
  }, [live.candles, live.minGap, live.tfMin, onIndex]);

  useEffect(() => {
    if (!onIndex) {
      setBook(null);
      setExpiryLabel("");
      return;
    }
    let stop = false;
    const run = async () => {
      try {
        const raw = (await apiFetch("/api/chain/expiries", {
          method: "POST",
          body: JSON.stringify({ index: CD.underlying }),
        })) as ChainExpiriesResponse;
        if (stop) return;
        if (!raw.ok || !raw.expiries?.length) {
          setBook(null);
          setExpiryLabel("");
          const note = !raw.ok ? raw.error || "Expiry list failed." : "No SENSEX expiry returned.";
          if (expiryNoteRef.current !== note) {
            expiryNoteRef.current = note;
            pushLog(note, "error");
          }
          return;
        }
        const picked = nearestThursdayExpiry(raw.expiries);
        if (!picked) {
          setBook(null);
          setExpiryLabel("");
          const note = "No Thursday expiry after today. No entry.";
          if (expiryNoteRef.current !== note) {
            expiryNoteRef.current = note;
            pushLog(note, "error");
          }
          return;
        }
        expiryNoteRef.current = "";
        setExpiryLabel(picked.label);
        const parent = chainRef.current;
        const parentRow = raw.expiries.find((row) => row.api === parent.expiryApi);
        if (parentRow?.label === picked.label && String(parent.index || "").trim().toUpperCase() === CD.underlying) {
          setBook(parent);
          return;
        }
        const resolved = (await apiFetch("/api/chain/resolve", {
          method: "POST",
          body: JSON.stringify({
            index: CD.underlying,
            expiry: picked.api,
            wings: parent.chainWings || 45,
          }),
        })) as ChainResolveResponse;
        if (stop) return;
        if (!resolved.ok) {
          setBook(null);
          const note = resolved.error || "CD expiry resolve failed.";
          if (expiryNoteRef.current !== note) {
            expiryNoteRef.current = note;
            pushLog(note, "error");
          }
          return;
        }
        setBook(resolved);
      } catch (err) {
        if (stop) return;
        setBook(null);
        const note = err instanceof Error ? err.message : "CD expiry resolve failed.";
        if (expiryNoteRef.current !== note) {
          expiryNoteRef.current = note;
          pushLog(note, "error");
        }
      }
    };
    void run();
    return () => {
      stop = true;
    };
  }, [chain.expiryApi, chain.index, onIndex, pushLog]);

  useEffect(() => {
    const key =
      range?.high != null && range.low != null ? `${range.high}|${range.low}` : "";
    if (levelKeyRef.current && key && levelKeyRef.current !== key) {
      const stillInside = insideRange(liveSpotRef.current, range?.high, range?.low);
      seenInsideRef.current = stillInside;
      setSeenInside(stillInside);
    }
    if (key) levelKeyRef.current = key;
  }, [range?.high, range?.low]);

  useEffect(() => {
    if (!onIndex) return;
    const instruments = [
      ...(chain.spotToken > 0 ? [{ exchangeSegment: chain.spotSegment, exchangeInstrumentID: chain.spotToken }] : []),
      ...watchIds.map((id) => ({
        exchangeSegment: book?.optionSegment || chain.optionSegment,
        exchangeInstrumentID: id,
      })),
    ];
    void apiFetch("/api/md/focus", {
      method: "POST",
      body: JSON.stringify({ channel: CD.focusChannel, instruments }),
    }).catch(() => {});
  }, [book?.optionSegment, chain.optionSegment, chain.spotSegment, chain.spotToken, onIndex, watchIds]);

  const sendOrder = useCallback(async (sideOrder: "BUY" | "SELL", instrumentId: number, orderQuantity: number): Promise<OrderResult> => {
    const tick = peekLiveTick(instrumentId);
    const ltp = tick?.ltp && tick.ltp > 0 ? tick.ltp : liveTapeLtp(instrumentId, ltpsRef.current);
    if (!(typeof ltp === "number" && ltp > 0)) return { ok: false, error: "No option price" };
    const segment = bookRef.current?.optionSegment || chainRef.current.optionSegment;
    try {
      const r = (await apiFetch("/api/ix/place_order", {
        method: "POST",
        body: JSON.stringify({
          orderType: "MARKET",
          productType: "NRML",
          timeInForce: "EOS",
          apiOrderSource: "WEBAPI",
          disclosedQuantity: 0,
          limitPrice: 0,
          stopPrice: 0,
          bookOnlyIfFilled: true,
          ltp,
          ...(typeof tick?.bid === "number" && tick.bid > 0 ? { bid: tick.bid } : {}),
          ...(typeof tick?.ask === "number" && tick.ask > 0 ? { ask: tick.ask } : {}),
          exchangeSegment: segment,
          exchangeInstrumentID: instrumentId,
          orderSide: sideOrder,
          orderQuantity,
        }),
      })) as { ok?: boolean; error?: string; filledQty?: number; raw?: unknown; fillHint?: { ltp?: number } };
      bumpPositionsRefresh();
      if (r?.ok !== true) return { ok: false, error: r?.error || "Order not filled" };
      const filledQty = typeof r.filledQty === "number" && r.filledQty > 0 ? Math.floor(r.filledQty) : 0;
      const broker = xtsOrderFillPx(r.raw);
      const hinted = typeof r.fillHint?.ltp === "number" && r.fillHint.ltp > 0 ? r.fillHint.ltp : 0;
      const fill = broker || hinted || ltp;
      if (!(filledQty > 0) || !(fill > 0)) {
        return { ok: false, error: filledQty > 0 ? "XTS fill price missing. Book unchanged." : r.error || "Order not filled" };
      }
      return { ok: true, filledQty: Math.min(orderQuantity, filledQty), fill };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : "Order failed" };
    }
  }, []);

  const pickSide = useCallback((optionType: OptionSide) => {
    const ch = bookRef.current;
    const spot = liveSpotRef.current;
    if (!ch || !(spot && spot > 0)) return null;
    const strike = atmStrike(spot, CD.strikeStep);
    const row = ch.instrumentMap[String(strike)];
    const iid = optionType === "CE" ? row?.ce : row?.pe;
    if (typeof iid !== "number" || !(iid > 0)) return null;
    return { strike, instrumentId: iid, segment: ch.optionSegment };
  }, []);

  const markScore = useCallback(
    (label: CloseLabel, sold: number, cover: number) => {
      const delta = closeScore(label, sold, cover, liveRef.current.targetPct);
      const net = roundScore(scoreRef.current + delta);
      scoreRef.current = net;
      setScore(net);
      if (waitInsideAfter(label)) {
        const spot = liveSpotRef.current;
        const box = rangeRef.current;
        const inside = insideRange(spot, box?.high, box?.low);
        needInsideRef.current = true;
        seenInsideRef.current = inside;
        setNeedInside(true);
        setSeenInside(inside);
      }
      if (dayStopHit(net)) {
        pushLog(`Day stop ${fmtScore(net)}. No new entry and no flip. The open short can still exit.`, "info");
      }
      return { delta, net };
    },
    [pushLog],
  );

  const sellSide = useCallback(
    async (optionType: OptionSide, reason: "ENTRY" | "FLIP") => {
      const spot = liveSpotRef.current;
      const box = rangeRef.current;
      const saved = liveRef.current;
      const order = orderQty(saved.lots);
      const picked = pickSide(optionType);
      if (!picked || !(spot && spot > 0) || order == null || box?.high == null || box.low == null) {
        sellRetryRef.current = Date.now() + CD.sellRetryMs;
        pushLog("Sell not sent. Spot, the Thursday expiry, the range, and lots 1–50 are required. Retry in 60s.", "error");
        return false;
      }
      if (breakout(spot, box.high, box.low, saved.extra) !== optionType) {
        pushLog("Sell skipped. Spot is no longer through the range.", "info");
        return false;
      }
      const sold = await sendOrder("SELL", picked.instrumentId, order);
      if (!sold.ok) {
        sellRetryRef.current = Date.now() + CD.sellRetryMs;
        pushLog(`SELL not filled. Retry in 60s. ${sold.error}`, "error");
        return false;
      }
      sellRetryRef.current = 0;
      const level = optionType === "PE" ? box.high : box.low;
      const word = optionType === "PE" ? "above HIGH" : "below LOW";
      remember({
        instrumentId: picked.instrumentId,
        strike: picked.strike,
        optionType,
        qty: sold.filledQty,
        fillPx: sold.fill,
        segment: picked.segment,
        trailArmed: false,
      });
      pushLog(
        `spot ${spot.toFixed(2)} ${word} ${level.toFixed(2)}: SELL ATM ${optionType} ${picked.strike.toLocaleString("en-IN")} × ${fmtQty(sold.filledQty)} @ ${sold.fill.toFixed(2)}${reason === "FLIP" ? " · flip" : ""}`,
        "entry",
      );
      return true;
    },
    [pickSide, pushLog, remember, sendOrder],
  );

  const coverPos = useCallback(
    async (label: CloseLabel, flipNext: OptionSide | null) => {
      const pos = posRef.current;
      if (!pos) return;
      const bought = await sendOrder("BUY", pos.instrumentId, pos.qty);
      if (!bought.ok) {
        coverRetryRef.current = Date.now() + COVER_RETRY_MS;
        pushLog(`${label} cover not filled. Short still open. ${bought.error}`, "error");
        return;
      }
      const left = pos.qty - bought.filledQty;
      if (left > 0) {
        remember({ ...pos, qty: left });
        coverRetryRef.current = Date.now() + COVER_RETRY_MS;
        pushLog(
          `BUY ${label} partial ${pos.optionType} ${pos.strike.toLocaleString("en-IN")} × ${fmtQty(bought.filledQty)} @ ${bought.fill.toFixed(2)} · left ${fmtQty(left)}`,
          "exit",
        );
        return;
      }
      forget(pos.instrumentId);
      const scored = markScore(label, pos.fillPx, bought.fill);
      pushLog(
        `BUY ${label} ${pos.optionType} ${pos.strike.toLocaleString("en-IN")} × ${fmtQty(bought.filledQty)} @ ${bought.fill.toFixed(2)} · score ${fmtScore(scored.delta)} · net ${fmtScore(scored.net)}`,
        "exit",
      );
      if (label !== "OPPOSITE" || !flipNext) return;
      const clockNow = istParts();
      const box = rangeRef.current;
      if (
        !runningRef.current ||
        squaredRef.current ||
        dayStopHit(scored.net) ||
        pastCutoff(clockNow.hh, clockNow.mm) ||
        box?.tradable !== true
      ) {
        pushLog("Opposite break covered. Flip not sent.", "info");
        return;
      }
      await sellSide(flipNext, "FLIP");
    },
    [forget, markScore, pushLog, remember, sellSide, sendOrder],
  );

  useEffect(() => {
    if (!onIndex) return;
    const timer = window.setInterval(() => {
      setClock(istParts());
      if (busyRef.current || Date.now() < coverRetryRef.current) return;
      const today = istParts();
      if (sessionDateRef.current !== today.date) {
        sessionDateRef.current = today.date;
        runningRef.current = false;
        setRunning(false);
        scoreRef.current = 0;
        setScore(0);
        squaredRef.current = false;
        setSquared(false);
        needInsideRef.current = false;
        seenInsideRef.current = false;
        setNeedInside(false);
        setSeenInside(false);
        sellRetryRef.current = 0;
        const stale = posRef.current;
        if (stale) forget(stale.instrumentId);
        pushLog("New session. START to hunt.", "info");
        return;
      }
      if (squareTime(today.hh, today.mm) && !squaredRef.current && !posRef.current) {
        squaredRef.current = true;
        setSquared(true);
        pushLog("15:14 square-off. No more orders today.", "info");
      }
      const box = rangeRef.current;
      const spot = liveSpotRef.current;
      if (insideRange(spot, box?.high, box?.low)) {
        if (!seenInsideRef.current) {
          seenInsideRef.current = true;
          setSeenInside(true);
        }
      }
      const pos = posRef.current;
      const cooling = Date.now() < sellRetryRef.current;
      const stopped = dayStopHit(scoreRef.current);
      const hunting =
        runningRef.current && !squaredRef.current && !squareTime(today.hh, today.mm) && !stopped && !cooling;
      if (!pos) {
        const side = entrySide({
          hh: today.hh,
          mm: today.mm,
          spot,
          high: box?.high ?? null,
          low: box?.low ?? null,
          tradable: box?.tradable === true && bookRef.current != null,
          hunting,
          needInside: needInsideRef.current,
          seenInside: seenInsideRef.current,
          extra: liveRef.current.extra,
        });
        if (!side) return;
        busyRef.current = true;
        setBusy(true);
        void sellSide(side, "ENTRY").finally(() => {
          busyRef.current = false;
          setBusy(false);
        });
        return;
      }
      let ltp = premiumOf(pos.instrumentId, ltpsRef.current);
      if (ltp != null && badPremiumTick(pos.fillPx, ltp)) ltp = null;
      const exit = decideExit({
        hh: today.hh,
        mm: today.mm,
        spot,
        high: box?.high ?? null,
        low: box?.low ?? null,
        mid: box?.mid ?? null,
        tradable: box?.tradable === true,
        side: pos.optionType,
        sold: pos.fillPx,
        ltp,
        trailArmed: pos.trailArmed,
        canFlip: hunting && bookRef.current != null,
        midOn: liveRef.current.midStop,
        extra: liveRef.current.extra,
        slPct: liveRef.current.slPct,
        trailArmPct: liveRef.current.trailArmPct,
        trailLockPct: liveRef.current.trailLockPct,
        targetPct: liveRef.current.targetPct,
      });
      if (exit.kind === "NONE") {
        if (exit.armTrail && !pos.trailArmed) {
          remember({ ...pos, trailArmed: true });
          pushLog(
            `Trail armed at ${trailArmPx(pos.fillPx, liveRef.current.trailArmPct).toFixed(2)}. Cover if LTP comes back to ${trailStopPx(pos.fillPx, liveRef.current.trailLockPct).toFixed(2)}.`,
            "info",
          );
        }
        if (squareTime(today.hh, today.mm)) {
          squaredRef.current = true;
          setSquared(true);
        }
        return;
      }
      if (exit.kind === "SQUARE") {
        squaredRef.current = true;
        setSquared(true);
      }
      busyRef.current = true;
      setBusy(true);
      const flipNext = exit.kind === "OPPOSITE" && exit.flip ? exit.next : null;
      void coverPos(exit.kind, flipNext).finally(() => {
        busyRef.current = false;
        setBusy(false);
      });
    }, GUARD_MS);
    return () => window.clearInterval(timer);
  }, [coverPos, forget, onIndex, pushLog, remember, sellSide]);

  const start = () => {
    if (!onIndex) {
      pushLog(CD.onlyMessage, "error");
      return;
    }
    if (!bookRef.current) {
      pushLog("No Thursday expiry after today. No entry.", "error");
      return;
    }
    if (squaredRef.current || squareTime(istParts().hh, istParts().mm)) {
      pushLog("Square-off already passed. No more orders today.", "error");
      return;
    }
    if (dayStopHit(scoreRef.current)) {
      pushLog(`Day stop ${fmtScore(scoreRef.current)}. No new entry and no flip.`, "error");
      return;
    }
    runningRef.current = true;
    setRunning(true);
    const extra = liveRef.current.extra;
    const pad = extra > 0 ? ` + ${extra}` : "";
    const cut = extra > 0 ? ` − ${extra}` : "";
    pushLog(`Hunting. Spot above HIGH${pad} sells the ATM PE. Spot below LOW${cut} sells the ATM CE.`, "info");
  };

  const save = () => {
    const parsed = validateCdDraft(draft);
    if (!parsed.ok) {
      pushLog(parsed.reason, "error");
      return;
    }
    liveRef.current = parsed.settings;
    setLive(parsed.settings);
    setDraft(draftFromSettings(parsed.settings));
    pushLog(formatSaved(parsed.settings), "info");
  };

  const stopHunt = () => {
    runningRef.current = false;
    setRunning(false);
    pushLog("Hunt stopped. An open short still exits.", "info");
  };

  const squareNow = () => {
    const pos = posRef.current;
    if (!pos) {
      pushLog("SQUARE — no short is open.", "info");
      return;
    }
    if (busyRef.current) return;
    busyRef.current = true;
    setBusy(true);
    void coverPos("SQUARE", null).finally(() => {
      busyRef.current = false;
      setBusy(false);
    });
  };

  if (!onIndex) {
    return (
      <div className="nw-desk flex flex-1 items-center justify-center p-6 text-center text-[15px] font-semibold">
        {CD.onlyMessage}
      </div>
    );
  }

  const posPx = position ? premiumOf(position.instrumentId, ltps) : null;
  const mtm = position && posPx != null ? shortMtm(position.fillPx, posPx, position.qty) : null;
  const high = range?.high ?? null;
  const low = range?.low ?? null;
  const mid = range?.mid ?? null;
  const gap = range?.gap ?? null;
  const windowLabel =
    range?.firstBar && range.lastBar ? `${range.firstBar}–${range.lastBar}` : range?.error || `First entry ${firstEntry}`;
  const status = deskStatus({
    squared,
    score,
    ready: range?.ready === true,
    tradable: range?.tradable === true,
    position: position != null,
    trailArmed: position?.trailArmed === true,
    running,
    hh: clock.hh,
    mm: clock.mm,
    needInside,
    seenInside,
    cooling: Date.now() < sellRetryRef.current,
    expiryReady: book != null,
    firstEntry,
    minGap: live.minGap,
  });
  const above = live.extra > 0 ? `above HIGH + ${live.extra}` : "above HIGH";
  const below = live.extra > 0 ? `below LOW − ${live.extra}` : "below LOW";
  const trailText =
    live.trailLockPct === 0
      ? `trail arm ${live.trailArmPct}% then cover at the sell fill`
      : `trail arm ${live.trailArmPct}% then cover ${live.trailLockPct}% under the sell`;
  const idleRule = `${live.candles} × ${live.tfMin}m · gap ${live.minGap} · extra ${live.extra} · Target ${live.targetPct}% · ${trailText} · SL ${live.slPct}% · MID ${live.midStop ? "on" : "off"} · no entry after 14:30 · square 15:14`;
  const openRule = position
    ? `Target ≤ ${targetPx(position.fillPx, live.targetPct).toFixed(2)} · trail arms ≤ ${trailArmPx(position.fillPx, live.trailArmPct).toFixed(2)} then covers ≥ ${trailStopPx(position.fillPx, live.trailLockPct).toFixed(2)} · SL ≥ ${stopPx(position.fillPx, live.slPct).toFixed(2)}`
    : idleRule;

  return (
    <div className="nw-desk flex min-h-0 flex-1 flex-col overflow-hidden">
      <div className="nw-stats shrink-0">
        <Stat tone="vwap" label="HIGH" value={high != null ? fmtPrice(high) : "—"} sub={windowLabel} />
        <Stat tone="vwap" label="LOW" value={low != null ? fmtPrice(low) : "—"} sub={gap != null ? `gap ${fmtPrice(gap)}` : "—"} />
        <Stat tone="spot" label="MID" value={mid != null ? fmtPrice(mid) : "—"} sub={live.midStop ? "stop on" : "stop off"} />
        <Stat
          tone={signal === "PE" ? "up" : signal === "CE" ? "down" : "spot"}
          label="Sensex"
          value={liveSpot != null ? fmtPrice(liveSpot) : "—"}
          sub={signal === "PE" ? above : signal === "CE" ? below : "inside / flat"}
        />
        <Stat
          tone={signal === "CE" ? "ce" : signal === "PE" ? "pe" : "flat"}
          label="Signal"
          value={signal === "PE" ? "Sell PE" : signal === "CE" ? "Sell CE" : "NO TRADE"}
          sub={status}
        />
        <Stat
          tone={score > 0 ? "up" : score < 0 ? "down" : "flat"}
          label="Day score"
          value={fmtScore(score)}
          sub={dayStopHit(score) ? "day stop" : `stop at ${CD.dayStop}`}
        />
      </div>

      <div className="nw-tools nw-tools--cd shrink-0">
        <div className="nw-settings">
          <DraftField label="Lots" value={draft.lots} onChange={(value) => setDraft((prev) => ({ ...prev, lots: value }))} />
          <DraftField label="TF min" value={draft.tfMin} onChange={(value) => setDraft((prev) => ({ ...prev, tfMin: value }))} />
          <DraftField label="Candles" value={draft.candles} onChange={(value) => setDraft((prev) => ({ ...prev, candles: value }))} />
          <DraftField label="Min gap" value={draft.minGap} onChange={(value) => setDraft((prev) => ({ ...prev, minGap: value }))} />
          <DraftField label="SL %" value={draft.slPct} onChange={(value) => setDraft((prev) => ({ ...prev, slPct: value }))} />
          <DraftField label="Trail arm %" value={draft.trailArmPct} onChange={(value) => setDraft((prev) => ({ ...prev, trailArmPct: value }))} />
          <DraftField label="Trail lock %" value={draft.trailLockPct} onChange={(value) => setDraft((prev) => ({ ...prev, trailLockPct: value }))} />
          <DraftField label="Extra" value={draft.extra} onChange={(value) => setDraft((prev) => ({ ...prev, extra: value }))} />
          <DraftField label="Target %" value={draft.targetPct} onChange={(value) => setDraft((prev) => ({ ...prev, targetPct: value }))} />
          <label className="nw-field">
            MID stop
            <select
              value={draft.midStop ? "on" : "off"}
              onChange={(e) => setDraft((prev) => ({ ...prev, midStop: e.target.value === "on" }))}
              className="sow-glass-input nw-input"
            >
              <option value="off">Off</option>
              <option value="on">On</option>
            </select>
          </label>
          <div className="nw-qty">{qty != null ? `Live ${live.lots} × ${CD.lotSize} = ${fmtQty(qty)}` : "Lots 1–50"}</div>
          <div className="nw-quotes">
            <span className="nw-quote">{expiryLabel ? `Expiry ${expiryLabel}` : "Expiry —"}</span>
            <span className={`nw-quote${signal === "CE" ? " nw-quote--on nw-quote--ce" : ""}`}>
              CE {atm.toLocaleString("en-IN")}
              {cePx != null ? ` @ ${cePx.toFixed(2)}` : ""}
            </span>
            <span className={`nw-quote${signal === "PE" ? " nw-quote--on nw-quote--pe" : ""}`}>
              PE {atm.toLocaleString("en-IN")}
              {pePx != null ? ` @ ${pePx.toFixed(2)}` : ""}
            </span>
          </div>
        </div>
        {unsaved ? <div className="nw-unsaved nw-warn-text">Unsaved. Save to apply.</div> : null}
        <div className="nw-rule text-[12px] font-semibold">{openRule}</div>
        <div className="nw-row nw-row--actions nw-row--cd-actions">
          <div className="nw-cd-actions-left">
            {running ? (
              <button type="button" disabled={busy} onClick={stopHunt} className="ramsetu-glass-stop min-w-[140px]">
                STOP
              </button>
            ) : (
              <button type="button" disabled={busy || squared || dayStopHit(score)} onClick={start} className="ramsetu-glass-exec min-w-[140px]">
                START
              </button>
            )}
            <button type="button" disabled={busy} onClick={squareNow} className="ramsetu-glass-stop">
              SQUARE ALL
            </button>
          </div>
          <button type="button" onClick={save} className="ramsetu-glass-exec min-w-[140px]">
            SAVE
          </button>
        </div>
      </div>

      <div className="nw-pos shrink-0 px-3 py-2">
        {!position ? (
          <div className="text-[15px] font-bold">Flat · {status}</div>
        ) : (
          <div className="flex flex-wrap items-baseline gap-x-4 gap-y-1 text-[12px]">
            <span className={`text-[18px] font-extrabold ${position.optionType === "CE" ? "nw-up" : "nw-down"}`}>
              {position.strike.toLocaleString("en-IN")} {position.optionType}
            </span>
            <span>Qty {fmtQty(position.qty)}</span>
            <span>Sold {position.fillPx.toFixed(2)}</span>
            {posPx != null && <span>LTP {posPx.toFixed(2)}</span>}
            {mtm != null && (
              <span className={`font-bold ${mtm >= 0 ? "nw-up" : "nw-down"}`}>MTM {signedPts(mtm)}</span>
            )}
            <span>{position.trailArmed ? "Trail armed" : "Trail idle"}</span>
          </div>
        )}
      </div>

      <div className="nw-log min-h-0 flex-1 overflow-auto px-3 py-2">
        <div className="mb-1 flex items-center justify-between">
          <span className="text-[11px] font-bold uppercase tracking-wide">Log</span>
          <button type="button" className="text-[11px] font-semibold" onClick={() => setLogs([])}>
            Clear
          </button>
        </div>
        {logs.length === 0 ? (
          <p className="nw-empty text-[13px] font-medium leading-relaxed">{EMPTY_LOG}</p>
        ) : (
          <ul className="space-y-1">
            {logs.map((line) => (
              <li
                key={line.id}
                className={`text-[11px] leading-snug ${
                  line.kind === "entry"
                    ? "nw-up"
                    : line.kind === "exit"
                      ? "nw-down"
                      : line.kind === "error"
                        ? "nw-warn-text"
                        : "text-muted-foreground"
                }`}
              >
                {line.text}
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}

function deskStatus(opts: {
  squared: boolean;
  score: number;
  ready: boolean;
  tradable: boolean;
  position: boolean;
  trailArmed: boolean;
  running: boolean;
  hh: number;
  mm: number;
  needInside: boolean;
  seenInside: boolean;
  cooling: boolean;
  expiryReady: boolean;
  firstEntry: string;
  minGap: number;
}): string {
  if (opts.squared || squareTime(opts.hh, opts.mm)) return "Squared — no more orders";
  if (dayStopHit(opts.score)) return "Day stop";
  if (!opts.expiryReady) return "Expiry";
  if (!opts.ready) return `Before ${opts.firstEntry}`;
  if (!opts.tradable) return `Gap under ${opts.minGap}`;
  if (opts.position) return opts.trailArmed ? "Short · trail armed" : "Short";
  if (!opts.running) return "Stopped";
  if (pastCutoff(opts.hh, opts.mm)) return "After 14:30";
  if (opts.needInside && !opts.seenInside) return "Wait inside";
  if (opts.cooling) return "Sell retry 60s";
  return "Hunting";
}

function DraftField({ label, value, onChange }: { label: string; value: string; onChange: (value: string) => void }) {
  return (
    <label className="nw-field">
      {label}
      <input value={value} onChange={(e) => onChange(e.target.value)} className="sow-glass-input nw-input" />
    </label>
  );
}

function Stat({
  label,
  value,
  sub,
  tone,
}: {
  label: string;
  value: string;
  sub: string;
  tone: "vwap" | "spot" | "up" | "down" | "ce" | "pe" | "flat";
}) {
  return (
    <div className={`nw-stat nw-stat--${tone}`}>
      <div className="nw-stat__label">{label}</div>
      <div className="nw-stat__value truncate tabular-nums">{value}</div>
      <div className="nw-stat__sub truncate">{sub}</div>
    </div>
  );
}
