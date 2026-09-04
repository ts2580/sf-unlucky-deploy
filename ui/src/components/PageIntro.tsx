import type { ReactNode } from 'react';

export function PageIntro({ kicker, title, description, children }: {
  kicker: string;
  title: string;
  description?: string;
  children?: ReactNode;
}) {
  return (
    <header className="page-intro">
      <div><p className="eyebrow text-blue-700">{kicker}</p><h2>{title}</h2>{description !== undefined && <p>{description}</p>}</div>
      {children}
    </header>
  );
}
