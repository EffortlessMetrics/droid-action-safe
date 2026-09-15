import { z } from "zod";

const relativePath = z
  .string()
  .min(1)
  .max(512)
  .refine((value) => !value.startsWith("/"), "path must be relative")
  .refine(
    (value) => !value.split(/[\\/]/).includes(".."),
    "path must not traverse upward",
  );

export const ReviewCommentSchema = z
  .object({
    path: relativePath,
    body: z.string().min(1).max(12_000),
    line: z.number().int().positive(),
    startLine: z.number().int().positive().nullable().optional().default(null),
    side: z.enum(["RIGHT", "LEFT"]),
    commit_id: z.string().regex(/^[0-9a-f]{40}$/),
  })
  .superRefine((comment, context) => {
    if (comment.startLine !== null && comment.startLine > comment.line) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["startLine"],
        message: "startLine must be less than or equal to line",
      });
    }
  });

export const CandidateDocumentSchema = z.object({
  version: z.literal(1),
  meta: z.object({
    repo: z.string().min(3).max(256),
    prNumber: z.number().int().positive(),
    headSha: z.string().regex(/^[0-9a-f]{40}$/),
    baseRef: z.string().min(1).max(256),
    generatedAt: z.string().datetime({ offset: true }),
  }),
  comments: z.array(ReviewCommentSchema).max(50),
  reviewSummary: z.object({
    body: z.string().min(1).max(12_000),
  }),
});

export const ValidatedResultSchema = z.discriminatedUnion("status", [
  z.object({
    status: z.literal("approved"),
    comment: ReviewCommentSchema,
  }),
  z.object({
    status: z.literal("rejected"),
    candidate: ReviewCommentSchema,
    reason: z.string().min(1).max(4_000),
  }),
]);

export const ValidatedDocumentSchema = z.object({
  version: z.literal(1),
  meta: z.object({
    repo: z.string().min(3).max(256),
    prNumber: z.number().int().positive(),
    headSha: z.string().regex(/^[0-9a-f]{40}$/),
    baseRef: z.string().min(1).max(256),
    validatedAt: z.string().datetime({ offset: true }),
  }),
  results: z.array(ValidatedResultSchema).max(50),
  reviewSummary: z.object({
    status: z.literal("approved"),
    body: z.string().min(1).max(12_000),
  }),
});

export const ReviewStateSchema = z.object({
  repository: z.string().min(3).max(256),
  owner: z.string().min(1).max(128),
  repo: z.string().min(1).max(128),
  prNumber: z.number().int().positive(),
  headSha: z.string().regex(/^[0-9a-f]{40}$/),
  headRef: z.string().min(1).max(256),
  baseRef: z.string().min(1).max(256),
  workspace: z.string().min(1),
  promptsDir: z.string().min(1),
  isolatedCwd: z.string().min(1),
  descriptionPath: z.string().min(1),
  diffPath: z.string().min(1),
  commentsPath: z.string().min(1),
  candidatesPath: z.string().min(1),
  validatedPath: z.string().min(1),
  candidatePromptPath: z.string().min(1),
  validatorPromptPath: z.string().min(1),
  trackingCommentId: z.number().int().positive(),
  eventName: z.string().min(1),
});

export type ReviewComment = z.infer<typeof ReviewCommentSchema>;
export type CandidateDocument = z.infer<typeof CandidateDocumentSchema>;
export type ValidatedDocument = z.infer<typeof ValidatedDocumentSchema>;
export type ReviewState = z.infer<typeof ReviewStateSchema>;

export function assertDocumentIdentity(
  state: ReviewState,
  meta: {
    repo: string;
    prNumber: number;
    headSha: string;
    baseRef: string;
  },
): void {
  const expected = {
    repo: state.repository,
    prNumber: state.prNumber,
    headSha: state.headSha,
    baseRef: state.baseRef,
  };
  for (const key of Object.keys(expected) as Array<keyof typeof expected>) {
    if (meta[key] !== expected[key]) {
      throw new Error(
        `review document ${key} mismatch: expected ${expected[key]}, got ${meta[key]}`,
      );
    }
  }
}
