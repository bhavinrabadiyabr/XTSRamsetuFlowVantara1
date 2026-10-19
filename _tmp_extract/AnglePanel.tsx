import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { ChainResolved } from "@/types/market";
import { useLiveLtp } from "@/context/LiveLtpContext";
import { useSubscribeTouchline } from "@/lib/mdRegistry";
import { liveAtmStrikeForChain } from "@/lib/liveAtmStrike";
import { fmtPrice } from "@/lib/formatNumber";
import { apiFetch } from "@/lib/backend";
import { XTS_IX_ORDER_BASE } from "@/lib/xtsOrder";
import { toast } from "@/hooks/use-toast";
import { ramsetuStartFromOptions, ramsetuStrikesForOffset } from "@/lib/ramsetuAtpRules";
import {
  angleEntrySignal,
  angleEvaluateExit,
  angleExitReasonLabel,
  angleGapOk,
  angleIsAfterCutoff,
  angleShortPnlPts,
  type AngleExitReason,
  type AngleMinGap,
  type AnglePhase,
  type AnglePosition,
  type AngleRange,
  type AngleTimeframe,
} from "@/lib/angleRules";

const POSITIONS_REFRESH = "sow:positions_refresh";
const ORDER_LOCK_MS = 2500;
const RANGE_POLL_MS = 8000;

function bumpPositionsRefresh() {
  window.dispatchEvent(new CustomEvent(POSITIONS_REFRESH));
  window.setTimeout(() => window.dispatchEvent(new CustomEvent(POSITIONS_REFRESH)), 600);
}

type AngleLog = {
  id: number;
  ts: number;
  text: string;
  kind: "info" | "entry" | "exit" | "warn";
};

type RangeApi = {
  ok?: boolean;
  ready?: boolean;
  error?: string;
  barsUsed?: number;
  range?: { high: number; low: number; mid: number; gap: number } | null;
};

