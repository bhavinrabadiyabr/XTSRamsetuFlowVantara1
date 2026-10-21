import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { peekLiveTick, useLiveLtp } from "@/context/LiveLtpContext";
import { apiFetch } from "@/lib/backend";
import { fmtPrice, fmtQty } from "@/lib/formatNumber";
import { bumpPositionsRefresh, clearLocalPosition, setLocalShortPosition } from "@/lib/ixPortfolio";
import { liveAtmStrikeForChain } from "@/lib/liveAtmStrike";
import { liveTapeLtp } from "@/lib/liveQuote";
import { useSubscribeTouchline } from "@/lib/mdRegistry";
import {
  EMPTY_LOG,
  entryLog,
  fast1Desk,
  type Open0920Payload,
} from "@/lib/oneMinFastRules";
import {
  DEFAULT_TARGET,
  FLIP_RETRY_MS,
  GUARD_MS,
  MAX_LOG,
  SIZES,
  WINGS,
  averageFill,
  badPremiumTick,
  bookPx,
  loadVwapSession,
  lotQty,
  orderButtonText,
  parsePoints,
  profitPoints,
  saveVwapSession,
  sellStrike,
  shortMtm,
  signalLabel,
  signalSide,
  signedPts,
  sizedQty,
  slPriceHit,
  spotGap,
  targetHit,
  tradeSignal,
  wingStrikes,
  type LogKind,
  type OptionSide,
  type SizeMult,
  type VwapDesk,
  type VwapLog,
  type VwapPosition,
  type VwapSignal,
} from "@/lib/niftyVwapRules";
import type { ChainResolved } from "@/types/market";
import { XTS_IX_ORDER_BASE, ladderOrderPricing, xtsOrderFillPx } from "@/lib/xtsOrder";

function isDeskIndex(chain: ChainResolved, underlying: string): boolean {
  return String(chain.index || "").trim().toUpperCase() === underlying;
}

function premiumOf(iid: number | null, ltps: Record<number, number>): number | null {
  if (iid == null) return null;
  const tick = peekLiveTick(iid);
  if (tick?.ltp && tick.ltp > 0) return tick.ltp;
  return liveTapeLtp(iid, ltps);
}

type OrderResult = { ok: true; filledQty: number; fill: number } | { ok: false; error: string };

