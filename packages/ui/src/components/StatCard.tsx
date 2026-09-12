import {Card, CardContent, CardDescription, CardHeader, CardTitle} from '@sqlrooms/ui';
import type {FC, ReactNode} from 'react';

export const StatCard: FC<{
  label: string;
  value: ReactNode;
  detail?: ReactNode;
}> = ({label, value, detail}) => (
  <Card className="gap-2 py-4">
    <CardHeader className="px-4">
      <CardDescription>{label}</CardDescription>
      <CardTitle className="text-2xl tabular-nums">{value}</CardTitle>
    </CardHeader>
    {detail ? (
      <CardContent className="text-muted-foreground px-4 text-xs">
        {detail}
      </CardContent>
    ) : null}
  </Card>
);
