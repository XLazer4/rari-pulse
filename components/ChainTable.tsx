"use client";

import { useState } from "react";

export type ChainRow = {
  name: string;
  chainId: number;
  active: boolean;
  matches: number;
  opensea: number;
  volumeUsd: number;
  cancels: number;
  lastEvent: string | null;
  cursorUpdatedAt: string | null;
};

const STALE_MS = 24 * 3600 * 1000;

function fmt(iso: string | null): string {
  if (!iso) return "—";
  return new Date(iso).toISOString().slice(0, 16).replace("T", " ") + " UTC";
}

function Row({ r, now }: { r: ChainRow; now: number }) {
  const stale =
    r.active && r.cursorUpdatedAt !== null && now - new Date(r.cursorUpdatedAt).getTime() > STALE_MS;
  return (
    <tr>
      <td>{r.name}</td>
      <td className="num">{r.chainId}</td>
      <td>{r.active ? <span className="ok">✓ active</span> : <span className="dim">inactive</span>}</td>
      <td className="num">{r.matches.toLocaleString("en")}</td>
      <td className="num">{r.opensea.toLocaleString("en")}</td>
      <td className="num">
        {"$" + r.volumeUsd.toLocaleString("en", { maximumFractionDigits: 0 })}
      </td>
      <td className="num">{r.cancels.toLocaleString("en")}</td>
      <td className={r.lastEvent ? undefined : "dim"}>{fmt(r.lastEvent)}</td>
      <td>
        {r.cursorUpdatedAt === null ? (
          <span className="dim">not indexed</span>
        ) : stale ? (
          <span className="stale">⚠ stale — {fmt(r.cursorUpdatedAt)}</span>
        ) : (
          <span className="dim">{fmt(r.cursorUpdatedAt)}</span>
        )}
      </td>
    </tr>
  );
}

export default function ChainTable({ rows }: { rows: ChainRow[] }) {
  const [showInactive, setShowInactive] = useState(false);
  const now = Date.now();
  const active = rows.filter((r) => r.active);
  const inactive = rows.filter((r) => !r.active);

  return (
    <div className="table-scroll">
      <table>
        <thead>
          <tr>
            <th>Chain</th>
            <th className="num">Chain ID</th>
            <th>Status</th>
            <th className="num">Rarible</th>
            <th className="num">OpenSea</th>
            <th className="num">Volume (USD)</th>
            <th className="num">Cancels</th>
            <th>Last trade</th>
            <th>Indexer</th>
          </tr>
        </thead>
        <tbody>
          {active.map((r) => (
            <Row key={r.chainId} r={r} now={now} />
          ))}
          {showInactive && inactive.map((r) => <Row key={r.chainId} r={r} now={now} />)}
        </tbody>
      </table>
      {inactive.length > 0 && (
        <button className="toggle-inactive" onClick={() => setShowInactive(!showInactive)}>
          {showInactive ? "Hide inactive chains" : `Show ${inactive.length} inactive chains`}
        </button>
      )}
    </div>
  );
}
