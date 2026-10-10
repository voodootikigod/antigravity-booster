import { CircleCheck, CircleX, Info, Lightbulb, TriangleAlert } from 'lucide-react';
import type { ComponentProps, ReactNode } from 'react';

type CalloutType = 'info' | 'tip' | 'warn' | 'warning' | 'error' | 'success' | 'idea';

const ROLE: Record<string, { icon: ReactNode; label: string }> = {
  info: { icon: <Info aria-hidden className="size-4" />, label: 'Note' },
  warning: { icon: <TriangleAlert aria-hidden className="size-4" />, label: 'Warning' },
  error: { icon: <CircleX aria-hidden className="size-4" />, label: 'Error' },
  success: { icon: <CircleCheck aria-hidden className="size-4" />, label: 'Success' },
  idea: { icon: <Lightbulb aria-hidden className="size-4" />, label: 'Tip' },
};

function resolve(type: CalloutType): keyof typeof ROLE {
  if (type === 'warn') return 'warning';
  if (type === 'tip') return 'idea';
  return type;
}

/**
 * Console callout: a toned panel with a full hairline border tinted by role and a leading
 * role icon. Replaces Fumadocs' callout, whose colored side stripe DESIGN.md forbids.
 */
export function Callout({
  type = 'info',
  title,
  icon,
  children,
  className,
  ...props
}: Omit<ComponentProps<'div'>, 'title'> & { type?: CalloutType; title?: ReactNode; icon?: ReactNode }) {
  const role = resolve(type);
  const { icon: roleIcon, label } = ROLE[role] ?? ROLE.info;
  return (
    <div
      role="note"
      aria-label={typeof title === 'string' ? title : label}
      data-callout={role}
      className={`not-prose my-5 flex gap-3 rounded-2xl border p-4 text-sm ${className ?? ''}`}
      {...props}
    >
      <span className="callout-icon mt-0.5 flex size-6 shrink-0 items-center justify-center rounded-full">
        {icon ?? roleIcon}
      </span>
      <div className="flex min-w-0 flex-1 flex-col gap-1.5 leading-relaxed">
        {title ? <p className="font-medium text-fd-foreground">{title}</p> : null}
        <div className="callout-body text-fd-muted-foreground [&_a]:text-(--color-link) [&_a]:underline [&_a]:underline-offset-2 [&_code]:font-mono [&_code]:text-[0.85em] [&_p]:m-0">
          {children}
        </div>
      </div>
    </div>
  );
}
