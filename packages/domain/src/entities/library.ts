import { z } from 'zod';
import {
  assertOwner,
  mutableMeta,
  mutableMetaShape,
  parseEntity,
  transition,
  type CreateContext,
  type DomainContext,
} from '../entity.js';
import { DomainError } from '../errors.js';
import {
  libraryProjectIdSchema,
  libraryTopicIdSchema,
  libraryVerticalIdSchema,
  type Actor,
  type LibraryProjectId,
  type LibraryTopicId,
  type LibraryVerticalId,
  type Timestamp,
} from '../primitives.js';
import { defineStateMachine } from '../state-machine.js';

/*
 * The library (phase 35, ADR-0016): vertical → project → topic. Everything the system works on
 * is filed under a topic — by the librarian agent or by code; the owner only moves what was
 * filed wrongly. Filing is not a decision about money, tests or publishing (§2.3).
 */

export const LIBRARY_STATUSES = ['active', 'archived'] as const;
export type LibraryStatus = (typeof LIBRARY_STATUSES)[number];

/** Bounds of the tree: it stays readable on a phone. */
export const LIBRARY_LIMITS = { verticals: 20, projectsPerVertical: 50, topicsPerProject: 200 };

export const MIN_LIBRARY_NAME = 2;
export const MAX_LIBRARY_NAME = 60;

/**
 * A name of a vertical, project or topic: letters, digits and plain punctuation in one line.
 * No slash: it separates the levels in `/library add` and in the export paths.
 */
