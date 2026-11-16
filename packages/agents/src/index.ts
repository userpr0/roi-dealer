/**
 * @roi-dealer/agents — AI agents (PHASE 10, constitution §2.3, §2.5, §2.6).
 *
 * One definition and one runner for every agent: kill switch → the owner's grant → the agent's
 * work → a row in `agent_runs`; one scheduler runs them one at a time. Agents only propose:
 * candidates, drafts and knowledge through the domain — never decisions, money or access.
 * Agents: pain analyst (PHASE 06), opportunity analyst (PHASE 07), research and market context.
 */
import type { AnyAiTask } from '@roi-dealer/ai-runtime';
import { designHypothesesTask } from './hypotheses/design-hypotheses.js';
import { fileLibraryTask } from './library/file-library.js';
import { marketContextTask } from './market/market-context.js';
import { researchQueryTask } from './research/research-query.js';

export {
  activePrincipal,
  assertAgentsRunning,
  type AgentContext,
  type AgentDefinition,
  type AgentReport,
  type EnsureAccess,
} from './agent.js';
export { opportunityAnalystAgent, painAnalystAgent } from './builtin.js';
export {
  DEMO_METHODS,
  designHypothesesTask,
  MAX_HYPOTHESIS_BUDGET_USD,
  MAX_PRICE_USD,
  MAX_SET_BUDGET_USD,
  MIN_METHODS,
  MIN_PRICES,
  scoreDesignHypotheses,
  toHypothesisSet,
  type DesignHypothesesExpected,
  type DesignHypothesesInput,
  type DesignHypothesesOutput,
} from './hypotheses/design-hypotheses.js';
export {
  DESIGN_ATTEMPTS,
  HYPOTHESIS_DESIGNER,
  HYPOTHESIS_DESIGNER_ACCESS,
  hypothesisDesignerAgent,
} from './hypotheses/designer.js';
export {
  MARKET_ANALYST,
  MARKET_ANALYST_ACCESS,
  marketAnalystAgent,
  storedContext,
} from './market/market-analyst.js';
export {
  formatUsd,
  isEmptyContext,
  marketContextTask,
  marketSummary,
  MAX_MARKET_EXCERPTS,
  parseUsd,
  periodOf,
  scoreMarketContext,
  toMarketContext,
  type MarketContext,
  type MarketContextExpected,
  type MarketContextInput,
  type MarketContextOutput,
} from './market/market-context.js';
export {
  cleanQuery,
  MAX_QUERY_CHARS,
  mentions,
  researchQueryTask,
  scoreResearchQuery,
  toSearchQuery,
  type ResearchQueryExpected,
  type ResearchQueryInput,
  type ResearchQueryOutput,
} from './research/research-query.js';
export {
  RESEARCH_MAX_SIGNALS,
  RESEARCHER,
  RESEARCHER_ACCESS,
  researcherAgent,
  type ResearcherOptions,
} from './research/researcher.js';
export {
  LANDING_ATTEMPTS,
  LANDING_WRITER,
  LANDING_WRITER_ACCESS,
  landingWriterAgent,
} from './landing/writer.js';
export {
  fileLibraryTask,
  MAX_LIBRARY_MOVES,
  MAX_LIBRARY_PROJECTS_SHOWN,
  MAX_LIBRARY_TOPICS,
  MAX_LIBRARY_VERTICALS,
  NEW_PLACE,
  scoreFileLibrary,
  toLibraryChoice,
  type FileLibraryExpected,
  type FileLibraryInput,
  type FileLibraryOutput,
  type LibraryChoice,
} from './library/file-library.js';
export { LIBRARIAN, LIBRARIAN_ACCESS, librarianAgent, libraryInput } from './library/librarian.js';
export { failureCode, runAgent, type RunnerDeps, type RunResult } from './runner.js';
export {
  createAgentScheduler,
  type AgentSchedule,
  type AgentScheduler,
  type AgentSchedulerOptions,
} from './scheduler.js';

/** The AI tasks of the agents of PHASE 10, 14 and 35, for evals in the worker's maintenance. */
export const AGENT_TASKS: readonly AnyAiTask[] = [
  researchQueryTask,
  marketContextTask,
  designHypothesesTask,
  fileLibraryTask,
];

export const PACKAGE_NAME = '@roi-dealer/agents';
