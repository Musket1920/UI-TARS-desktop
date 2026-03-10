import { z } from 'zod';

import type { AgentSActionLikeInput } from './actionTranslator';

const normalizeStatus = (value: unknown) => {
  if (typeof value !== 'string') {
    return value;
  }

  const normalized = value.trim().toLowerCase();
  return normalized === '' ? value : normalized;
};

const AgentSActionObjectSchema = z
  .object({
    action: z.string().trim().min(1).optional(),
    action_type: z.string().trim().min(1).optional(),
    type: z.string().trim().min(1).optional(),
    name: z.string().trim().min(1).optional(),
    action_inputs: z.record(z.unknown()).optional(),
    args: z.record(z.unknown()).optional(),
    arguments: z.record(z.unknown()).optional(),
    params: z.record(z.unknown()).optional(),
    thought: z.string().optional(),
    reflection: z.string().nullable().optional(),
  })
  .passthrough()
  .refine(
    (value) =>
      Boolean(value.action || value.action_type || value.type || value.name),
    {
      message: 'Missing required action field in object payload',
    },
  );

const ActionLikeSchema = z.union([
  z.string().trim().min(1),
  AgentSActionObjectSchema,
]);

type ActionLike = z.infer<typeof ActionLikeSchema>;

const countActionSources = (value: {
  actions?: ActionLike[];
  action?: ActionLike;
  nextAction?: ActionLike;
  next_action?: ActionLike;
  code?: ActionLike;
  prediction?: ActionLike;
}) => {
  let count = 0;

  if (Array.isArray(value.actions) && value.actions.length > 0) {
    count += 1;
  }
  if (value.action !== undefined) {
    count += 1;
  }
  if (value.nextAction !== undefined) {
    count += 1;
  }
  if (value.next_action !== undefined) {
    count += 1;
  }
  if (value.code !== undefined) {
    count += 1;
  }
  if (value.prediction !== undefined) {
    count += 1;
  }

  return count;
};

const hasActionSource = (value: {
  actions?: ActionLike[];
  action?: ActionLike;
  nextAction?: ActionLike;
  next_action?: ActionLike;
  code?: ActionLike;
  prediction?: ActionLike;
}) => countActionSources(value) > 0;

const hasMultipleActionSources = (value: {
  actions?: ActionLike[];
  action?: ActionLike;
  nextAction?: ActionLike;
  next_action?: ActionLike;
  code?: ActionLike;
  prediction?: ActionLike;
}) => countActionSources(value) > 1;

const PredictionCandidateSchema = z
  .object({
    actions: z.array(ActionLikeSchema).nonempty().optional(),
    action: ActionLikeSchema.optional(),
    nextAction: ActionLikeSchema.optional(),
    next_action: ActionLikeSchema.optional(),
    code: ActionLikeSchema.optional(),
    prediction: ActionLikeSchema.optional(),
  })
  .passthrough()
  .refine((value) => hasActionSource(value), {
    message: 'Missing prediction action fields',
  });

const PredictionEnvelopeSchema = z
  .object({
    actions: z.array(ActionLikeSchema).nonempty().optional(),
    action: ActionLikeSchema.optional(),
    nextAction: ActionLikeSchema.optional(),
    next_action: ActionLikeSchema.optional(),
    code: ActionLikeSchema.optional(),
    prediction: ActionLikeSchema.optional(),
    data: PredictionCandidateSchema.optional(),
    result: PredictionCandidateSchema.optional(),
  })
  .passthrough()
  .refine(
    (value) =>
      hasActionSource(value) ||
      value.data !== undefined ||
      value.result !== undefined,
    {
      message: 'Missing prediction payload markers',
    },
  );

const HealthyStatusSchema = z.preprocess(
  normalizeStatus,
  z.enum(['ok', 'healthy', 'running', 'up']),
);

const ExplicitHealthyStatusSchema = z.preprocess(
  normalizeStatus,
  z.enum(['ok', 'healthy', 'up']),
);

const HealthyPayloadSchema = z.union([
  z
    .object({
      healthy: z.literal(true),
      status: HealthyStatusSchema.optional(),
    })
    .passthrough(),
  z
    .object({
      status: ExplicitHealthyStatusSchema,
      healthy: z.literal(true).optional(),
    })
    .passthrough(),
]);

type PredictionCandidate = z.infer<typeof PredictionCandidateSchema>;
type PredictionEnvelope = z.infer<typeof PredictionEnvelopeSchema>;

const predictionSourcePriority: ReadonlyArray<
  (candidate: PredictionCandidate) => ActionLike | undefined
> = [
  (candidate) => candidate.actions?.[0],
  (candidate) => candidate.action,
  (candidate) => candidate.nextAction,
  (candidate) => candidate.next_action,
  (candidate) => candidate.code,
  (candidate) => candidate.prediction,
];

export type SidecarPredictionResult = {
  action: AgentSActionLikeInput;
  predictionText: string;
};

const pickPredictionFromCandidate = (
  candidate: PredictionCandidate,
): SidecarPredictionResult | null => {
  // If multiple action-like sources are present, preserve the legacy
  // first-source-wins behavior by checking them in this explicit order.
  for (const pickSource of predictionSourcePriority) {
    const source = pickSource(candidate);
    if (source === undefined) {
      continue;
    }

    return {
      action: source,
      predictionText:
        typeof candidate.prediction === 'string'
          ? candidate.prediction
          : typeof source === 'string'
            ? source
            : JSON.stringify(source),
    };
  }

  return null;
};

export const parseSidecarPredictionPayload = (
  payload: unknown,
): SidecarPredictionResult | null => {
  const treatAsMultiSourceEnvelope =
    typeof payload === 'object' &&
    payload !== null &&
    hasMultipleActionSources(payload as PredictionCandidate);

  if (!treatAsMultiSourceEnvelope) {
    const direct = ActionLikeSchema.safeParse(payload);
    if (direct.success) {
      return {
        action: direct.data,
        predictionText:
          typeof direct.data === 'string'
            ? direct.data
            : JSON.stringify(direct.data),
      };
    }
  }

  const envelope = PredictionEnvelopeSchema.safeParse(payload);
  if (!envelope.success) {
    return null;
  }

  const root: PredictionEnvelope = envelope.data;
  const candidates: PredictionCandidate[] = [root];
  if (root.data) {
    candidates.push(root.data);
  }
  if (root.result) {
    candidates.push(root.result);
  }

  for (const candidate of candidates) {
    const parsed = pickPredictionFromCandidate(candidate);
    if (parsed) {
      return parsed;
    }
  }

  return null;
};

export const isExplicitHealthyHealthPayload = (payload: unknown): boolean => {
  return HealthyPayloadSchema.safeParse(payload).success;
};
