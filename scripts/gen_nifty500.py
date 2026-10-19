"""Regenerate Nifty 500 symbol lists from data/ind_nifty500list.csv."""
from __future__ import annotations

import csv
import shutil
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
CSV_DEFAULT = ROOT / "data" / "ind_nifty500list.csv"
CSV_FALLBACK = Path.home() / "Downloads" / "ind_nifty500list.csv"


def load_symbols(csv_path: Path) -> list[str]:
    seen: set[str] = set()
    out: list[str] = []
    with csv_path.open(encoding="utf-8") as f:
        for row in csv.DictReader(f):
            s = (row.get("Symbol") or "").strip().upper()
            if not s or s in seen:
                continue
            seen.add(s)
            out.append(s)
    out.sort()
    return out


def write_py(symbols: list[str], path: Path) -> None:
    lines = [
        '"""Nifty 500 constituent symbols (NSE trading symbols)."""',
        "",
        "NIFTY500_SYMBOLS: tuple[str, ...] = (",
    ]
    for s in symbols:
        lines.append(f'    "{s}",')
    lines.extend([")", "", "NIFTY500_SYMBOL_SET: frozenset[str] = frozenset(NIFTY500_SYMBOLS)", ""])
    path.write_text("\n".join(lines), encoding="utf-8")


def write_ts(symbols: list[str], path: Path) -> None:
    lines = [
        "/** Nifty 500 NSE symbols (from ind_nifty500list.csv). */",
        "export const NIFTY500_SYMBOLS: readonly string[] = [",
    ]
    for s in symbols:
        esc = s.replace("\\", "\\\\").replace('"', '\\"')
        lines.append(f'  "{esc}",')
    lines.extend(["] as const;", "", "export const NIFTY500_SYMBOL_SET = new Set(NIFTY500_SYMBOLS);", ""])
    path.write_text("\n".join(lines), encoding="utf-8")


def main() -> None:
    src = CSV_DEFAULT if CSV_DEFAULT.is_file() else CSV_FALLBACK
    if not src.is_file():
        raise SystemExit(f"CSV not found: {CSV_DEFAULT} or {CSV_FALLBACK}")

    symbols = load_symbols(src)
    data_dir = ROOT / "data"
    data_dir.mkdir(exist_ok=True)
    if src != CSV_DEFAULT:
        shutil.copy2(src, CSV_DEFAULT)

    write_py(symbols, ROOT / "backend" / "market" / "nifty500.py")
    write_ts(symbols, ROOT / "artifacts" / "sonOfWind-dashboard" / "src" / "lib" / "nifty500.ts")
    print(f"Wrote {len(symbols)} symbols from {src}")


if __name__ == "__main__":
    main()
