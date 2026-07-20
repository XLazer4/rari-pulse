import { supabase } from "@/lib/supabase";
import DateRange from "@/components/DateRange";
import DailyChart from "@/components/DailyChart";
import SourceChart from "@/components/SourceChart";
import ChainTable, { type ChainRow } from "@/components/ChainTable";

export const dynamic = "force-dynamic";

type Daily = { day: string; chain_id: number; matches: number; cancels: number };
type SourceDaily = { day: string; source: string; trades: number };
type DailyVolume = { day: string; chain_id: number; volume_usd: number };
type SourceVolume = { source: string; volume_usd: number };
type Stat = {
  chain_id: number;
  matches: number;
  opensea: number;
  cancels: number;
  volume_usd: number;
  last_event: string | null;
};
type ChainMeta = { chain_id: number; name: string; active: boolean };
type Cursor = { chain_id: number; updated_at: string };

const MAX_SERIES = 7; // top chains get their own line, the rest fold into "Other"
const SOURCE_ORDER = ["Rarible", "OpenSea", "Blur", "X2Y2", "LooksRare", "Sudoswap"];

function isoDay(d: Date): string {
  return d.toISOString().slice(0, 10);
}

function compact(n: number): string {
  return Intl.NumberFormat("en", { notation: "compact", maximumFractionDigits: 1 }).format(n);
}

function usd(n: number): string {
  return Intl.NumberFormat("en", {
    style: "currency",
    currency: "USD",
    notation: "compact",
    maximumFractionDigits: 1,
  }).format(n);
}