export const libraryNameSchema = z
  .string()
  .transform((value) => value.trim().replace(/\s+/g, ' '))
  .pipe(
    z
      .string()
      .min(MIN_LIBRARY_NAME)
      .max(MAX_LIBRARY_NAME)
      .regex(
        /^[\p{L}\p{N}][\p{L}\p{N} .,&+№()%«»"'’:–—-]*$/u,
        'letters, digits, plain punctuation',
      ),
  );

/** Names are compared without case and with «ё» as «е»: «Недвижимость» = «недвижимость». */
export function libraryNameKey(name: string): string {
  return name.trim().replace(/\s+/g, ' ').toLowerCase().replaceAll('ё', 'е');
}

const nodeShape = {
  name: libraryNameSchema,
  status: z.enum(LIBRARY_STATUSES),
  ...mutableMetaShape,
};

export const libraryVerticalSchema = z.object({ id: libraryVerticalIdSchema, ...nodeShape });
export type LibraryVertical = z.infer<typeof libraryVerticalSchema>;

export const libraryProjectSchema = z.object({
  id: libraryProjectIdSchema,
  verticalId: libraryVerticalIdSchema,
  ...nodeShape,
});
export type LibraryProject = z.infer<typeof libraryProjectSchema>;

export const libraryTopicSchema = z.object({
  id: libraryTopicIdSchema,
  projectId: libraryProjectIdSchema,
  ...nodeShape,
});
export type LibraryTopic = z.infer<typeof libraryTopicSchema>;

export const libraryVerticalLifecycle = defineStateMachine<LibraryStatus>('library_vertical', {
  active: ['archived'],
  archived: ['active'],
});
export const libraryProjectLifecycle = defineStateMachine<LibraryStatus>('library_project', {
  active: ['archived'],
  archived: ['active'],
});
export const libraryTopicLifecycle = defineStateMachine<LibraryStatus>('library_topic', {
  active: ['archived'],
  archived: ['active'],
});

/** The owner, an agent (the librarian) or code of the system file things; nobody else. */
function assertFiler(actor: Actor): void {
  if (actor.type !== 'owner' && actor.type !== 'agent' && actor.type !== 'system') {
    throw new DomainError('permission_denied', 'Only the owner, an agent or the system files', {
      actor_type: actor.type,
    });
  }
}

export function createLibraryVertical(
  name: string,
  context: CreateContext<LibraryVerticalId>,
): LibraryVertical {
  assertFiler(context.actor);
  return parseEntity(libraryVerticalSchema, 'library_vertical', {
    id: context.id,
    name,
    status: 'active',
    ...mutableMeta(context),
  });
}

export function createLibraryProject(
  data: { readonly verticalId: LibraryVerticalId; readonly name: string },
  context: CreateContext<LibraryProjectId>,
): LibraryProject {
  assertFiler(context.actor);
  return parseEntity(libraryProjectSchema, 'library_project', {
    ...data,
    id: context.id,
    status: 'active',
    ...mutableMeta(context),
  });
}

export function createLibraryTopic(
  data: { readonly projectId: LibraryProjectId; readonly name: string },
  context: CreateContext<LibraryTopicId>,
): LibraryTopic {
  assertFiler(context.actor);
  return parseEntity(libraryTopicSchema, 'library_topic', {
    ...data,
    id: context.id,
    status: 'active',
    ...mutableMeta(context),
  });
}

/** Only the owner archives a topic or brings it back; its filings stay in the journal. */
export function setLibraryTopicStatus(
  topic: LibraryTopic,
  status: LibraryStatus,
  context: DomainContext,
): LibraryTopic {
  assertOwner(context.actor, 'archive or restore a library topic');
  return transition(topic, libraryTopicLifecycle, libraryTopicSchema, status, context);
}

/** The active tree as filing sees it. */
export interface LibraryTree {
  readonly verticals: readonly LibraryVertical[];
  readonly projects: readonly LibraryProject[];
  readonly topics: readonly LibraryTopic[];
}

/** Where something goes: names of the three levels, as the owner or the model gave them. */
export interface LibraryPlace {
  readonly vertical: string;
  readonly project: string;
  readonly topic: string;
}

export type LibraryPlan =
  | {
      readonly ok: true;
      /** The existing nodes the names match; absent ones are created with `names`. */
      readonly vertical?: LibraryVertical | undefined;
      readonly project?: LibraryProject | undefined;
      readonly topic?: LibraryTopic | undefined;
      /** The checked names, as they will be stored. */
      readonly names: LibraryPlace;
    }
  | {
      readonly ok: false;
      readonly reason:
        'invalid_name' | 'too_many_verticals' | 'too_many_projects' | 'too_many_topics';
    };

/**
 * Checks a place against the tree (code, never the model): the names are valid, an existing
 * node with the same name is reused, and a new node fits the limits of the tree.
 */
export function planLibraryPlace(tree: LibraryTree, place: LibraryPlace): LibraryPlan {
  const parsed = z
    .object({ vertical: libraryNameSchema, project: libraryNameSchema, topic: libraryNameSchema })
    .safeParse(place);
  if (!parsed.success) return { ok: false, reason: 'invalid_name' };
  const names = parsed.data;
  const vertical = tree.verticals.find(
    (item) => libraryNameKey(item.name) === libraryNameKey(names.vertical),
  );
  if (vertical === undefined) {
    if (tree.verticals.length >= LIBRARY_LIMITS.verticals) {
      return { ok: false, reason: 'too_many_verticals' };
    }
    return { ok: true, names };
  }
  const projects = tree.projects.filter((item) => item.verticalId === vertical.id);
  const project = projects.find(
    (item) => libraryNameKey(item.name) === libraryNameKey(names.project),
  );
  if (project === undefined) {
    if (projects.length >= LIBRARY_LIMITS.projectsPerVertical) {
      return { ok: false, reason: 'too_many_projects' };
    }
    return { ok: true, vertical, names };
  }
  const topics = tree.topics.filter((item) => item.projectId === project.id);
  const topic = topics.find((item) => libraryNameKey(item.name) === libraryNameKey(names.topic));
  if (topic === undefined && topics.length >= LIBRARY_LIMITS.topicsPerProject) {
    return { ok: false, reason: 'too_many_topics' };
  }
  return { ok: true, vertical, project, topic, names };
}

/** «Вертикаль › Проект › Тема» of a topic, or undefined when the tree does not hold it. */
export function libraryPath(tree: LibraryTree, topicId: LibraryTopicId): string | undefined {
  const topic = tree.topics.find((item) => item.id === topicId);
  const project = tree.projects.find((item) => item.id === topic?.projectId);
  const vertical = tree.verticals.find((item) => item.id === project?.verticalId);
  return topic === undefined || project === undefined || vertical === undefined
    ? undefined
    : `${vertical.name} › ${project.name} › ${topic.name}`;
}

/** The nodes a place adds to the tree, and the topic the place ends in. */
export interface LibraryNodes {
  readonly vertical?: LibraryVertical | undefined;
  readonly project?: LibraryProject | undefined;
  /** The topic, when it is new. */
  readonly created?: LibraryTopic | undefined;
  readonly topic: LibraryTopic;
}

/**
 * The nodes a place needs that the tree does not have yet, created as `context.actor`; an
 * existing topic with the same name is returned as it is. `nextId` gives a new UUID.
 */
export function newLibraryNodes(
  tree: LibraryTree,
  place: LibraryPlace,
  context: { readonly actor: Actor; readonly at: Timestamp },
  nextId: () => string,
): LibraryNodes | { readonly rejected: Extract<LibraryPlan, { ok: false }>['reason'] } {
  const plan = planLibraryPlace(tree, place);
  if (!plan.ok) return { rejected: plan.reason };
  if (plan.topic !== undefined) return { topic: plan.topic };
  const vertical =
    plan.vertical === undefined
      ? createLibraryVertical(plan.names.vertical, {
          ...context,
          id: libraryVerticalIdSchema.parse(nextId()),
        })
      : undefined;
  const verticalId = (plan.vertical ?? vertical)?.id;
  if (verticalId === undefined) return { rejected: 'invalid_name' };
  const project =
    plan.project === undefined
      ? createLibraryProject(
          { verticalId, name: plan.names.project },
          { ...context, id: libraryProjectIdSchema.parse(nextId()) },
        )
      : undefined;
  const projectId = (plan.project ?? project)?.id;
  if (projectId === undefined) return { rejected: 'invalid_name' };
  const topic = createLibraryTopic(
    { projectId, name: plan.names.topic },
    { ...context, id: libraryTopicIdSchema.parse(nextId()) },
  );
  return { vertical, project, created: topic, topic };
}

/** The tree with the new nodes of a place added. */
export function withLibraryNodes(tree: LibraryTree, nodes: LibraryNodes): LibraryTree {
  return {
    verticals: nodes.vertical === undefined ? tree.verticals : [...tree.verticals, nodes.vertical],
    projects: nodes.project === undefined ? tree.projects : [...tree.projects, nodes.project],
    topics: nodes.created === undefined ? tree.topics : [...tree.topics, nodes.created],
  };
}
