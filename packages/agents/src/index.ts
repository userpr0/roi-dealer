/**
 * @roi-dealer/agents — AI agents (PHASE 10, constitution §2.3, §2.5, §2.6).
 *
 * One definition and one runner for every agent: kill switch → the owner's grant → the agent's
 * work → a row in `agent_runs`; one scheduler runs them one at a time. Agents only propose:
 * candidates, drafts and knowledge through the domain — never decisions, money or access.
 * Agents: pain analyst (PHASE 06), opportunity analyst (PHASE 07), research and market context.
 */
import type { AnyAiTask } from '@roi-dealer/ai-runtime';
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
export { failureCode, runAgent, type RunnerDeps, type RunResult } from './runner.js';
export {
  createAgentScheduler,
  type AgentSchedule,
  type AgentScheduler,
  type AgentSchedulerOptions,
} from './scheduler.js';

/** The AI tasks of the PHASE 10 agents, for evals in the worker's maintenance. */
export const AGENT_TASKS: readonly AnyAiTask[] = [researchQueryTask, marketContextTask];

export const PACKAGE_NAME = '@roi-dealer/agents';
