import { addCollection, Icon } from '@iconify/react/offline';
import type { IconifyJSON } from '@iconify/types';
import type { CSSProperties } from 'react';
import iconSets from '../../lib/icons.generated.json';
import { cn } from '../../lib/utils';

// The bundle is registered at import time, so the first render already has every icon.
for (const set of iconSets as unknown as IconifyJSON[]) addCollection(set);

interface AppIconProps {
  icon: string;
  size?: number;
  className?: string;
  style?: CSSProperties;
}

export function AppIcon({ icon, size = 16, className, style }: AppIconProps) {
  return <Icon icon={icon} width={size} height={size} className={cn('shrink-0', className)} style={style} aria-hidden="true" />;
}