export default function OneMinFastPanel({
  chain,
  active = true,
}: {
  chain: ChainResolved;
  active?: boolean;
}) {
  const desk = fast1Desk(chain.index);
  const book = desk ?? undefined;
  const restored = useRef(book ? loadVwapSession(book) : null);
  const deskRef = useRef<VwapDesk | null>(desk);
  deskRef.current = desk;
  const ltps = useLiveLtp();
  const onIndex = desk != null && isDeskIndex(chain, desk.underlying);

  const [qtyText, setQtyText] = useState(restored.current?.qty ?? String(book?.defaultQty ?? 780));
  const [size, setSize] = useState<SizeMult>(restored.current?.size ?? 1);
  const [wing, setWing] = useState(restored.current?.wing ?? 0);
  const [targetText, setTargetText] = useState(restored.current?.targetText ?? DEFAULT_TARGET);
  const [targetLocked, setTargetLocked] = useState(restored.current?.targetLocked ?? false);
  const [targetArmed, setTargetArmed] = useState<number | null>(restored.current?.targetArmed ?? null);
  const [slText, setSlText] = useState(restored.current?.slText ?? "");
  const [slLocked, setSlLocked] = useState(restored.current?.slLocked ?? false);
  const [slArmed, setSlArmed] = useState<number | null>(restored.current?.slArmed ?? null);
  const [position, setPosition] = useState<VwapPosition | null>(restored.current?.position ?? null);
  const [logs, setLogs] = useState<VwapLog[]>(restored.current?.logs ?? []);
  const [openLine, setOpenLine] = useState<{ date: string; spot: number } | null>(null);
  const [openNote, setOpenNote] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [addText, setAddText] = useState("");
  const [nikalText, setNikalText] = useState("");

  const logIdRef = useRef(restored.current?.nextLogId ?? 1);
  const posRef = useRef(position);
  const busyRef = useRef(false);
  const chainRef = useRef(chain);
  const ltpsRef = useRef(ltps);
  const qtyRef = useRef(qtyText);
  const sizeRef = useRef(size);
  const wingRef = useRef(wing);
  const targetRef = useRef(targetArmed);
  const slRef = useRef(slArmed);
  const liveSpotRef = useRef<number | null>(null);
  const openRef = useRef<number | null>(null);
  const flipKeyRef = useRef<string | null>(null);
  const flipRetryRef = useRef<{ side: OptionSide; at: number } | null>(null);

  posRef.current = position;
  chainRef.current = chain;
  ltpsRef.current = ltps;
  qtyRef.current = qtyText;
  sizeRef.current = size;
  wingRef.current = wing;
  targetRef.current = targetArmed;
  slRef.current = slArmed;

  const liveSpot =
    typeof ltps[chain.spotToken] === "number" && ltps[chain.spotToken]! > 0 ? ltps[chain.spotToken]! : null;
  const openPx = openLine?.spot && openLine.spot > 0 ? openLine.spot : null;
  liveSpotRef.current = liveSpot;
  openRef.current = openPx;
  const signal: VwapSignal = tradeSignal(liveSpot, openPx);
  const side = signalSide(signal);
  const atm = liveAtmStrikeForChain(chain, liveSpot ?? undefined);
  const step = Number(chain.step) || 50;
  const legs = wingStrikes(atm, wing, step);
  const ceIid = chain.instrumentMap[String(legs.ce)]?.ce ?? null;
  const peIid = chain.instrumentMap[String(legs.pe)]?.pe ?? null;
  const cePx = premiumOf(typeof ceIid === "number" ? ceIid : null, ltps);
  const pePx = premiumOf(typeof peIid === "number" ? peIid : null, ltps);
  const orderQty = book ? sizedQty(qtyText, size, book.lotSize) : null;
  const livePx = side === "CE" ? cePx : side === "PE" ? pePx : null;
  const button = orderButtonText({
    signal,
    wing,
    strike: side === "CE" ? legs.ce : side === "PE" ? legs.pe : null,
    premium: position ? null : livePx,
    openSide: position?.optionType ?? null,
  });
  const actionDisabled = busy || signal === "NONE" || position != null || !onIndex;

  const watchIds = useMemo(() => {
    const ids: number[] = [];
    if (position?.instrumentId) ids.push(position.instrumentId);
    if (active) {
      if (typeof ceIid === "number" && ceIid > 0) ids.push(ceIid);
      if (typeof peIid === "number" && peIid > 0) ids.push(peIid);
    }
    return Array.from(new Set(ids));
  }, [active, ceIid, peIid, position?.instrumentId]);

  useSubscribeTouchline(chain.optionSegment, watchIds);
  useSubscribeTouchline(chain.spotSegment, chain.spotToken > 0 ? [chain.spotToken] : []);

  const pushLog = useCallback((text: string, kind: LogKind) => {
    const id = logIdRef.current++;
    setLogs((prev) => [{ id, ts: Date.now(), text, kind }, ...prev].slice(0, MAX_LOG));
  }, []);

  const remember = useCallback((pos: VwapPosition) => {
    posRef.current = pos;
    setPosition(pos);
    setLocalShortPosition({
      exchangeInstrumentID: pos.instrumentId,
      exchangeSegment: pos.segment || chainRef.current.optionSegment,
      qty: pos.qty,
      fillPx: pos.fillPx,
      tradingSymbol: `${deskRef.current?.underlying || chainRef.current.index} ${pos.strike} ${pos.optionType}`,
      productType: "NRML",
    });
  }, []);

  const forget = useCallback((instrumentId: number) => {
    posRef.current = null;
    setPosition(null);
    clearLocalPosition(instrumentId);
  }, []);

  useEffect(() => {
    if (!book) return;
    saveVwapSession(
      {
        v: 2,
        qty: qtyText,
        size,
        wing,
        targetText,
        targetLocked,
        targetArmed,
        slText,
        slLocked,
        slArmed,
        position,
        logs,
        nextLogId: logIdRef.current,
      },
      book.storeKey,
    );
  }, [book, qtyText, size, wing, targetText, targetLocked, targetArmed, slText, slLocked, slArmed, position, logs]);

  useEffect(() => {
    if (!book) return;
    let stop = false;
    const pull = async () => {
      try {
        const raw = (await apiFetch(book.apiPath)) as Open0920Payload;
        if (stop) return;
        const spot = typeof raw.spot === "number" && raw.spot > 0 ? raw.spot : null;
        const sessionDate = raw.sessionDate || "";
        if (spot != null && sessionDate) {
          setOpenLine((prev) => (prev && prev.date === sessionDate ? prev : { date: sessionDate, spot }));
          setOpenNote(null);
          return;
        }
        if (sessionDate) {
          setOpenLine((prev) => (prev && prev.date !== sessionDate ? null : prev));
        }
        setOpenNote(raw.error || (raw.pending ? "Before 09:20" : "09:20 open is not in yet."));
      } catch (err) {
        if (!stop) setOpenNote(err instanceof Error ? err.message : "09:20 open fetch failed");
      }
    };
    void pull();
    const timer = window.setInterval(() => void pull(), openPx != null ? 30_000 : 2_000);
    return () => {
      stop = true;
      window.clearInterval(timer);
    };
  }, [book, openPx]);

  const sendOrder = useCallback(async (sideOrder: "BUY" | "SELL", instrumentId: number, qty: number): Promise<OrderResult> => {
    const tick = peekLiveTick(instrumentId);
    const ltp = tick?.ltp && tick.ltp > 0 ? tick.ltp : liveTapeLtp(instrumentId, ltpsRef.current);
    const pricing = ladderOrderPricing(sideOrder, ltp, tick?.bid, tick?.ask);
    if (!(pricing.limitPrice > 0)) return { ok: false, error: "Market price nahi mili" };
    try {
      const r = (await apiFetch("/api/ix/place_order", {
        method: "POST",
        body: JSON.stringify({
          ...XTS_IX_ORDER_BASE,
          ...pricing,
          productType: "NRML",
          bookOnlyIfFilled: true,
          exchangeSegment: chainRef.current.optionSegment,
          exchangeInstrumentID: instrumentId,
          orderSide: sideOrder,
          orderQuantity: qty,
        }),
      })) as { ok?: boolean; error?: string; filledQty?: number; raw?: unknown; fillHint?: { ltp?: number } };
      bumpPositionsRefresh();
      if (r?.ok !== true) return { ok: false, error: r?.error || "Order not filled" };
      const filledQty = typeof r.filledQty === "number" && r.filledQty > 0 ? Math.floor(r.filledQty) : 0;
      const hinted = typeof r.fillHint?.ltp === "number" && r.fillHint.ltp > 0 ? r.fillHint.ltp : 0;
      const live = typeof ltp === "number" && ltp > 0 ? ltp : 0;
      const fill = (hinted > 0 ? hinted : live) || xtsOrderFillPx(r.raw);
      if (!(filledQty > 0) || fill == null || !(fill > 0)) {
        return {
          ok: false,
          error: filledQty > 0 ? "Fill price missing. Book unchanged." : r.error || "Order not filled",
        };
      }
      return { ok: true, filledQty: Math.min(qty, filledQty), fill };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : "Order failed" };
    }
  }, []);

  const pickSide = useCallback((optionType: OptionSide) => {
    const ch = chainRef.current;
    const spot = liveSpotRef.current ?? undefined;
    const strikeAtm = liveAtmStrikeForChain(ch, typeof spot === "number" ? spot : undefined);
    const strike = sellStrike(strikeAtm, wingRef.current, Number(ch.step) || 50, optionType);
    const row = ch.instrumentMap[String(strike)];
    const iid = optionType === "CE" ? row?.ce : row?.pe;
    if (typeof iid !== "number" || !(iid > 0)) return null;
    return { strike, instrumentId: iid };
  }, []);

  const bookSell = useCallback(
    async (optionType: OptionSide, qty: number, reason: string) => {
      const spot = liveSpotRef.current;
      const open = openRef.current;
      const picked = pickSide(optionType);
      if (!picked || !(spot && spot > 0) || !(open && open > 0)) {
        return { ok: false as const, error: "No trade. Spot and the 09:20 open are required." };
      }
      const sold = await sendOrder("SELL", picked.instrumentId, qty);
      if (!sold.ok) return sold;
      const prev = posRef.current;
      const next: VwapPosition =
        prev && prev.instrumentId === picked.instrumentId
          ? {
              ...prev,
              qty: prev.qty + sold.filledQty,
              fillPx: averageFill(prev.fillPx, prev.qty, sold.fill, sold.filledQty),
            }
          : {
              instrumentId: picked.instrumentId,
              strike: picked.strike,
              optionType,
              qty: sold.filledQty,
              fillPx: sold.fill,
              segment: chainRef.current.optionSegment,
            };
      remember(next);
      flipRetryRef.current = null;
      flipKeyRef.current = null;
      pushLog(
        reason === "ADD"
          ? `ADD ${optionType} ${picked.strike.toLocaleString("en-IN")} × ${fmtQty(sold.filledQty)} @ ${sold.fill.toFixed(2)} · avg ${next.fillPx.toFixed(2)} × ${fmtQty(next.qty)}`
          : entryLog({
              spot,
              open,
              wing: wingRef.current,
              side: optionType,
              strike: picked.strike,
              qty: sold.filledQty,
              premium: sold.fill,
              target: targetRef.current,
            }),
        "entry",
      );
      return { ok: true as const, filledQty: sold.filledQty };
    },
    [pickSide, pushLog, remember, sendOrder],
  );

  const coverQty = useCallback(
    async (qty: number, reason: string) => {
      const pos = posRef.current;
      if (!pos) return { ok: false as const, error: "No short is open." };
      if (qty > pos.qty) return { ok: false as const, error: "Qty is larger than the open short." };
      const bought = await sendOrder("BUY", pos.instrumentId, qty);
      if (!bought.ok) return bought;
      const left = pos.qty - bought.filledQty;
      if (left <= 0) {
        forget(pos.instrumentId);
        flipKeyRef.current = null;
      } else {
        remember({ ...pos, qty: left });
      }
      pushLog(
        `BUY ${reason} ${pos.optionType} ${pos.strike.toLocaleString("en-IN")} × ${fmtQty(bought.filledQty)} @ ${bought.fill.toFixed(2)}${
          left > 0 ? ` · left ${fmtQty(left)}` : ""
        }`,
        "exit",
      );
      return { ok: true as const, filledQty: bought.filledQty, left };
    },
    [forget, pushLog, remember, sendOrder],
  );

  const runFlip = useCallback(async () => {
    const pos = posRef.current;
    if (!pos || busyRef.current) return;
    const nextSide = signalSide(tradeSignal(liveSpotRef.current, openRef.current));
    if (!nextSide || nextSide === pos.optionType) return;
    const key = `${pos.instrumentId}|${nextSide}`;
    if (flipKeyRef.current === key) return;
    flipKeyRef.current = key;
    busyRef.current = true;
    setBusy(true);
    try {
      const bought = await sendOrder("BUY", pos.instrumentId, pos.qty);
      if (!bought.ok) {
        pushLog(`Flip cover not filled. Short still open. ${bought.error}`, "error");
        return;
      }
      const left = pos.qty - bought.filledQty;
      if (left > 0) {
        remember({ ...pos, qty: left });
        pushLog(
          `BUY FLIP partial ${pos.optionType} ${pos.strike.toLocaleString("en-IN")} × ${fmtQty(bought.filledQty)} @ ${bought.fill.toFixed(2)} · left ${fmtQty(left)}. New sell not sent.`,
          "exit",
        );
        return;
      }
      forget(pos.instrumentId);
      pushLog(
        `BUY FLIP ${pos.optionType} ${pos.strike.toLocaleString("en-IN")} × ${fmtQty(bought.filledQty)} @ ${bought.fill.toFixed(2)}`,
        "exit",
      );
      const qty = sizedQty(qtyRef.current, sizeRef.current, deskRef.current?.lotSize ?? 65);
      const picked = pickSide(nextSide);
      if (qty == null || !picked) {
        flipRetryRef.current = { side: nextSide, at: Date.now() + FLIP_RETRY_MS };
        pushLog("New sell not sent. Book is flat. Retry in 3s.", "error");
        return;
      }
      const sold = await bookSell(nextSide, qty, "FLIP");
      if (!sold.ok) {
        flipRetryRef.current = { side: nextSide, at: Date.now() + FLIP_RETRY_MS };
        pushLog(`New sell not filled. Book is flat. No cover buy. Retry in 3s. ${sold.error}`, "error");
      }
    } finally {
      busyRef.current = false;
      setBusy(false);
    }
  }, [bookSell, forget, pickSide, pushLog, remember, sendOrder]);

  const retryFlatSell = useCallback(async () => {
    const pending = flipRetryRef.current;
    if (!pending || posRef.current || busyRef.current || Date.now() < pending.at) return;
    const liveSide = signalSide(tradeSignal(liveSpotRef.current, openRef.current));
    if (liveSide !== pending.side) {
      flipRetryRef.current = null;
      return;
    }
    const qty = sizedQty(qtyRef.current, sizeRef.current, deskRef.current?.lotSize ?? 65);
    if (qty == null) return;
    flipRetryRef.current = null;
    busyRef.current = true;
    setBusy(true);
    try {
      const sold = await bookSell(pending.side, qty, "FLIP");
      if (!sold.ok) {
        flipRetryRef.current = { side: pending.side, at: Date.now() + FLIP_RETRY_MS };
        pushLog(`Flip sell not filled. Book is flat. Retry in 3s. ${sold.error}`, "error");
      }
    } finally {
      busyRef.current = false;
      setBusy(false);
    }
  }, [bookSell, pushLog]);

  useEffect(() => {
    if (!onIndex) return;
    const instruments = [
      ...(chain.spotToken > 0 ? [{ exchangeSegment: chain.spotSegment, exchangeInstrumentID: chain.spotToken }] : []),
      ...watchIds.map((id) => ({ exchangeSegment: chain.optionSegment, exchangeInstrumentID: id })),
    ];
    void apiFetch("/api/md/focus", {
      method: "POST",
      body: JSON.stringify({ channel: desk?.focusChannel, instruments }),
    }).catch(() => {});
  }, [chain.optionSegment, chain.spotSegment, chain.spotToken, desk?.focusChannel, onIndex, watchIds]);

  useEffect(() => {
    if (!onIndex) return;
    const timer = window.setInterval(() => {
      const current = deskRef.current;
      if (busyRef.current || !current || !isDeskIndex(chainRef.current, current.underlying)) return;
      const pos = posRef.current;
      const nextSide = signalSide(tradeSignal(liveSpotRef.current, openRef.current));
      if (!pos) {
        if (flipRetryRef.current) void retryFlatSell();
        return;
      }
      if (nextSide === pos.optionType) flipKeyRef.current = null;
      const premium = premiumOf(pos.instrumentId, ltpsRef.current);
      if (premium != null && Number.isFinite(premium) && !badPremiumTick(pos.fillPx, premium)) {
        const target = targetRef.current;
        if (targetHit(pos.fillPx, premium, target)) {
          void (async () => {
            if (busyRef.current) return;
            busyRef.current = true;
            setBusy(true);
            try {
              const booked = await coverQty(posRef.current?.qty ?? pos.qty, `TARGET ${target} pts`);
              if (!booked.ok) pushLog(booked.error, "error");
            } finally {
              busyRef.current = false;
              setBusy(false);
            }
          })();
          return;
        }
        const sl = slRef.current;
        if (sl != null && slPriceHit(premium, sl)) {
          const slPx = sl;
          void (async () => {
            if (busyRef.current) return;
            busyRef.current = true;
            setBusy(true);
            try {
              const booked = await coverQty(posRef.current?.qty ?? pos.qty, `SL ${fmtPrice(slPx)}`);
              if (!booked.ok) pushLog(booked.error, "error");
            } finally {
              busyRef.current = false;
              setBusy(false);
            }
          })();
          return;
        }
      }
      if (nextSide && nextSide !== pos.optionType) void runFlip();
    }, GUARD_MS);
    return () => window.clearInterval(timer);
  }, [coverQty, onIndex, pushLog, retryFlatSell, runFlip]);

  const lockTarget = () => {
    if (targetLocked) {
      setTargetLocked(false);
      return;
    }
    const parsed = parsePoints(targetText);
    if (!parsed.ok) {
      pushLog("Target cannot lock. Use a blank, 0, or a positive number.", "error");
      return;
    }
    setTargetArmed(parsed.points);
    setTargetLocked(true);
  };

  const lockSl = () => {
    if (slLocked) {
      setSlLocked(false);
      return;
    }
    const parsed = parsePoints(slText);
    if (!parsed.ok) {
      pushLog("SL cannot lock. Type the premium, or 0 to turn it off.", "error");
      return;
    }
    setSlArmed(parsed.points);
    setSlLocked(true);
  };

  const enter = async () => {
    if (!onIndex || !book) {
      pushLog(book?.onlyMessage || "Switch the top index to NIFTY or SENSEX.", "error");
      return;
    }
    if (posRef.current) {
      pushLog("Fresh sell refused. A short is already open.", "error");
      return;
    }
    const liveSide = signalSide(tradeSignal(liveSpotRef.current, openRef.current));
    const qty = sizedQty(qtyRef.current, sizeRef.current, book.lotSize);
    if (!liveSide || qty == null) {
      pushLog(qty == null ? `Qty must be a positive multiple of ${book.lotSize}.` : "No trade.", "error");
      return;
    }
    if (busyRef.current) return;
    busyRef.current = true;
    setBusy(true);
    try {
      const sold = await bookSell(liveSide, qty, "SELL");
      if (!sold.ok) pushLog(`SELL not filled. ${sold.error}`, "error");
    } finally {
      busyRef.current = false;
      setBusy(false);
    }
  };

  const addQty = async () => {
    const pos = posRef.current;
    const extra = book ? lotQty(addText, book.lotSize) : null;
    if (!pos) {
      pushLog("Add refused. No short is open.", "error");
      return;
    }
    if (extra == null) {
      pushLog(`Add refused. Qty must be a positive multiple of ${book?.lotSize ?? 65}.`, "error");
      return;
    }
    if (busyRef.current) return;
    busyRef.current = true;
    setBusy(true);
    try {
      const sold = await sendOrder("SELL", pos.instrumentId, extra);
      if (!sold.ok) {
        pushLog(`ADD not filled. Short still open. ${sold.error}`, "error");
        return;
      }
      const next: VwapPosition = {
        ...pos,
        qty: pos.qty + sold.filledQty,
        fillPx: averageFill(pos.fillPx, pos.qty, sold.fill, sold.filledQty),
      };
      remember(next);
      setAddText("");
      pushLog(
        `ADD ${pos.optionType} ${pos.strike.toLocaleString("en-IN")} × ${fmtQty(sold.filledQty)} @ ${sold.fill.toFixed(2)} · avg ${next.fillPx.toFixed(2)} × ${fmtQty(next.qty)}`,
        "entry",
      );
    } finally {
      busyRef.current = false;
      setBusy(false);
    }
  };

  const nikalQty = async () => {
    const pos = posRef.current;
    const cut = book ? lotQty(nikalText, book.lotSize) : null;
    if (!pos) {
      pushLog("Exit refused. No short is open.", "error");
      return;
    }
    if (cut == null) {
      pushLog(`Exit refused. Qty must be a positive multiple of ${book?.lotSize ?? 65}.`, "error");
      return;
    }
    if (cut > pos.qty) {
      pushLog("Exit refused. Qty is larger than the open short.", "error");
      return;
    }
    if (busyRef.current) return;
    busyRef.current = true;
    setBusy(true);
    try {
      const bought = await coverQty(cut, "EXIT");
      if (!bought.ok) pushLog(`EXIT not filled. Short still open. ${bought.error}`, "error");
      else setNikalText("");
    } finally {
      busyRef.current = false;
      setBusy(false);
    }
  };

  const square = async (reason: "STOP" | "SQUARE ALL") => {
    const pos = posRef.current;
    if (!pos) {
      pushLog(`${reason} — no short is open.`, "info");
      return;
    }
    if (busyRef.current) return;
    busyRef.current = true;
    setBusy(true);
    try {
      const bought = await coverQty(pos.qty, reason);
      if (!bought.ok) pushLog(`${reason} not filled. Short still open. ${bought.error}`, "error");
    } finally {
      busyRef.current = false;
      setBusy(false);
    }
  };

  if (!book || !onIndex) {
    return (
      <div className="nw-desk flex flex-1 items-center justify-center p-6 text-center text-[15px] font-semibold">
        1 min Fast trades Nifty or Sensex. Switch the top index to NIFTY or SENSEX.
      </div>
    );
  }

  const posPx = position ? premiumOf(position.instrumentId, ltps) : null;
  const points = position && posPx != null ? profitPoints(position.fillPx, posPx) : null;
  const mtm = position && posPx != null ? shortMtm(position.fillPx, posPx, position.qty) : null;
  const gap = liveSpot != null && openPx != null ? spotGap(liveSpot, openPx) : null;

  return (
    <div className="nw-desk flex min-h-0 flex-1 flex-col overflow-hidden">
      <div className="nw-stats shrink-0">
        <Stat
          tone="vwap"
          label="09:20 open"
          value={openPx != null ? fmtPrice(openPx) : "—"}
          sub={openPx != null ? "locked" : openNote || "Before 09:20"}
        />
        <Stat
          tone={gap == null ? "spot" : gap > 0 ? "up" : gap < 0 ? "down" : "spot"}
          label={book.spotLabel}
          value={liveSpot != null ? fmtPrice(liveSpot) : "—"}
          sub={gap == null ? "—" : `${signedPts(gap)} pts`}
        />
        <Stat
          tone={side === "CE" ? "ce" : side === "PE" ? "pe" : "flat"}
          label="Signal"
          value={signalLabel(signal)}
          sub="vs 09:20 open"
        />
      </div>

      <div className="nw-tools shrink-0">
        <div className="nw-row nw-row--controls">
          <label className="nw-field">
            Qty
            <input value={qtyText} onChange={(e) => setQtyText(e.target.value)} className="sow-glass-input nw-input" />
          </label>
          <div className="nw-field">
            <span>Size</span>
            <div className="nw-chips" role="group" aria-label="Size">
              {SIZES.map((n) => (
                <button
                  key={n}
                  type="button"
                  aria-pressed={size === n}
                  onClick={() => setSize(n)}
                  className={`nw-chip nw-chip--size${size === n ? " nw-chip--on" : ""}`}
                >
                  {n}x
                </button>
              ))}
            </div>
          </div>
          <LockField label="Target" value={targetText} locked={targetLocked} onChange={setTargetText} onLock={lockTarget} />
          <LockField label="SL" value={slText} locked={slLocked} placeholder="price" onChange={setSlText} onLock={lockSl} />
          <div className="nw-qty">
            {orderQty != null
              ? `${fmtQty(lotQty(qtyText, book.lotSize) || 0)} × ${size} = ${fmtQty(orderQty)}`
              : `Qty must be a multiple of ${book.lotSize}`}
          </div>
        </div>

        <div className="nw-row nw-row--strikes">
          <div className="nw-chips" role="group" aria-label="Strike wing">
            {WINGS.map((n) => (
              <button
                key={n}
                type="button"
                aria-pressed={wing === n}
                onClick={() => setWing(n)}
                className={`nw-chip nw-chip--wing${wing === n ? " nw-chip--on" : ""}`}
              >
                {n === 0 ? "ATM" : n}
              </button>
            ))}
          </div>
          <div className="nw-quotes">
            <span className={`nw-quote${side === "CE" ? " nw-quote--on nw-quote--ce" : ""}`}>
              CE {legs.ce.toLocaleString("en-IN")}
              {cePx != null ? ` @ ${cePx.toFixed(2)}` : ""}
            </span>
            <span className={`nw-quote${side === "PE" ? " nw-quote--on nw-quote--pe" : ""}`}>
              PE {legs.pe.toLocaleString("en-IN")}
              {pePx != null ? ` @ ${pePx.toFixed(2)}` : ""}
            </span>
          </div>
        </div>

        <div className="nw-rule text-[12px] font-semibold">
          {targetArmed != null
            ? `Target ${targetArmed} pts${targetLocked ? " · locked" : ""}${
                position
                  ? ` · book ≤ ${bookPx(position.fillPx, targetArmed).toFixed(2)}${
                      points != null ? ` · now ${signedPts(points)} pts` : ""
                    }`
                  : ""
              }`
            : targetLocked
              ? "Target off · locked"
              : "Target not locked"}
        </div>
        <div className="nw-rule text-[12px] font-semibold">
          {slArmed != null
            ? `SL ${fmtPrice(slArmed)}${slLocked ? " · locked" : ""} · books the short when LTP ≥ ${fmtPrice(slArmed)}`
            : slLocked
              ? "SL off · locked"
              : "SL not locked — type the premium, then Lock"}
        </div>

        <div className="nw-row nw-row--actions">
          <input
            value={addText}
            onChange={(e) => setAddText(e.target.value)}
            placeholder="Add qty"
            className="sow-glass-input nw-input nw-input--wide"
          />
          <button type="button" disabled={busy} onClick={() => void addQty()} className="nw-chip nw-chip--add">
            Add
          </button>
          <input
            value={nikalText}
            onChange={(e) => setNikalText(e.target.value)}
            placeholder="Exit qty"
            className="sow-glass-input nw-input nw-input--wide"
          />
          <button type="button" disabled={busy} onClick={() => void nikalQty()} className="nw-chip nw-chip--nikal">
            Exit
          </button>
          <button type="button" disabled={actionDisabled} onClick={() => void enter()} className="ramsetu-glass-exec min-w-[180px]">
            {button}
          </button>
          <button type="button" disabled={busy} onClick={() => void square("STOP")} className="ramsetu-glass-stop">
            STOP
          </button>
          <button type="button" disabled={busy} onClick={() => void square("SQUARE ALL")} className="ramsetu-glass-stop">
            SQUARE ALL
          </button>
        </div>
      </div>

      <div className="nw-pos shrink-0 px-3 py-2">
        {!position ? (
          <div className="text-[15px] font-bold">Flat</div>
        ) : (
          <div className="flex flex-wrap items-baseline gap-x-4 gap-y-1 text-[12px]">
            <span className={`text-[18px] font-extrabold ${position.optionType === "CE" ? "nw-up" : "nw-down"}`}>
              {position.strike.toLocaleString("en-IN")} {position.optionType}
            </span>
            <span>Qty {fmtQty(position.qty)}</span>
            <span>Fill {position.fillPx.toFixed(2)}</span>
            {posPx != null && <span>LTP {posPx.toFixed(2)}</span>}
            {mtm != null && points != null && (
              <span className={`font-bold ${mtm >= 0 ? "nw-up" : "nw-down"}`}>
                MTM {signedPts(mtm)} · {signedPts(points)} pts
              </span>
            )}
            <span>Target {targetArmed != null ? `≤ ${bookPx(position.fillPx, targetArmed).toFixed(2)}` : "—"}</span>
            <span>SL {slArmed != null ? `≥ ${fmtPrice(slArmed)}` : "—"}</span>
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

function LockField({
  label,
  value,
  locked,
  placeholder,
  onChange,
  onLock,
}: {
  label: string;
  value: string;
  locked: boolean;
  placeholder?: string;
  onChange: (value: string) => void;
  onLock: () => void;
}) {
  return (
    <label className="nw-field">
      {label}
      <span className="nw-lock">
        <input
          value={value}
          disabled={locked}
          placeholder={placeholder}
          onChange={(e) => onChange(e.target.value)}
          className="sow-glass-input nw-input nw-input--short"
        />
        <button type="button" onClick={onLock} className={`nw-chip${locked ? " nw-chip--locked" : " nw-chip--lock"}`}>
          {locked ? "Unlock" : "Lock"}
        </button>
      </span>
    </label>
  );
}
