/**
 * @roi-dealer/site — public pages of experiments served by `apps/api`: the private preview of a
 * landing (PHASE 19a), the released landing with its funnel counter (PHASE 21), the sign-up form
 * and the privacy notice (PHASE 20). The api maps these handlers to routes and adds the
 * security headers.
 */
export {
  createSubmissionLimiter,
  type SubmissionLimiter,
  type SubmissionLimits,
} from './limits.js';
export {
  ENDED,
  LANDING_STEPS,
  landingPage,
  landingPath,
  MEASUREMENT_NOTE,
  NO_FORM_NOTE,
  NOT_FOUND,
  noticePage,
  previewPage,
  privacyPage,
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
  type PageStage,
  type SiteVisit,
  type TrackedStage,
  type TrackOutcome,
  type TrackTarget,
} from './tracker.js';

export const PACKAGE_NAME = '@roi-dealer/site';
