// Turns the saved readings into what the page draws: each drive's readings, how much it has grown,
// and when it will be full at the rate it has been filling over the last TREND_DAYS days.
const DAY = 86400000;
const TREND_DAYS = Math.max(14, Math.floor(Number(process.env.TREND_DAYS) || 90));
const LOW_PERCENT = Math.min(50, Math.max(1, Number(process.env.LOW_PERCENT) || 10));
const SOON_DAYS = Math.max(1, Math.floor(Number(process.env.SOON_DAYS) || 90));

const dayNumber = (day) => Math.round(Date.parse(`${day}T00:00:00Z`) / DAY);
const dayOf = (n) => new Date(n * DAY).toISOString().slice(0, 10);

// Least-squares straight line through the used space: bytes per day.
function slopeOf(points) {
  const n = points.length;
  const mx = points.reduce((s, p) => s + p.x, 0) / n;
  const my = points.reduce((s, p) => s + p.y, 0) / n;
  let top = 0, bottom = 0;
  for (const p of points) { top += (p.x - mx) * (p.y - my); bottom += (p.x - mx) ** 2; }
  return bottom ? top / bottom : 0;
}

// The used space this many days before the last reading (the nearest reading on or before it).
function usedBefore(points, days) {
  const last = points[points.length - 1];
  const target = dayNumber(last.day) - days;
  let best = null;
  for (const p of points) if (dayNumber(p.day) <= target) best = p;
  return best;
}

function forecast(points) {
  const last = points[points.length - 1];
  const lastN = dayNumber(last.day);
  const recent = points.filter((p) => dayNumber(p.day) > lastN - TREND_DAYS).map((p) => ({ x: dayNumber(p.day), y: p.used }));
  const span = recent.length ? lastN - recent[0].x : 0;
  if (recent.length < 4 || span < 7) return { kind: 'learning', days: 7 - span, trendDays: TREND_DAYS };
  const perDay = slopeOf(recent);
  // Under 1 GB a month (or 0.1% of the drive) counts as steady.
  const steady = Math.max(1024 ** 3, last.size * 0.001) / 30;
  if (perDay <= steady && perDay >= -steady) return { kind: 'steady', perDay, span, trendDays: TREND_DAYS };
  if (perDay < 0) return { kind: 'emptying', perDay, span, trendDays: TREND_DAYS };
  const daysLeft = Math.max(0, Math.round(last.free / perDay));
  // Over 10 years away is as good as not filling up.
  if (daysLeft > 3650) return { kind: 'steady', perDay, span, trendDays: TREND_DAYS, slow: true };
  return { kind: 'filling', perDay, span, daysLeft, fullOn: dayOf(lastN + daysLeft), trendDays: TREND_DAYS };
}

// drives: [{ id, name, url }], readings: [{ day, at, d: { id: [size, used, free] } }], errors: { id: message }
function build(drives, readings, errors) {
  return drives.map((d) => {
    const points = [];
    for (const e of readings) {
      const v = e.d[d.id];
      if (v) points.push({ day: e.day, size: v[0], used: v[1], free: v[2] });
    }
    const out = { id: d.id, name: d.name, url: d.url, kind: d.ssh ? 'ssh' : 'folder', points, error: errors[d.id] || null };
    if (!points.length) return { ...out, status: 'none' };
    const last = points[points.length - 1];
    const ago30 = usedBefore(points, 30);
    out.latest = { ...last, at: (readings.find((e) => e.day === last.day) || {}).at || null };
    out.freePercent = last.size ? (last.free / last.size) * 100 : 0;
    out.change30 = ago30 ? { from: ago30.day, bytes: last.used - ago30.used } : null;
    out.forecast = forecast(points);
    out.status = out.freePercent < LOW_PERCENT ? 'low'
      : out.forecast.kind === 'filling' && out.forecast.daysLeft <= SOON_DAYS ? 'soon' : 'ok';
    return out;
  });
}

module.exports = { build, slopeOf, forecast, TREND_DAYS, LOW_PERCENT, SOON_DAYS };
