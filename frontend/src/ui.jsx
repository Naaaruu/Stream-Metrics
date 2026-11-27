import { useId, useState } from 'react';
import { Bar, BarChart, CartesianGrid, Legend, Line, LineChart, ReferenceLine, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import { clock, COLORS, formatNumber, metricText } from './data/metricDefinitions.js';

export function Card({ children, className = '', ...props }) {
  return <div className={`card ${className}`} {...props}>{children}</div>;
}

export function Badge({ children, variant = 'neutral' }) {
  return <span className={`badge badge-${variant}`}>{children}</span>;
}

export function PageTitle({ title, detail, action }) {
  return <div className="page-title-row"><div><h1>{title}</h1>{detail && <p>{detail}</p>}</div>{action}</div>;
}

export function SectionTitle({ title, detail }) {
  return <div className="section-heading"><div><h2>{title}</h2>{detail && <p>{detail}</p>}</div></div>;
}

export function Detail({ title, children }) {
  const [open, setOpen] = useState(false);
  return <details className="card ui-detail" onToggle={(event) => setOpen(event.currentTarget.open)}>
    <summary>{title}</summary>{open && <div className="ui-detail-content">{children}</div>}
  </details>;
}

export function Metric({ label, unit, digits = 0, value, note, color = 'live' }) {
  return <Card className="metric-card ui-metric" style={{ '--metric-color': COLORS[color] }}>
    <div className="metric-top">{label}</div>
    <div className="metric-number">{formatNumber(value, digits)}{Number.isFinite(value) && <small>{' '}{unit}</small>}</div>
    {note && <p className="metric-helper">{note}</p>}
  </Card>;
}

export function Status({ label, detail }) {
  const color = label === '재생 중' || label === '응답 확인' ? 'green'
    : ['연결 실패', '연결 끊김', '버퍼링', '확인 실패', '적용 일부 성공'].includes(label) ? 'yellow' : 'neutral';
  return <span className="status-label"><Badge variant={color}>{label}</Badge>{detail && <small>{detail}</small>}</span>;
}

export function Empty({ children, action }) {
  return <Card className="ui-empty"><p>{children}</p>{action}</Card>;
}

function ChartTooltip({ active, payload, label, unit, digits }) {
  if (!active || !payload?.length) return null;
  return <div className="chart-tooltip"><strong>{typeof label === 'string' ? label : clock(label)}</strong>
    {payload.filter((item) => Number.isFinite(item.value)).map((item) =>
      <div key={item.dataKey}><span style={{ background: item.color }} />{item.name}<b>{metricText(item.value, { unit, digits })}</b></div>)}
  </div>;
}

export function MetricChart({ metric, samples, color = 'live', lines, marker }) {
  const titleId = useId();
  const series = lines ?? [{ ...metric, color: COLORS[metric.warning ? 'warning' : color], name: metric.label }];
  const hasData = samples.some((row) => series.some(({ key }) => Number.isFinite(row[key])));
  const data = [];
  let previous;
  for (const sample of samples) {
    if (previous?.sessionId && sample.sessionId && previous.sessionId !== sample.sessionId) {
      data.push({ timestamp: (previous.timestamp + sample.timestamp) / 2 });
    }
    data.push(sample);
    previous = sample;
  }
  const first = samples[0]?.timestamp;
  const last = samples.at(-1)?.timestamp;
  // The application marker is kept on the axis while it is near the displayed sample window.
  const showMarker = Number.isFinite(marker) && Number.isFinite(first) && marker >= first - 5000 && marker <= last;
  const domain = hasData ? [showMarker ? Math.min(marker, first) : first, Math.max(last, first + 1000)] : undefined;
  return <Card className="chart-card" role="group" aria-labelledby={titleId}>
    <div className="chart-card-head"><div><h3 id={titleId}>{metric.label}</h3>{metric.note && <p>{metric.note}</p>}</div><span className="chart-unit">{metric.unit}</span></div>
    {Number.isFinite(marker) && <p className="ui-chart-marker">조건 적용 {clock(marker)}{!showMarker && ' · 현재 표시 구간 밖'}</p>}
    {hasData ? <div className="chart-wrap ui-chart">
      <ResponsiveContainer width="100%" height="100%" minWidth={0}>
        <LineChart data={data} margin={{ top: 12, right: 17, left: 3, bottom: 1 }}>
          <CartesianGrid stroke="#27354b" strokeDasharray="4 5" vertical={false} />
          <XAxis dataKey="timestamp" type="number" scale="time" domain={domain} allowDataOverflow
            tickFormatter={(value) => clock(Number(value))} minTickGap={22} tick={{ fill: '#a3b3c7', fontSize: 11 }} axisLine={false} tickLine={false} />
          <YAxis width="auto" domain={[0, 'auto']} allowDecimals={metric.unit !== '회'}
            tickFormatter={(value) => formatNumber(value, metric.digits)} tick={{ fill: '#a3b3c7', fontSize: 11 }} axisLine={false} tickLine={false} />
          <Tooltip content={<ChartTooltip unit={metric.unit} digits={metric.digits} />} />
          {showMarker && <ReferenceLine x={marker} stroke={COLORS.warning} strokeDasharray="4 4" />}
          {series.length > 1 && <Legend iconType="circle" wrapperStyle={{ fontSize: 12 }} />}
          {series.map((line) => <Line key={line.key} dataKey={line.key} name={line.name} type={line.type ?? 'linear'}
            stroke={line.color} strokeWidth={line.scatter ? 0 : 2} connectNulls={false} isAnimationActive={false}
            dot={line.scatter ? { fill: line.color, r: 3 } : { r: 2 }} />)}
        </LineChart>
      </ResponsiveContainer>
    </div> : <div className="ui-chart-empty">미측정</div>}
  </Card>;
}

export function ComparisonBars({ metric, data, series }) {
  const titleId = useId();
  const measured = data.some((row) => series.some(({ key }) => Number.isFinite(row[key])));
  return <Card className="chart-card" role="group" aria-labelledby={titleId}>
    <div className="chart-card-head"><h3 id={titleId}>{metric.label}</h3><span className="chart-unit">{metric.unit}</span></div>
    {measured ? <div className="chart-wrap ui-chart">
      <ResponsiveContainer width="100%" height="100%" minWidth={0}>
        <BarChart data={data} margin={{ top: 8, right: 10, left: 3, bottom: 1 }}>
          <CartesianGrid stroke="#27354b" strokeDasharray="4 5" vertical={false} />
          <XAxis dataKey="label" tick={{ fill: '#a3b3c7', fontSize: 12 }} axisLine={false} tickLine={false} />
          <YAxis width="auto" domain={[0, 'auto']} allowDecimals={metric.unit !== '회'}
            tickFormatter={(value) => formatNumber(value, metric.digits)} tick={{ fill: '#a3b3c7', fontSize: 11 }} axisLine={false} tickLine={false} />
          <Tooltip content={<ChartTooltip unit={metric.unit} digits={metric.digits} />} cursor={{ fill: '#253650' }} />
          {series.length > 1 && <Legend iconType="circle" wrapperStyle={{ fontSize: 12 }} />}
          {series.map(({ key, name, color }) => <Bar key={key} dataKey={key} name={name} fill={color}
            maxBarSize={52} radius={[4, 4, 0, 0]} isAnimationActive={false} />)}
        </BarChart>
      </ResponsiveContainer>
    </div> : <div className="ui-chart-empty">미측정</div>}
  </Card>;
}