export default async function Home({
  searchParams,
}: {
  searchParams: Promise<{ from?: string; to?: string }>;
}) {
  const params = await searchParams;
  const today = new Date();
  const to = params.to ?? isoDay(today);
  const from = params.from ?? isoDay(new Date(today.getTime() - 29 * 86400_000));
  const toExclusive = new Date(new Date(to + "T00:00:00Z").getTime() + 86400_000).toISOString();
  const fromTs = from + "T00:00:00Z";

  const [daily, sources, volumes, sourceVolumes, stats, chains, cursors] = await Promise.all([
    supabase.rpc("daily_counts", { from_ts: fromTs, to_ts: toExclusive }),
    supabase.rpc("daily_source_counts", { from_ts: fromTs, to_ts: toExclusive }),
    supabase.rpc("daily_volume", { from_ts: fromTs, to_ts: toExclusive }),
    supabase.rpc("source_volume", { from_ts: fromTs, to_ts: toExclusive }),
    supabase.rpc("chain_stats", { from_ts: fromTs, to_ts: toExclusive }),
    supabase.from("chains").select("chain_id, name, active"),
    supabase.from("indexer_cursors").select("chain_id, updated_at"),
  ]);
  const err =
    daily.error ??
    sources.error ??
    volumes.error ??
    sourceVolumes.error ??
    stats.error ??
    chains.error ??
    cursors.error;
  if (err) throw new Error(`query failed: ${err.message}`);

  const dailyRows = (daily.data ?? []) as Daily[];
  const sourceRows = (sources.data ?? []) as SourceDaily[];
  const volumeRows = (volumes.data ?? []) as DailyVolume[];
  const sourceVolumeRows = (sourceVolumes.data ?? []) as SourceVolume[];
  const statRows = (stats.data ?? []) as Stat[];
  const chainRows = (chains.data ?? []) as ChainMeta[];
  const cursorRows = (cursors.data ?? []) as Cursor[];

  const nameById = new Map(chainRows.map((c) => [c.chain_id, c.name]));
  const statById = new Map(statRows.map((s) => [s.chain_id, s]));
  const cursorById = new Map(cursorRows.map((c) => [c.chain_id, c]));

  // top chains by matches in range → named series, rest → "Other"
  const ranked = [...statRows].sort((a, b) => b.matches - a.matches);
  const topIds = ranked
    .slice(0, MAX_SERIES)
    .filter((s) => s.matches > 0)
    .map((s) => s.chain_id);
  const seriesNames = topIds.map((id) => nameById.get(id) ?? String(id));
  const hasOther = dailyRows.some((r) => !topIds.includes(r.chain_id) && r.matches > 0);

  // one row per day in range, zero-filled
  const days: string[] = [];
  for (let t = new Date(fromTs).getTime(); t < new Date(toExclusive).getTime(); t += 86400_000) {
    days.push(isoDay(new Date(t)));
  }
  const chartData = days.map((day) => {
    const row: Record<string, number | string> = { day };
    for (const name of seriesNames) row[name] = 0;
    if (hasOther) row.Other = 0;
    for (const r of dailyRows) {
      if (r.day !== day) continue;
      const key = topIds.includes(r.chain_id) ? nameById.get(r.chain_id)! : "Other";
      if (key in row) row[key] = (row[key] as number) + r.matches;
    }
    return row;
  });

  // volume chart: same top-N/Other fold, ranked by USD volume in range
  const volRanked = [...statRows].sort((a, b) => Number(b.volume_usd) - Number(a.volume_usd));
  const volTopIds = volRanked
    .slice(0, MAX_SERIES)
    .filter((s) => Number(s.volume_usd) > 0)
    .map((s) => s.chain_id);
  const volSeriesNames = volTopIds.map((id) => nameById.get(id) ?? String(id));
  const hasOtherVol = volumeRows.some(
    (r) => !volTopIds.includes(r.chain_id) && Number(r.volume_usd) > 0
  );
  const volumeChartData = days.map((day) => {
    const row: Record<string, number | string> = { day };
    for (const name of volSeriesNames) row[name] = 0;
    if (hasOtherVol) row.Other = 0;
    for (const r of volumeRows) {
      if (r.day !== day) continue;
      const key = volTopIds.includes(r.chain_id) ? nameById.get(r.chain_id)! : "Other";
      if (key in row) row[key] = Math.round(((row[key] as number) + Number(r.volume_usd)) * 100) / 100;
    }
    return row;
  });

  // sources in fixed display order (color follows source), unknowns appended
  const sourceTotals = new Map<string, number>();
  for (const r of sourceRows) {
    sourceTotals.set(r.source, (sourceTotals.get(r.source) ?? 0) + Number(r.trades));
  }
  const sourceNames = [...sourceTotals.keys()]
    .filter((s) => sourceTotals.get(s)! > 0)
    .sort((a, b) => {
      const ia = SOURCE_ORDER.indexOf(a);
      const ib = SOURCE_ORDER.indexOf(b);
      return (ia === -1 ? SOURCE_ORDER.length : ia) - (ib === -1 ? SOURCE_ORDER.length : ib);
    });
  const sourceChartData = days.map((day) => {
    const row: Record<string, number | string> = { day };
    for (const name of sourceNames) row[name] = 0;
    for (const r of sourceRows) {
      if (r.day === day && r.source in row) row[r.source] = Number(r.trades);
    }
    return row;
  });

  const totalMatches = statRows.reduce((n, s) => n + Number(s.matches), 0);
  const totalOpensea = statRows.reduce((n, s) => n + Number(s.opensea), 0);
  const volumeBySource = new Map(sourceVolumeRows.map((r) => [r.source, Number(r.volume_usd)]));
  const totalCancels = statRows.reduce((n, s) => n + Number(s.cancels), 0);
  const activeCount = chainRows.filter((c) => c.active).length;
  const lastEvent = statRows
    .map((s) => s.last_event)
    .filter(Boolean)
    .sort()
    .at(-1);

  const tableRows: ChainRow[] = chainRows
    .map((c) => {
      const s = statById.get(c.chain_id);
      const cur = cursorById.get(c.chain_id);
      return {
        name: c.name,
        chainId: c.chain_id,
        active: c.active,
        matches: Number(s?.matches ?? 0),
        opensea: Number(s?.opensea ?? 0),
        volumeUsd: Number(s?.volume_usd ?? 0),
        cancels: Number(s?.cancels ?? 0),
        lastEvent: s?.last_event ?? null,
        cursorUpdatedAt: cur?.updated_at ?? null,
      };
    })
    .sort((a, b) => Number(b.active) - Number(a.active) || b.matches - a.matches);

  return (
    <div className="wrap">
      <div className="header">
        <h1>rari-pulse</h1>
        <span className="sub">Rarible protocol activity across chains</span>
      </div>
      <DateRange from={from} to={to} />
      <div className="tiles">
        <div className="tile">
          <div className="label">Rarible trades</div>
          <div className="value">{compact(totalMatches)}</div>
          <div className="note">
            {from} → {to}
          </div>
        </div>
        <div className="tile">
          <div className="label">OpenSea trades</div>
          <div className="value">{compact(totalOpensea)}</div>
          <div className="note">via Rarible wrapper</div>
        </div>
        <div className="tile">
          <div className="label">Rarible volume</div>
          <div className="value">{usd(volumeBySource.get("Rarible") ?? 0)}</div>
          <div className="note">priced trades only</div>
        </div>
        <div className="tile">
          <div className="label">OpenSea volume</div>
          <div className="value">{usd(volumeBySource.get("OpenSea") ?? 0)}</div>
          <div className="note">via Rarible wrapper</div>
        </div>
        <div className="tile">
          <div className="label">Other venues volume</div>
          <div className="value">{usd(volumeBySource.get("Other") ?? 0)}</div>
          <div className="note">LooksRare, Blur, X2Y2, Sudoswap</div>
        </div>
        <div className="tile">
          <div className="label">Cancels</div>
          <div className="value">{compact(totalCancels)}</div>
          <div className="note">same period</div>
        </div>
        <div className="tile">
          <div className="label">Active chains</div>
          <div className="value">{activeCount}</div>
          <div className="note">of {chainRows.length} monitored</div>
        </div>
        <div className="tile">
          <div className="label">Latest indexed trade</div>
          <div className="value">{lastEvent ? timeAgo(lastEvent) : "—"}</div>
          <div className="note">{lastEvent ? new Date(lastEvent).toUTCString().slice(5, 22) + " UTC" : "no data yet"}</div>
        </div>
      </div>
      <div className="card">
        <h2>Trades per day</h2>
        <DailyChart data={chartData} series={hasOther ? [...seriesNames, "Other"] : seriesNames} />
      </div>
      <div className="card">
        <h2>Volume per day (USD)</h2>
        <DailyChart
          data={volumeChartData}
          series={hasOtherVol ? [...volSeriesNames, "Other"] : volSeriesNames}
          yFormat="usd"
        />
      </div>
      <div className="card">
        <h2>Trades by source</h2>
        {sourceNames.length > 0 && (
          <p className="dim">
            {sourceNames.map((s) => `${s} ${compact(sourceTotals.get(s)!)}`).join(" · ")}
          </p>
        )}
        <SourceChart data={sourceChartData} series={sourceNames} />
      </div>
      <div className="card">
        <h2>Chains</h2>
        <ChainTable rows={tableRows} />
      </div>
    </div>
  );
}

function timeAgo(iso: string): string {
  const s = Math.floor((Date.now() - new Date(iso).getTime()) / 1000);
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}
