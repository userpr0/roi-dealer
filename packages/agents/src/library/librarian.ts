import { AiTaskError } from '@roi-dealer/ai-runtime';
import {
  storeLibraryNodes,
  type AgentStop,
  type AgentWorkOutcome,
  type AgentWorkResult,
} from '@roi-dealer/database';
import {
  libraryPath,
  newLibraryNodes,
  toTimestamp,
  withLibraryNodes,
  type Actor,
  type LibraryTopicId,
  type LibraryTree,
  type NewPrincipal,
  type Pain,
} from '@roi-dealer/domain';
import { uuidv7 } from '@roi-dealer/shared';
import { painTerms, termSimilarity } from '@roi-dealer/signals';
import {
  activePrincipal,
  assertAgentsRunning,
  type AgentContext,
  type AgentDefinition,
  type AgentReport,
} from '../agent.js';
import {
  fileLibraryTask,
  MAX_LIBRARY_MOVES,
  MAX_LIBRARY_PROJECTS_SHOWN,
  MAX_LIBRARY_TOPICS,
  MAX_LIBRARY_VERTICALS,
  toLibraryChoice,
  type FileLibraryInput,
} from './file-library.js';

/** The agent identity the library is filed as (PHASE 04): the owner grants it in /decisions. */
export const LIBRARIAN: Actor = { type: 'agent', id: 'librarian' };

export const LIBRARIAN_ACCESS: NewPrincipal = {
  actor: LIBRARIAN,
  displayName: 'Библиотекарь',
  purpose:
    'Раскладывает найденные боли и возможности по библиотеке: вертикаль → проект → тема. Сам ' +
    'создаёт недостающие папки; код проверяет названия и лимиты дерева. Ничего не решает и не ' +
    'тратит: вы переносите то, что легло не туда, в /library. AI — в пределах 2 % дневной квоты.',
};

const DEFAULT_BATCH = 5;
/** Pains already filed that the closest topics are found by. */
const KNOWN_PAINS = 1_000;

function clip(text: string, max: number): string {
  const trimmed = text.trim().replace(/\s+/g, ' ');
  return trimmed.length <= max ? trimmed : `${trimmed.slice(0, max - 1).trimEnd()}…`;
}

function stopOf(error: AiTaskError): AgentStop {
  return error.code === 'budget' || error.code === 'unavailable' ? error.code : 'failed';
}

/** A pain already in the library: the words its topic is found by. */
interface FiledPain {
  readonly topicId: LibraryTopicId;
  readonly title: string;
  readonly terms: ReadonlySet<string>;
  readonly byOwner: boolean;
}

/** What the model sees for one pain, and the topic behind each key. */
export function libraryInput(
  pain: Pick<Pain, 'title' | 'audience'>,
  tree: LibraryTree,
  filed: readonly FiledPain[],
): { readonly input: FileLibraryInput; readonly topicOf: ReadonlyMap<string, LibraryTopicId> } {
  const terms = painTerms(`${pain.title} ${pain.audience}`);
  // A topic is as close as its closest pain; the words of pains are English, the names are not.
  const closest = new Map<LibraryTopicId, { score: number; example: string }>();
  for (const item of filed) {
    const score = termSimilarity(terms, item.terms);
    const best = closest.get(item.topicId);
    if (best === undefined || score > best.score) {
      closest.set(item.topicId, { score, example: item.title });
    }
  }
  const topics = [...closest.entries()]
    .flatMap(([topicId, best]) => {
      const path = libraryPath(tree, topicId);
      return path === undefined ? [] : [{ topicId, path, ...best }];
    })
    .sort((a, b) => b.score - a.score)
    .slice(0, MAX_LIBRARY_TOPICS);
  const topicOf = new Map(topics.map((topic, index) => [`T${String(index + 1)}`, topic.topicId]));
  const moves = filed
    .filter((item) => item.byOwner)
    .slice(0, MAX_LIBRARY_MOVES)
    .flatMap((item) => {
      const path = libraryPath(tree, item.topicId);
      return path === undefined ? [] : [{ title: clip(item.title, 300), path: clip(path, 200) }];
    });
  return {
    input: {
      item: { title: clip(pain.title, 300), audience: clip(pain.audience, 200) },
      topics: topics.map((topic, index) => ({
        key: `T${String(index + 1)}`,
        path: clip(topic.path, 200),
        example: clip(topic.example, 300),
      })),
      tree: tree.verticals.slice(0, MAX_LIBRARY_VERTICALS).map((vertical) => ({
        vertical: vertical.name,
        projects: tree.projects
          .filter((project) => project.verticalId === vertical.id)
          .slice(0, MAX_LIBRARY_PROJECTS_SHOWN)
          .map((project) => project.name),
      })),
      moves,
    },
    topicOf,
  };
}

/**
 * The librarian (phase 35, ADR-0016): files every new pain under a topic — an existing one the
 * AI names, or a new place whose names code checks — and puts each opportunity where its first
 * filed pain is, without AI. Filing is not a decision: the owner moves what went wrong.
 */
