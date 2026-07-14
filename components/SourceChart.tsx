"use client";

import {
  BarChart,
  Bar,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  Legend,
  ResponsiveContainer,
} from "recharts";

// color follows the source, never its rank in the current range
const SOURCE_COLORS: Record<string, string> = {
  Rarible: "var(--series-1)",
  OpenSea: "var(--series-2)",
  Blur: "var(--series-3)",
  X2Y2: "var(--series-4)",
  LooksRare: "var(--series-5)",
  Sudoswap: "var(--series-6)",
};

function colorFor(name: string): string {
  return SOURCE_COLORS[name] ?? "var(--series-other)";
}

function shortDay(day: string): string {
  const d = new Date(day + "T00:00:00Z");
  return d.toLocaleDateString("en", { month: "short", day: "numeric", timeZone: "UTC" });
}

export default function SourceChart({
  data,
  series,
}: {
  data: Record<string, number | string>[];
  series: string[];
}) {
  if (series.length === 0) {
    return <p className="dim">No trades in this period.</p>;
  }
  return (
    <ResponsiveContainer width="100%" height={320}>
      <BarChart data={data} margin={{ top: 4, right: 12, bottom: 0, left: 0 }}>
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
          tickFormatter={(v: number) => v.toLocaleString("en")}
        />
        <Tooltip
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
          cursor={{ fill: "var(--baseline)", opacity: 0.2 }}
        />
        <Legend iconType="square" wrapperStyle={{ fontSize: 13, color: "var(--ink-2)" }} />
        {series.map((name, i) => (
          <Bar
            key={name}
            dataKey={name}
            stackId="sources"
            fill={colorFor(name)}
            stroke="var(--surface)"
            strokeWidth={1}
            radius={i === series.length - 1 ? [3, 3, 0, 0] : undefined}
            isAnimationActive={false}
          />
        ))}
      </BarChart>
    </ResponsiveContainer>
  );
}
