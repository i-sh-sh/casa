export type Tone = 'tone-1' | 'tone-2' | 'tone-3' | 'tone-4' | 'tone-ink3' | 'tone-blank' | 'tone-red';

/**
 * A whole, split into its parts, in one line of ink.
 *
 * The figures stay in the rows beside it — a bar is read for proportion and a
 * number for its value, and asking one to do the other's job is how charts
 * end up with labels printed on top of them. So the bar is decoration to a
 * screen reader, and carries its sentence in `label` for anyone who asks.
 */
export function Bar({ parts, label }: { parts: { value: number; tone: Tone }[]; label?: string }) {
  const total = parts.reduce((s, p) => s + Math.max(0, p.value), 0);
  if (total <= 0) return null;
  return (
    <span className="bar" role={label ? 'img' : undefined} aria-label={label} aria-hidden={label ? undefined : true}>
      {parts.map((p, i) => p.value > 0 && (
        <i key={i} className={p.tone} style={{ width: `${(p.value / total) * 100}%` }} />
      ))}
    </span>
  );
}