export function librarianAgent(options: { readonly batchSize?: number } = {}): AgentDefinition {
  return {
    key: LIBRARIAN.id,
    actor: LIBRARIAN,
    access: LIBRARIAN_ACCESS,
    tasks: [fileLibraryTask],

    async run(context: AgentContext): Promise<AgentReport> {
      const { database, logger } = context;
      await assertAgentsRunning(database);
      if ((await activePrincipal(database, LIBRARIAN)) === undefined) {
        return { outcome: 'no_access', processed: 0 };
      }
      const pains = await database.library.pendingPains({
        agent: LIBRARIAN.id,
        limit: options.batchSize ?? DEFAULT_BATCH,
      });

      let processed = 0;
      let filedPains = 0;
      let stoppedBy: AgentStop | undefined;
      if (pains.length > 0) {
        let tree = await database.library.tree();
        const filings = await database.library.filings({ objectType: 'pain', limit: KNOWN_PAINS });
        const known = await database.repositories.pains.getByIds(
          filings.map((filing) => filing.objectId as Pain['id']),
        );
        const painOf = new Map(known.map((pain) => [pain.id as string, pain]));
        const filed: FiledPain[] = filings.flatMap((filing) => {
          const pain = painOf.get(filing.objectId);
          return pain === undefined
            ? []
            : [
                {
                  topicId: filing.topicId,
                  title: pain.title,
                  terms: painTerms(`${pain.title} ${pain.audience}`),
                  byOwner: filing.byOwner,
                },
              ];
        });
        const entry = (
          pain: Pain,
          outcome: AgentWorkOutcome,
          correlationId: string,
          result: AgentWorkResult = {},
        ) => ({
          agent: LIBRARIAN.id,
          subjectType: 'pain' as const,
          subjectId: pain.id,
          subjectVersion: pain.version,
          task: fileLibraryTask.name,
          taskVersion: fileLibraryTask.version,
          outcome,
          result,
          actorType: LIBRARIAN.type,
          actorId: LIBRARIAN.id,
          correlationId,
        });

        for (const pain of pains) {
          if (context.signal.aborted || stoppedBy !== undefined) break;
          const correlationId = `library-${pain.id}-v${String(pain.version)}`;
          const { input, topicOf } = libraryInput(pain, tree, filed);
          let choice: ReturnType<typeof toLibraryChoice>;
          try {
            const answer = await context.runtime.runTask(fileLibraryTask, input, {
              actor: LIBRARIAN,
              correlationId,
              signal: context.signal,
            });
            choice = toLibraryChoice(answer, [...topicOf.keys()]);
          } catch (error) {
            if (!(error instanceof AiTaskError)) throw error;
            if (error.code === 'invalid_input') {
              await database.agentWork.record(entry(pain, 'rejected', correlationId));
              processed += 1;
              continue;
            }
            if (error.code === 'failed') {
              await database.agentWork.record(entry(pain, 'failed', correlationId));
              processed += 1;
            }
            stoppedBy = stopOf(error);
            break;
          }
          processed += 1;
          if (choice === undefined) {
            await database.agentWork.record(entry(pain, 'rejected', correlationId));
            continue;
          }
          const at = toTimestamp(new Date(context.now()));
          const existing = choice.kind === 'existing' ? topicOf.get(choice.key) : undefined;
          const nodes =
            choice.kind === 'new'
              ? newLibraryNodes(tree, choice.place, { actor: LIBRARIAN, at }, uuidv7)
              : undefined;
          if (nodes !== undefined && 'rejected' in nodes) {
            await database.agentWork.record(
              entry(pain, 'rejected', correlationId, { reason: nodes.rejected }),
            );
            continue;
          }
          const topicId = existing ?? nodes?.topic.id;
          if (topicId === undefined) {
            await database.agentWork.record(entry(pain, 'rejected', correlationId));
            continue;
          }
          await database.transaction(
            async (scope) => {
              if (nodes !== undefined) await storeLibraryNodes(scope.repositories, nodes);
              await scope.library.file({
                objectType: 'pain',
                objectId: pain.id,
                topicId,
                actorType: 'agent',
                actorId: LIBRARIAN.id,
                correlationId,
              });
              await scope.agentWork.record(
                entry(pain, 'done', correlationId, {
                  topic: topicId,
                  new_topic: nodes?.created !== undefined,
                }),
              );
            },
            { correlationId },
          );
          filedPains += 1;
          if (nodes !== undefined) tree = withLibraryNodes(tree, nodes);
          filed.push({
            topicId,
            title: pain.title,
            terms: painTerms(`${pain.title} ${pain.audience}`),
            byOwner: false,
          });
        }
      }

      // Opportunities follow their pains: code, no AI.
      let filedOpportunities = 0;
      if (stoppedBy === undefined && !context.signal.aborted) {
        for (const item of await database.library.pendingOpportunities()) {
          await database.library.file({
            objectType: 'opportunity',
            objectId: item.opportunityId,
            topicId: item.topicId,
            actorType: 'agent',
            actorId: LIBRARIAN.id,
            correlationId: `library-opportunity-${item.opportunityId}`,
          });
          filedOpportunities += 1;
        }
      }
      processed += filedOpportunities;

      logger.info('library', {
        pains: filedPains,
        opportunities: filedOpportunities,
        processed,
        stopped_by: stoppedBy,
      });
      if (processed === 0 && stoppedBy === undefined) return { outcome: 'idle', processed: 0 };
      return { outcome: 'done', processed, stoppedBy };
    },
  };
}
