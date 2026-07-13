export type ChainRow = {
  name: string;
  chainId: number;
  active: boolean;
  matches: number;
  cancels: number;
  lastEvent: string | null;
  cursorBlock: number | null;
  cursorUpdatedAt: string | null;
};

const STALE_MS = 24 * 3600 * 1000;

function fmt(iso: string | null): string {
  if (!iso) return "—";
  return new Date(iso).toISOString().slice(0, 16).replace("T", " ") + " UTC";
}

export default function ChainTable({ rows }: { rows: ChainRow[] }) {
  const now = Date.now();
  return (
    <div className="table-scroll">
      <table>
        <thead>
          <tr>
            <th>Chain</th>
            <th className="num">Chain ID</th>
            <th>Status</th>
            <th className="num">Trades</th>
            <th className="num">Cancels</th>
            <th>Last trade</th>
            <th className="num">Cursor block</th>
            <th>Indexer</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => {
            const stale =
              r.active && r.cursorUpdatedAt !== null && now - new Date(r.cursorUpdatedAt).getTime() > STALE_MS;
            return (
              <tr key={r.chainId}>
                <td>{r.name}</td>
                <td className="num">{r.chainId}</td>
                <td>{r.active ? <span className="ok">✓ active</span> : <span className="dim">inactive</span>}</td>
                <td className="num">{r.matches.toLocaleString("en")}</td>
                <td className="num">{r.cancels.toLocaleString("en")}</td>
                <td className={r.lastEvent ? undefined : "dim"}>{fmt(r.lastEvent)}</td>
                <td className="num">{r.cursorBlock?.toLocaleString("en") ?? "—"}</td>
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
          })}
        </tbody>
      </table>
    </div>
  );
}
