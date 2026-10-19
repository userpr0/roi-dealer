/**
 * @roi-dealer/site — public pages of experiments served by `apps/api`: the private preview of a
 * landing (PHASE 19a) and the released landing with its funnel counter (PHASE 21). The api maps
 * these handlers to routes and adds the security headers.
 */
export {
  ENDED,
  LANDING_STEPS,
  landingPage,
  landingPath,
  MEASUREMENT_NOTE,
  NOT_FOUND,
  noticePage,
  previewPage,
  type LandingRouteDeps,
  type LandingStep,
  type SitePage,
} from './pages.js';
export {
  createSiteTracker,
  isVisit,
  SITE_ACCESS,
  SITE_TRACKER,
  TRACKED_STAGES,
  utmOf,
  type SiteTracker,
  type SiteTrackerOptions,
  type SiteVisit,
  type TrackedStage,
  type TrackOutcome,
  type TrackTarget,
} from './tracker.js';

export const PACKAGE_NAME = '@roi-dealer/site';
