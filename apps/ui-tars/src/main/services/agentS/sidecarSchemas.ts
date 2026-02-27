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

const hasActionSource = (value: {
  actions?: ActionLike[];
  action?: ActionLike;
  nextAction?: ActionLike;
  next_action?: ActionLike;
  code?: ActionLike;
  prediction?: ActionLike;
}) => {
  return (
    (Array.isArray(value.actions) && value.actions.length > 0) ||
    value.action !== undefined ||
    value.nextAction !== undefined ||
    value.next_action !== undefined ||
    value.code !== undefined ||
    value.prediction !== undefined
  );
};

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

const HealthyPayloadSchema = z.union([
  z
    .object({
      healthy: z.literal(true),
      status: HealthyStatusSchema.optional(),
    })
    .passthrough(),
  z
    .object({
      status: HealthyStatusSchema,
      healthy: z.literal(true).optional(),
    })
    .passthrough(),
]);

type PredictionCandidate = z.infer<typeof PredictionCandidateSchema>;
type PredictionEnvelope = z.infer<typeof PredictionEnvelopeSchema>;

export type SidecarPredictionResult = {
  action: AgentSActionLikeInput;
  predictionText: string;
};

const pickPredictionFromCandidate = (
  candidate: PredictionCandidate,
): SidecarPredictionResult | null => {
  const actionSources: ActionLike[] = [];

  if (candidate.actions?.length) {
    actionSources.push(candidate.actions[0]);
  }

  if (candidate.action !== undefined) {
    actionSources.push(candidate.action);
  }
  if (candidate.nextAction !== undefined) {
    actionSources.push(candidate.nextAction);
  }
  if (candidate.next_action !== undefined) {
    actionSources.push(candidate.next_action);
  }
  if (candidate.code !== undefined) {
    actionSources.push(candidate.code);
  }
  if (candidate.prediction !== undefined) {
    actionSources.push(candidate.prediction);
  }

  for (const source of actionSources) {
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