export default function AnglePanel({
  chain,
  qty,
}: {
  chain: ChainResolved;
  qty: number;
}) {
  const ltps = useLiveLtp();
  const seg = chain.optionSegment;
  const spotSeg = chain.spotSegment;
  const spotToken = chain.spotToken;
  const startFromOptions = useMemo(() => ramsetuStartFromOptions(), []);

  const liveSpot =
    typeof ltps[spotToken] === "number" && Number.isFinite(ltps[spotToken]) ? ltps[spotToken] : undefined;
  const atm = useMemo(() => liveAtmStrikeForChain(chain, liveSpot), [chain, liveSpot]);

  const [timeframe, setTimeframe] = useState<AngleTimeframe>("3m");
  const [minGap, setMinGap] = useState<AngleMinGap>(50);
  const [startFromOffset, setStartFromOffset] = useState(0);
  const [manualSlText, setManualSlText] = useState("");
  const [running, setRunning] = useState(false);
  const [phase, setPhase] = useState<AnglePhase>("STOPPED");
  const [range, setRange] = useState<AngleRange | null>(null);
  const [rangeReady, setRangeReady] = useState(false);
  const [rangeErr, setRangeErr] = useState<string | null>(null);
  const [pos, setPos] = useState<AnglePosition | null>(null);
  const [logs, setLogs] = useState<AngleLog[]>([]);
  const [busy, setBusy] = useState(false);

  const qtyRef = useRef(qty);
  const segRef = useRef(seg);
  const runningRef = useRef(false);
  const phaseRef = useRef<AnglePhase>("STOPPED");
  const posRef = useRef<AnglePosition | null>(null);
  const rangeRef = useRef<AngleRange | null>(null);
  const rangeReadyRef = useRef(false);
  const minGapRef = useRef<AngleMinGap>(50);
  const timeframeRef = useRef<AngleTimeframe>("3m");
  const startFromRef = useRef(0);
  const chainRef = useRef(chain);
  const atmRef = useRef(atm);
  const manualSlRef = useRef<number | null>(null);
  const orderLockUntilRef = useRef(0);
  const orderInFlightRef = useRef(false);
  const logIdRef = useRef(1);
  const tickBusyRef = useRef(false);

  qtyRef.current = qty;
  segRef.current = seg;
  runningRef.current = running;
  phaseRef.current = phase;
  posRef.current = pos;
  rangeRef.current = range;
  rangeReadyRef.current = rangeReady;
  minGapRef.current = minGap;
  timeframeRef.current = timeframe;
  startFromRef.current = startFromOffset;
  chainRef.current = chain;
  atmRef.current = atm;

  const manualSlParsed = useMemo(() => {
    const t = manualSlText.trim();
    if (!t) return null;
    const n = Number(t);
    return Number.isFinite(n) && n > 0 ? n : null;
  }, [manualSlText]);
  manualSlRef.current = manualSlParsed;

  const step = Number(chain.step) > 0 ? Number(chain.step) : 50;
  const { ceStrike, peStrike, intervalPts } = useMemo(
    () => ramsetuStrikesForOffset(atm, step, startFromOffset),
    [atm, step, startFromOffset],
  );

  const ceRow = chain.instrumentMap[String(ceStrike)];
  const peRow = chain.instrumentMap[String(peStrike)];
  const ceIid = typeof ceRow?.ce === "number" && ceRow.ce > 0 ? ceRow.ce : null;
  const peIid = typeof peRow?.pe === "number" && peRow.pe > 0 ? peRow.pe : null;

  const watchIids = useMemo(() => {
    const ids: number[] = [];
    if (ceIid) ids.push(ceIid);
    if (peIid) ids.push(peIid);
    if (pos?.iid) ids.push(pos.iid);
    return Array.from(new Set(ids));
  }, [ceIid, peIid, pos?.iid]);

  useSubscribeTouchline(seg, watchIids);
  useSubscribeTouchline(spotSeg, [spotToken]);

  const pushLog = useCallback((text: string, kind: AngleLog["kind"] = "info") => {
    const id = logIdRef.current++;
    setLogs((prev) => [{ id, ts: Date.now(), text, kind }, ...prev].slice(0, 40));
  }, []);

  const placeOrder = useCallback(async (side: "BUY" | "SELL", iid: number) => {
    const oq = Math.max(1, Math.floor(qtyRef.current));
    await apiFetch("/api/ix/place_order", {
      method: "POST",
      body: JSON.stringify({
        ...XTS_IX_ORDER_BASE,
        exchangeSegment: segRef.current,
        exchangeInstrumentID: iid,
        orderSide: side,
        orderQuantity: oq,
      }),
    });
    bumpPositionsRefresh();
  }, []);

  const refreshRange = useCallback(async () => {
    try {
      const r = (await apiFetch("/api/md/angle/range", {
        method: "POST",
        body: JSON.stringify({
          exchangeSegment: spotSeg,
          exchangeInstrumentID: spotToken,
          timeframe: timeframeRef.current,
          window: 7,
        }),
      })) as RangeApi;
      if (!r?.ok) {
        setRangeErr(r?.error || "Range fetch failed");
        setRangeReady(false);
        rangeReadyRef.current = false;
        return;
      }
      const rng = r.range;
      if (r.ready && rng && rng.high > 0 && rng.low > 0) {
        const next: AngleRange = {
          high: rng.high,
          low: rng.low,
          mid: rng.mid,
          gap: rng.gap,
        };
        setRange(next);
        rangeRef.current = next;
        setRangeReady(true);
        rangeReadyRef.current = true;
        setRangeErr(null);
      } else {
        setRangeReady(false);
        rangeReadyRef.current = false;
        setRangeErr(`Need 7 closed ${timeframeRef.current} candles (have ${r.barsUsed ?? 0})`);
      }
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      setRangeErr(msg.includes("404") ? "Range API 404 — restart backend (python app.py)" : msg);
      setRangeReady(false);
      rangeReadyRef.current = false;
    }
  }, [spotSeg, spotToken]);

  useEffect(() => {
    void refreshRange();
    const id = window.setInterval(() => void refreshRange(), RANGE_POLL_MS);
    return () => window.clearInterval(id);
  }, [refreshRange, timeframe]);

  const gapValid = range != null && angleGapOk(range.gap, minGap);

  const exitTrade = useCallback(
    async (reason: AngleExitReason, exitPremium: number) => {
      const p = posRef.current;
      if (!p || orderInFlightRef.current) return;
      if (angleIsAfterCutoff() && reason !== "MANUAL") {
        pushLog("After 15:30 IST — live exits frozen", "warn");
        return;
      }
      orderInFlightRef.current = true;
      orderLockUntilRef.current = Date.now() + ORDER_LOCK_MS;
      setBusy(true);
      try {
        await placeOrder("BUY", p.iid);
        const pnl = angleShortPnlPts(p.entryPremium, exitPremium);
        const pnlTxt = `${pnl >= 0 ? "+" : ""}${pnl.toFixed(2)} pts`;
        pushLog(
          `EXIT ${p.label} @ ${fmtPrice(exitPremium)} · ${angleExitReasonLabel(reason)} · ${pnlTxt}`,
          "exit",
        );
        toast({
          title: `Angle exit · ${angleExitReasonLabel(reason)}`,
          description: `${p.label} @ ${fmtPrice(exitPremium)} · ${pnlTxt}`,
        });
        setPos(null);
        posRef.current = null;
        setPhase("IDLE");
        phaseRef.current = "IDLE";
      } catch (e: unknown) {
        const msg = e instanceof Error ? e.message : String(e);
        pushLog(`Exit failed: ${msg}`, "warn");
        toast({ title: "Angle exit failed", description: msg, variant: "destructive" });
      } finally {
        orderInFlightRef.current = false;
        setBusy(false);
      }
    },
    [placeOrder, pushLog],
  );

  const resolveLeg = useCallback((optType: "CE" | "PE") => {
    const ch = chainRef.current;
    const liveAtm = atmRef.current;
    const st = Number(ch.step) > 0 ? Number(ch.step) : 50;
    const { ceStrike: cs, peStrike: ps } = ramsetuStrikesForOffset(liveAtm, st, startFromRef.current);
    const strike = optType === "CE" ? cs : ps;
    const row = ch.instrumentMap[String(strike)];
    const iid = optType === "CE" ? row?.ce : row?.pe;
    if (!(typeof iid === "number" && iid > 0)) return null;
    return { strike, iid, label: `${strike.toLocaleString("en-IN")} ${optType}` };
  }, []);

  const enterTrade = useCallback(
    async (optType: "CE" | "PE", reason: "BREAKOUT_HIGH" | "BREAKOUT_LOW", entryRange: AngleRange) => {
      if (orderInFlightRef.current || posRef.current) return;
      if (angleIsAfterCutoff()) {
        pushLog("After 15:30 IST — no new entries", "warn");
        return;
      }
      const leg = resolveLeg(optType);
      if (!leg) {
        pushLog(`No ${optType} instrument for Start From`, "warn");
        return;
      }
      const premium = ltps[leg.iid];
      if (!(typeof premium === "number" && premium > 0)) {
        pushLog(`Waiting for ${leg.label} LTP`, "warn");
        return;
      }
      orderInFlightRef.current = true;
      orderLockUntilRef.current = Date.now() + ORDER_LOCK_MS;
      setBusy(true);
      try {
        await placeOrder("SELL", leg.iid);
        const next: AnglePosition = {
          optType,
          strike: leg.strike,
          iid: leg.iid,
          label: leg.label,
          entryPremium: premium,
          entryMid: entryRange.mid,
          entryHigh: entryRange.high,
          entryLow: entryRange.low,
          entryReason: reason,
          trailArmed: false,
          enteredAt: Date.now(),
        };
        setPos(next);
        posRef.current = next;
        setPhase("IN_TRADE");
        phaseRef.current = "IN_TRADE";
        pushLog(
          `ENTRY SELL ${next.label} qty ${qtyRef.current} @ ${fmtPrice(premium)} · ${reason} · MID ${fmtPrice(entryRange.mid)}`,
          "entry",
        );
        toast({
          title: `Angle SELL ${optType}`,
          description: `${next.label} × ${qtyRef.current} @ ${fmtPrice(premium)} · ${reason}`,
        });
      } catch (e: unknown) {
        const msg = e instanceof Error ? e.message : String(e);
        pushLog(`Entry failed: ${msg}`, "warn");
        toast({ title: "Angle entry failed", description: msg, variant: "destructive" });
      } finally {
        orderInFlightRef.current = false;
        setBusy(false);
      }
    },
    [ltps, placeOrder, pushLog, resolveLeg],
  );

  const tick = useCallback(() => {
    if (!runningRef.current || tickBusyRef.current) return;
    if (Date.now() < orderLockUntilRef.current || orderInFlightRef.current) return;

    const spot = liveSpot;
    if (!(typeof spot === "number" && spot > 0)) return;

    const curPos = posRef.current;
    const curRange = rangeRef.current;
    const ready = rangeReadyRef.current;
    const gapOk = curRange != null && angleGapOk(curRange.gap, minGapRef.current);

    if (curPos) {
      const premium = ltps[curPos.iid];
      if (!(typeof premium === "number" && premium > 0)) return;
      const ev = angleEvaluateExit({
        spot,
        premium,
        pos: curPos,
        rolling: ready && curRange ? curRange : null,
        rollingGapOk: gapOk,
        manualSl: manualSlRef.current,
      });
      if (ev.action === "arm_trail") {
        const updated = { ...curPos, trailArmed: true };
        setPos(updated);
        posRef.current = updated;
        pushLog(`Trail armed @ ${fmtPrice(premium)} (−20% from entry)`, "info");
        return;
      }
      if (ev.action === "exit") {
        tickBusyRef.current = true;
        void exitTrade(ev.reason, premium).finally(() => {
          tickBusyRef.current = false;
        });
      }
      return;
    }

    if (phaseRef.current !== "IDLE") return;
    if (angleIsAfterCutoff()) return;
    if (!ready || !curRange || !gapOk) return;

    const sig = angleEntrySignal(spot, curRange);
    if (!sig) return;
    tickBusyRef.current = true;
    void enterTrade(sig.optType, sig.reason, curRange).finally(() => {
      tickBusyRef.current = false;
    });
  }, [enterTrade, exitTrade, liveSpot, ltps, pushLog]);

  useEffect(() => {
    tick();
  }, [ltps, liveSpot, range, rangeReady, running, tick]);

  useEffect(() => {
    const id = window.setInterval(() => tick(), 350);
    return () => window.clearInterval(id);
  }, [tick]);

  const start = () => {
    if (busy) return;
    setRunning(true);
    runningRef.current = true;
    setPhase("IDLE");
    phaseRef.current = "IDLE";
    void refreshRange();
    pushLog(
      `Angle started · TF ${timeframe} · GAP ≥ ${minGap} · Start From ${startFromOptions.find((o) => o.value === startFromOffset)?.label ?? "ATM"} · Qty ${qty}`,
      "info",
    );
    toast({ title: "Angle started", description: `Watching ${timeframe} range · Qty ${qty}.` });
  };

  const stop = async () => {
    setRunning(false);
    runningRef.current = false;
    const p = posRef.current;
    if (p) {
      const premium = ltps[p.iid];
      const px = typeof premium === "number" && premium > 0 ? premium : p.entryPremium;
      await exitTrade("MANUAL", px);
    }
    setPhase("STOPPED");
    phaseRef.current = "STOPPED";
    pushLog("Angle stopped", "info");
    toast({ title: "Angle stopped" });
  };

  const posPremium =
    pos && typeof ltps[pos.iid] === "number" && ltps[pos.iid]! > 0 ? ltps[pos.iid]! : null;
  const unrealized =
    pos && posPremium != null ? angleShortPnlPts(pos.entryPremium, posPremium) : null;

  const ceLtp = ceIid && typeof ltps[ceIid] === "number" ? ltps[ceIid] : null;
  const peLtp = peIid && typeof ltps[peIid] === "number" ? ltps[peIid] : null;

  return (
    <div className="flex flex-1 min-h-0 min-w-0 flex-col overflow-hidden text-[11px] ramsetu-glass-panel">
      <div className="shrink-0 flex flex-wrap items-end gap-3 ramsetu-glass-toolbar">
        <label className="flex flex-col gap-1">
          <span className="ramsetu-glass-toolbar__label">Timeframe</span>
          <select
            value={timeframe}
            disabled={running}
            onChange={(e) => setTimeframe(e.target.value as AngleTimeframe)}
            className="ramsetu-glass-select min-w-[72px]"
          >
            <option value="1m">1m</option>
            <option value="3m">3m</option>
            <option value="5m">5m</option>
            <option value="15m">15m</option>
            <option value="30m">30m</option>
          </select>
        </label>
        <label className="flex flex-col gap-1">
          <span className="ramsetu-glass-toolbar__label">Start From</span>
          <select
            value={String(startFromOffset)}
            disabled={running && phase === "IN_TRADE"}
            onChange={(e) => setStartFromOffset(Number(e.target.value))}
            className="ramsetu-glass-select min-w-[96px]"
          >
            {startFromOptions.map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
          </select>
        </label>
        <label className="flex flex-col gap-1">
          <span className="ramsetu-glass-toolbar__label">Qty</span>
          <div className="ramsetu-glass-select min-w-[56px] px-2 flex items-center justify-center font-semibold tabular-nums">
            {qty}
          </div>
        </label>
        <label className="flex flex-col gap-1">
          <span className="ramsetu-glass-toolbar__label">Min GAP</span>
          <select
            value={String(minGap)}
            disabled={running && phase === "IN_TRADE"}
            onChange={(e) => setMinGap(Number(e.target.value) as AngleMinGap)}
            className="ramsetu-glass-select min-w-[72px]"
          >
            <option value="50">50 pts</option>
            <option value="75">75 pts</option>
          </select>
        </label>
        <label className="flex flex-col gap-1">
          <span className="ramsetu-glass-toolbar__label">Manual SL</span>
          <input
            type="number"
            value={manualSlText}
            onChange={(e) => setManualSlText(e.target.value)}
            placeholder="off"
            className="ramsetu-glass-select w-[72px] px-1.5"
            title="Optional — exit when option premium ≥ this level"
          />
        </label>
        <div className="flex items-center gap-2 pb-0.5">
          <span
            className={`ramsetu-glass-status-pill ${
              running ? (phase === "IN_TRADE" ? "ramsetu-glass-card--active" : "") : ""
            }`}
          >
            {phase === "STOPPED" ? "Stopped" : phase === "IN_TRADE" ? "In trade" : "Watching"}
          </span>
          {angleIsAfterCutoff() && (
            <span className="text-[10px] text-amber-500/90">After 15:30 — frozen</span>
          )}
        </div>
      </div>

      <div className="shrink-0 grid grid-cols-2 sm:grid-cols-4 gap-2 px-3 py-2 border-b border-border/40">
        <div>
          <div className="text-[10px] text-muted-foreground">HIGH</div>
          <div className="font-mono font-semibold tabular-nums">{fmtPrice(range?.high)}</div>
        </div>
        <div>
          <div className="text-[10px] text-muted-foreground">LOW</div>
          <div className="font-mono font-semibold tabular-nums">{fmtPrice(range?.low)}</div>
        </div>
        <div>
          <div className="text-[10px] text-muted-foreground">MID</div>
          <div className="font-mono font-semibold tabular-nums">{fmtPrice(range?.mid)}</div>
        </div>
        <div>
          <div className="text-[10px] text-muted-foreground">GAP {gapValid ? "✓" : "✗"}</div>
          <div
            className={`font-mono font-semibold tabular-nums ${
              gapValid ? "text-cd-green" : "ramsetu-glass-table__strike--pe"
            }`}
          >
            {range ? range.gap.toFixed(1) : "—"}
            <span className="text-muted-foreground font-normal"> / {minGap}</span>
          </div>
        </div>
      </div>

      <div className="shrink-0 flex flex-wrap items-center gap-3 px-3 py-2 border-b border-border/40 text-[11px]">
        <span className="text-muted-foreground">Spot</span>
        <span className="font-mono font-semibold tabular-nums">{fmtPrice(liveSpot)}</span>
        <span className="text-muted-foreground">ATM</span>
        <span className="font-semibold tabular-nums">{atm.toLocaleString("en-IN")}</span>
        <span className="text-muted-foreground">CE</span>
        <span className="text-cd-green font-semibold tabular-nums">
          {ceStrike.toLocaleString("en-IN")}
          {intervalPts > 0 ? ` (+${intervalPts})` : ""}
          <span className="font-mono font-normal ml-1">{fmtPrice(ceLtp)}</span>
        </span>
        <span className="text-muted-foreground">PE</span>
        <span className="ramsetu-glass-table__strike--pe font-semibold tabular-nums">
          {peStrike.toLocaleString("en-IN")}
          {intervalPts > 0 ? ` (−${intervalPts})` : ""}
          <span className="font-mono font-normal ml-1">{fmtPrice(peLtp)}</span>
        </span>
        <span className="text-muted-foreground">Qty</span>
        <span className="font-semibold tabular-nums">{qty}</span>
        {rangeErr && <span className="text-amber-500/90 truncate max-w-[280px]">{rangeErr}</span>}
      </div>

      {pos && (
        <div className="shrink-0 mx-3 mt-2 ramsetu-glass-card ramsetu-glass-card--active px-3 py-2">
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
            <span className="font-semibold">{pos.label}</span>
            <span className="text-muted-foreground">{pos.entryReason}</span>
            <span className="font-mono">Entry {fmtPrice(pos.entryPremium)}</span>
            <span className="font-mono">LTP {fmtPrice(posPremium)}</span>
            <span
              className={`font-mono ${unrealized != null && unrealized >= 0 ? "text-cd-green" : "ramsetu-glass-table__strike--pe"}`}
            >
              {unrealized != null ? `${unrealized >= 0 ? "+" : ""}${unrealized.toFixed(2)}` : "—"}
            </span>
            <span className="text-muted-foreground">MID SL {fmtPrice(pos.entryMid)}</span>
            {pos.trailArmed && <span className="text-amber-400">Trail armed</span>}
          </div>
        </div>
      )}

      <div className="flex-1 min-h-0 overflow-auto px-3 py-2">
        {!logs.length ? (
          <p className="ramsetu-glass-empty max-w-md mx-auto mt-8">
            Angle watches the last 7 closed {timeframe} candles. When GAP ≥ {minGap} and spot breaks HIGH →
            SELL PE, breaks LOW → SELL CE. Exits: opposite break → MID SL → manual SL → trail → 50% target.
            Change Lots in the header to set Qty (currently {qty}).
          </p>
        ) : (
          <ul className="space-y-1.5">
            {logs.map((l) => (
              <li
                key={l.id}
                className={`font-mono text-[10px] leading-snug ${
                  l.kind === "entry"
                    ? "text-cd-green"
                    : l.kind === "exit"
                      ? "ramsetu-glass-table__strike--pe"
                      : l.kind === "warn"
                        ? "text-amber-500/90"
                        : "text-muted-foreground"
                }`}
              >
                <span className="opacity-60 mr-1.5">
                  {new Date(l.ts).toLocaleTimeString("en-IN", { hour12: false })}
                </span>
                {l.text}
              </li>
            ))}
          </ul>
        )}
      </div>

      <div className="shrink-0 ramsetu-glass-footer flex items-center gap-2">
        {!running ? (
          <button type="button" onClick={start} disabled={busy} className="ramsetu-glass-exec px-4">
            Start
          </button>
        ) : (
          <button type="button" onClick={() => void stop()} disabled={busy} className="ramsetu-glass-stop">
            Stop
          </button>
        )}
        <button
          type="button"
          onClick={() => void refreshRange()}
          className="ramsetu-glass-exec opacity-80"
          title="Refresh 7-candle range"
        >
          Refresh range
        </button>
      </div>
    </div>
  );
}
