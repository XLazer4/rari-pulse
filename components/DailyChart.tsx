"use client";

import {
  LineChart,
  Line,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  Legend,
  ResponsiveContainer,
} from "recharts";

const SERIES_VARS = [
  "var(--series-1)",
  "var(--series-2)",
  "var(--series-3)",
  "var(--series-4)",
  "var(--series-5)",
  "var(--series-6)",
  "var(--series-7)",
];

function colorFor(name: string, i: number): string {
  return name === "Other" ? "var(--series-other)" : SERIES_VARS[i % SERIES_VARS.length];
}

function shortDay(day: string): string {
  const d = new Date(day + "T00:00:00Z");
  return d.toLocaleDateString("en", { month: "short", day: "numeric", timeZone: "UTC" });
}

function usd(v: number): string {
  return Intl.NumberFormat("en", {
    style: "currency",
    currency: "USD",
    notation: "compact",
    maximumFractionDigits: 1,
  }).format(v);
}

export default function DailyChart({
  data,
  series,
  yFormat,
}: {
  data: Record<string, number | string>[];
  series: string[];
  yFormat?: "usd";
}) {
  if (series.length === 0) {
    return <p className="dim">No trades in this period.</p>;
  }
  const yFormatter = yFormat === "usd" ? usd : (v: number) => v.toLocaleString("en");
  return (
    <ResponsiveContainer width="100%" height={320}>
      <LineChart data={data} margin={{ top: 4, right: 12, bottom: 0, left: 0 }}>
        <CartesianGrid stroke="var(--grid)" vertical={false} />
        <XAxis
          dataKey="day"
          tickFormatter={shortDay}
          tick={{ fill: "var(--muted)", fontSize: 12 }}
          tickLine={false}
          axisLine={{ stroke: "var(--baseline)" }}
          minTickGap={24}
        />
        <YAxis
          allowDecimals={false}
          tick={{ fill: "var(--muted)", fontSize: 12 }}
          tickLine={false}
          axisLine={false}
          width={44}
          tickFormatter={yFormatter}
        />
        <Tooltip
          formatter={yFormat ? (v) => yFormatter(Number(v)) : undefined}
          labelFormatter={(day) => shortDay(String(day))}
          itemSorter={(item) => -Number(item.value)}
          contentStyle={{
            background: "var(--surface)",
            border: "1px solid var(--border)",
            borderRadius: 8,
            color: "var(--ink)",
            fontSize: 13,
          }}
          labelStyle={{ color: "var(--ink-2)", marginBottom: 4 }}
          itemStyle={{ color: "var(--ink)", padding: 0 }}
          cursor={{ stroke: "var(--baseline)", strokeWidth: 1 }}
        />
        <Legend
          iconType="plainline"
          wrapperStyle={{ fontSize: 13, color: "var(--ink-2)" }}
        />
        {series.map((name, i) => (
          <Line
            key={name}
            type="monotone"
            dataKey={name}
            stroke={colorFor(name, i)}
            strokeWidth={2}
            dot={false}
            activeDot={{ r: 4, stroke: "var(--surface)", strokeWidth: 2 }}
            isAnimationActive={false}
          />
        ))}
      </LineChart>
    </ResponsiveContainer>
  );
}
