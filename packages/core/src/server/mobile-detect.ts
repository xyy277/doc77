import type { Request } from 'express';

const MOBILE_UA_PATTERN = /Android|webOS|iPhone|iPad|iPod|BlackBerry|IEMobile|Opera Mini|Mobile/i;

export function isMobileRequest(req: Request): boolean {
  const queryView = typeof req.query.view === 'string' ? req.query.view.toLowerCase() : '';
  if (queryView === 'mobile') return true;
  if (queryView === 'desktop') return false;

  const forcedView = req.get('x-doc77-view')?.toLowerCase();
  if (forcedView === 'mobile') return true;
  if (forcedView === 'desktop') return false;

  const userAgent = req.get('user-agent') || '';
  return MOBILE_UA_PATTERN.test(userAgent);
}
