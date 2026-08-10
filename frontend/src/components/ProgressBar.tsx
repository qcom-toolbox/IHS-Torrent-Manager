export default function ProgressBar({ fraction, level }: { fraction: number; level?: 'normal' | 'warning' | 'critical' }) {
  const pct = Math.max(0, Math.min(100, Math.round(fraction * 100)));
  const color =
    level === 'critical'
      ? 'bg-red-500'
      : level === 'warning'
      ? 'bg-amber-500'
      : pct >= 100
      ? 'bg-emerald-500'
      : 'bg-blue-500';
  return (
    <div className="w-full">
      <div className="h-2 w-full overflow-hidden rounded-full bg-slate-200 dark:bg-slate-700">
        <div className={`h-full rounded-full ${color} transition-all`} style={{ width: `${pct}%` }} />
      </div>
    </div>
  );
}
