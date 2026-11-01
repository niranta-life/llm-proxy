export type ChartPoint = { x: number; y: number };
export type ChartSeries = { name: string; color: string; points: ChartPoint[] };

export type LineChartInput = {
  title: string;
  xLabel: string;
  yLabel: string;
  series: ChartSeries[];
};

function escapeXml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&apos;');
}

function extent(values: number[], fallbackMax: number): { min: number; max: number } {
  if (values.length === 0) return { min: 0, max: fallbackMax };
  let min = values[0]!;
  let max = values[0]!;
  for (const value of values) {
    if (value < min) min = value;
    if (value > max) max = value;
  }
  if (min === max) {
    if (min === 0) return { min: 0, max: fallbackMax };
    return { min: min * 0.9, max: max * 1.1 };
  }
  return { min, max };
}

export function lineChart(input: LineChartInput): string {
  const width = 800;
  const height = 420;
  const margin = { top: 48, right: 24, bottom: 56, left: 64 };
  const plotW = width - margin.left - margin.right;
  const plotH = height - margin.top - margin.bottom;

  const xs: number[] = [];
  const ys: number[] = [];
  for (const series of input.series) {
    for (const point of series.points) {
      xs.push(point.x);
      ys.push(point.y);
    }
  }
  const xExt = extent(xs, 1);
  const yExt = extent(ys, 1);
  const xSpan = xExt.max - xExt.min || 1;
  const ySpan = yExt.max - yExt.min || 1;

  const mapX = (x: number): number => margin.left + ((x - xExt.min) / xSpan) * plotW;
  const mapY = (y: number): number => margin.top + plotH - ((y - yExt.min) / ySpan) * plotH;

  const parts: string[] = [];
  parts.push(
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">`,
  );
  parts.push(`<rect width="${width}" height="${height}" fill="#ffffff"/>`);
  parts.push(
    `<text x="${width / 2}" y="28" text-anchor="middle" font-family="sans-serif" font-size="16">${escapeXml(input.title)}</text>`,
  );
  parts.push(
    `<line x1="${margin.left}" y1="${margin.top}" x2="${margin.left}" y2="${margin.top + plotH}" stroke="#333" stroke-width="1"/>`,
  );
  parts.push(
    `<line x1="${margin.left}" y1="${margin.top + plotH}" x2="${margin.left + plotW}" y2="${margin.top + plotH}" stroke="#333" stroke-width="1"/>`,
  );
  parts.push(
    `<text x="${margin.left + plotW / 2}" y="${height - 16}" text-anchor="middle" font-family="sans-serif" font-size="12">${escapeXml(input.xLabel)}</text>`,
  );
  parts.push(
    `<text x="18" y="${margin.top + plotH / 2}" text-anchor="middle" font-family="sans-serif" font-size="12" transform="rotate(-90 18 ${margin.top + plotH / 2})">${escapeXml(input.yLabel)}</text>`,
  );

  for (const series of input.series) {
    if (series.points.length === 0) continue;
    const points = series.points
      .map((point) => `${mapX(point.x).toFixed(2)},${mapY(point.y).toFixed(2)}`)
      .join(' ');
    parts.push(
      `<polyline fill="none" stroke="${escapeXml(series.color)}" stroke-width="2" points="${points}"/>`,
    );
  }

  let legendX = margin.left;
  const legendY = margin.top - 18;
  for (const series of input.series) {
    parts.push(
      `<rect x="${legendX}" y="${legendY}" width="10" height="10" fill="${escapeXml(series.color)}"/>`,
    );
    parts.push(
      `<text x="${legendX + 14}" y="${legendY + 10}" font-family="sans-serif" font-size="11">${escapeXml(series.name)}</text>`,
    );
    legendX += 14 + series.name.length * 7 + 16;
  }

  parts.push('</svg>');
  return parts.join('');
}

export function barChart(input: {
  title: string;
  yLabel: string;
  bars: { name: string; value: number; color: string }[];
}): string {
  const width = 800;
  const height = 420;
  const margin = { top: 48, right: 24, bottom: 72, left: 64 };
  const plotW = width - margin.left - margin.right;
  const plotH = height - margin.top - margin.bottom;
  const values = input.bars.map((bar) => bar.value).filter((value) => Number.isFinite(value) && value > 0);
  const peak = values.reduce((highest, value) => Math.max(highest, value), 0);
  const scale = peak > 0 ? peak : 1;
  const slot = input.bars.length === 0 ? plotW : plotW / input.bars.length;
  const parts: string[] = [];
  parts.push(`<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">`);
  parts.push(`<rect width="${width}" height="${height}" fill="#ffffff"/>`);
  parts.push(
    `<text x="${width / 2}" y="28" text-anchor="middle" font-family="sans-serif" font-size="16">${escapeXml(input.title)}</text>`,
  );
  parts.push(
    `<line x1="${margin.left}" y1="${margin.top}" x2="${margin.left}" y2="${margin.top + plotH}" stroke="#333" stroke-width="1"/>`,
  );
  parts.push(
    `<line x1="${margin.left}" y1="${margin.top + plotH}" x2="${margin.left + plotW}" y2="${margin.top + plotH}" stroke="#333" stroke-width="1"/>`,
  );
  parts.push(
    `<text x="18" y="${margin.top + plotH / 2}" text-anchor="middle" font-family="sans-serif" font-size="12" transform="rotate(-90 18 ${margin.top + plotH / 2})">${escapeXml(input.yLabel)}</text>`,
  );
  input.bars.forEach((bar, index) => {
    const barW = Math.max(8, slot * 0.6);
    const x = margin.left + index * slot + (slot - barW) / 2;
    const h = Math.max(0, (bar.value / scale) * plotH);
    const y = margin.top + plotH - h;
    let label: string;
    if (bar.value >= 100) label = bar.value.toFixed(0);
    else if (bar.value >= 1) label = bar.value.toFixed(2);
    else label = bar.value.toFixed(4);
    parts.push(`<rect x="${x.toFixed(2)}" y="${y.toFixed(2)}" width="${barW.toFixed(2)}" height="${h.toFixed(2)}" fill="${escapeXml(bar.color)}"/>`);
    parts.push(
      `<text x="${(x + barW / 2).toFixed(2)}" y="${(y - 6).toFixed(2)}" text-anchor="middle" font-family="sans-serif" font-size="11">${escapeXml(label)}</text>`,
    );
    parts.push(
      `<text x="${(x + barW / 2).toFixed(2)}" y="${margin.top + plotH + 18}" text-anchor="middle" font-family="sans-serif" font-size="11">${escapeXml(bar.name)}</text>`,
    );
  });
  parts.push('</svg>');
  return parts.join('');
}
