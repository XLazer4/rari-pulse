"use client";

import { useRouter } from "next/navigation";

const PRESETS = [7, 30, 90] as const;

function isoDay(d: Date): string {
  return d.toISOString().slice(0, 10);
}

export default function DateRange({ from, to }: { from: string; to: string }) {
  const router = useRouter();

  const apply = (nextFrom: string, nextTo: string) => {
    router.replace(`/?from=${nextFrom}&to=${nextTo}`);
  };

  const presetFor = (days: number) => isoDay(new Date(Date.now() - (days - 1) * 86400_000));
  const isToday = to === isoDay(new Date());

  return (
    <div className="filters">
      {PRESETS.map((days) => (
        <button
          key={days}
          className="preset"
          data-active={isToday && from === presetFor(days)}
          onClick={() => apply(presetFor(days), isoDay(new Date()))}
        >
          Last {days} days
        </button>
      ))}
      <span className="dates">
        <input type="date" value={from} max={to} onChange={(e) => e.target.value && apply(e.target.value, to)} />
        →
        <input type="date" value={to} min={from} onChange={(e) => e.target.value && apply(from, e.target.value)} />
      </span>
    </div>
  );
}
