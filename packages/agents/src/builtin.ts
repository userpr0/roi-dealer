import {
  assessPains,
  OPPORTUNITY_ANALYST,
  OPPORTUNITY_ANALYST_ACCESS,
  OPPORTUNITY_TASKS,
} from '@roi-dealer/opportunities';
import {
  analyzeEvidence,
  PAIN_ANALYST,
  PAIN_ANALYST_ACCESS,
  SIGNAL_TASKS,
} from '@roi-dealer/signals';
import type { AgentDefinition, AgentReport } from './agent.js';

type Skipped = { readonly status: 'skipped'; readonly reason: string };

function skipped(outcome: Skipped): AgentReport {
  return { outcome: outcome.reason === 'nothing_new' ? 'idle' : 'no_access', processed: 0 };
}

/** The pain analyst of PHASE 06 on the common runner: signals from new evidence, pains. */
export function painAnalystAgent(options: { readonly batchSize?: number } = {}): AgentDefinition {
  return {
    key: PAIN_ANALYST.id,
    actor: PAIN_ANALYST,
    access: PAIN_ANALYST_ACCESS,
    tasks: SIGNAL_TASKS,
    async run(context) {
      const outcome = await analyzeEvidence(context, {
        batchSize: options.batchSize,
        signal: context.signal,
      });
      if (outcome.status === 'skipped') return skipped(outcome);
      return {
        outcome: 'done',
        processed: outcome.analyzed + outcome.translated,
        stoppedBy: outcome.stoppedBy,
      };
    },
  };
}

/** The opportunity analyst of PHASE 07 on the common runner: drafts from repeated pains. */
export function opportunityAnalystAgent(
  options: { readonly batchSize?: number } = {},
): AgentDefinition {
  return {
    key: OPPORTUNITY_ANALYST.id,
    actor: OPPORTUNITY_ANALYST,
    access: OPPORTUNITY_ANALYST_ACCESS,
    tasks: OPPORTUNITY_TASKS,
    async run(context) {
      const outcome = await assessPains(context, {
        batchSize: options.batchSize,
        signal: context.signal,
      });
      if (outcome.status === 'skipped') return skipped(outcome);
      return { outcome: 'done', processed: outcome.assessed, stoppedBy: outcome.stoppedBy };
    },
  };
}
