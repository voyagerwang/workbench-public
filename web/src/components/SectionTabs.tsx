import { NavLink } from 'react-router-dom';
import { cn } from '@/lib/utils';

export function SectionTabs({ items }: { items: Array<{ to: string; label: string; end?: boolean }> }) {
  return (
    <div className="inline-flex rounded-lg border border-line bg-surface-1 p-1">
      {items.map((item) => (
        <NavLink
          key={item.to}
          to={item.to}
          end={item.end}
          className={({ isActive }) => cn(
            'rounded-md px-3 py-1.5 text-xs font-medium transition-colors',
            isActive ? 'bg-surface-3 text-ink' : 'text-ink-3 hover:text-ink-2',
          )}
        >
          {item.label}
        </NavLink>
      ))}
    </div>
  );
}
