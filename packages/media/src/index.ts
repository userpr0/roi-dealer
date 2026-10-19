/**
 * @roi-dealer/media — Media Factory (PHASE 19a, D-022): the landing page of a test and its ad
 * texts. The AI task `write-landing` writes the words; `toLandingContent` checks them (no
 * invented proof, numbers only from the input, no links, English); the price and the honesty
 * note come from code; `renderLanding` builds the static page.
 */
import type { AnyAiTask } from '@roi-dealer/ai-runtime';
import { writeLandingTask } from './write-landing.js';

export {
  disclosureText,
  landingDisclosure,
  priceLabel,
  toLandingContent,
  type LandingAnswer,
} from './landing.js';
export {
  escapeHtml,
  landingSlug,
  newPreviewToken,
  renderLanding,
  type LandingPageOptions,
} from './render.js';
export {
  checkLanding,
  landingSource,
  scoreWriteLanding,
  writeLandingTask,
  type WriteLandingExpected,
  type WriteLandingInput,
  type WriteLandingOutput,
} from './write-landing.js';

/** The AI tasks of the Media Factory, for the worker's evals and budget. */
export const MEDIA_TASKS: readonly AnyAiTask[] = [writeLandingTask];

export const PACKAGE_NAME = '@roi-dealer/media';
