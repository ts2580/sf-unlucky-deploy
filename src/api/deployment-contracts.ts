import { Type, type Static } from '@sinclair/typebox';

const RequestedTestLevelSchema = Type.Union([
  Type.Literal('auto'),
  Type.Literal('NoTestRun'),
  Type.Literal('RunSpecifiedTests'),
  Type.Literal('RunLocalTests'),
  Type.Literal('RunAllTestsInOrg'),
  Type.Literal('RunRelevantTests'),
]);

const DeploymentScopeSchema = Type.Union([
  Type.Literal('manifest'),
  Type.Literal('all'),
  Type.Literal('selected'),
]);

const SelectedDeploymentComponentSchema = Type.Object({
  type: Type.String({ minLength: 1 }),
  fullName: Type.String({ minLength: 1 }),
}, { additionalProperties: false });

const DryRunFields = {
  projectId: Type.Optional(Type.String({ minLength: 1 })),
  scope: Type.Optional(DeploymentScopeSchema),
  metadataType: Type.Optional(Type.String({ pattern: '^[A-Za-z][A-Za-z0-9_]*$' })),
  manifest: Type.Optional(Type.String({ minLength: 1 })),
  components: Type.Optional(Type.Array(SelectedDeploymentComponentSchema)),
  sourceId: Type.Optional(Type.String({ minLength: 1 })),
  targetOrgId: Type.Optional(Type.String({ minLength: 1 })),
  testLevel: Type.Optional(RequestedTestLevelSchema),
  tests: Type.Optional(Type.Array(Type.String({ minLength: 1 }))),
  waitMinutes: Type.Optional(Type.Integer({ minimum: 1, maximum: 240 })),
  strict: Type.Optional(Type.Boolean()),
};

export const CreateDryRunRequestSchema = Type.Object(DryRunFields, {
  additionalProperties: false,
});

export const CreateDirectDeploymentRequestSchema = Type.Object({
  ...DryRunFields,
  targetConfirmation: Type.Optional(Type.String({ minLength: 1 })),
  confirmation: Type.Optional(Type.String({ minLength: 1 })),
}, { additionalProperties: false });

export const ExecuteDeploymentRequestSchema = Type.Object({
  dryRunJobId: Type.Optional(Type.String({ minLength: 1 })),
  payloadChecksum: Type.Optional(Type.String({ pattern: '^[a-f0-9]{64}$' })),
  targetAlias: Type.Optional(Type.String({ minLength: 1 })),
  confirmation: Type.Optional(Type.String({ minLength: 1 })),
}, { additionalProperties: false });

const DeploymentStatusSchema = Type.Union([
  Type.Literal('QUEUED'),
  Type.Literal('DRY_RUN_RUNNING'),
  Type.Literal('APPROVAL_PENDING'),
  Type.Literal('DEPLOYING'),
  Type.Literal('SUCCEEDED'),
  Type.Literal('FAILED'),
  Type.Literal('RECONCILE_REQUIRED'),
]);

const RemoteDeploymentStatusSchema = Type.Union([
  Type.Literal('NOT_SUBMITTED'),
  Type.Literal('SUBMITTED'),
  Type.Literal('RUNNING'),
  Type.Literal('SUCCEEDED'),
  Type.Literal('FAILED'),
  Type.Literal('UNKNOWN'),
]);

const SalesforceDiagnosticsSchema = Type.Object({
  componentFailures: Type.Array(Type.Object({
    componentType: Type.Optional(Type.String()),
    fullName: Type.Optional(Type.String()),
    fileName: Type.Optional(Type.String()),
    problemType: Type.Optional(Type.String()),
    problem: Type.String(),
    lineNumber: Type.Optional(Type.Number()),
    columnNumber: Type.Optional(Type.Number()),
  })),
  testFailures: Type.Array(Type.Object({
    name: Type.Optional(Type.String()),
    methodName: Type.Optional(Type.String()),
    message: Type.String(),
    stackTrace: Type.Optional(Type.String()),
    time: Type.Optional(Type.Number()),
  })),
  codeCoverageWarnings: Type.Array(Type.Object({
    name: Type.Optional(Type.String()),
    message: Type.String(),
  })),
  flowCoverageWarnings: Type.Array(Type.Object({
    name: Type.Optional(Type.String()),
    message: Type.String(),
  })),
  messages: Type.Array(Type.String()),
});

const ComparisonSummarySchema = Type.Object({
  added: Type.Number(),
  removed: Type.Number(),
  modified: Type.Number(),
  identical: Type.Number(),
  total: Type.Number(),
  different: Type.Number(),
});

const DeploymentJobSchema = Type.Object({
  id: Type.String(),
  kind: Type.Union([Type.Literal('DRY_RUN'), Type.Literal('DEPLOY')]),
  status: DeploymentStatusSchema,
  source: Type.Object({
    id: Type.String(),
    kind: Type.Union([Type.Literal('org'), Type.Literal('local')]),
    label: Type.String(),
  }),
  target: Type.Object({
    id: Type.String(),
    kind: Type.Union([Type.Literal('org'), Type.Literal('local')]),
    label: Type.String(),
  }),
  manifest: Type.String(),
  scope: Type.Optional(DeploymentScopeSchema),
  metadataType: Type.Optional(Type.String()),
  components: Type.Optional(Type.Array(SelectedDeploymentComponentSchema)),
  prepared: Type.Boolean(),
  payloadChecksum: Type.Optional(Type.String()),
  salesforceDeploymentId: Type.Optional(Type.String()),
  remoteStatus: RemoteDeploymentStatusSchema,
  persistenceWarning: Type.Optional(Type.String()),
  progress: Type.Optional(Type.Object({
    phase: Type.Union([Type.Literal('DRY_RUN'), Type.Literal('DEPLOY')]),
    deploymentId: Type.String(),
    status: Type.String(),
    done: Type.Boolean(),
    success: Type.Optional(Type.Boolean()),
    numberComponentsDeployed: Type.Optional(Type.Number()),
    numberComponentsTotal: Type.Optional(Type.Number()),
    numberComponentErrors: Type.Optional(Type.Number()),
    numberTestsCompleted: Type.Optional(Type.Number()),
    numberTestsTotal: Type.Optional(Type.Number()),
    numberTestErrors: Type.Optional(Type.Number()),
    diagnostics: Type.Optional(SalesforceDiagnosticsSchema),
    checkedAt: Type.String(),
  })),
  testPlan: Type.Optional(Type.Object({
    level: Type.String(),
    tests: Type.Array(Type.String()),
    selection: Type.String(),
  })),
  testCoverage: Type.Optional(Type.Number()),
  comparisonSummary: Type.Optional(ComparisonSummarySchema),
  errorCode: Type.Optional(Type.String()),
  errorMessage: Type.Optional(Type.String()),
  createdAt: Type.String(),
  startedAt: Type.Optional(Type.String()),
  updatedAt: Type.Optional(Type.String()),
  completedAt: Type.Optional(Type.String()),
}, { additionalProperties: true });

export const DeploymentJobResponseSchema = Type.Object({ job: DeploymentJobSchema });
export const DeploymentJobListResponseSchema = Type.Object({
  jobs: Type.Array(DeploymentJobSchema),
});

export type CreateDryRunRequest = Static<typeof CreateDryRunRequestSchema>;
export type CreateDirectDeploymentRequest = Static<typeof CreateDirectDeploymentRequestSchema>;
export type ExecuteDeploymentRequest = Static<typeof ExecuteDeploymentRequestSchema>;
export type DeploymentJobResponse = Static<typeof DeploymentJobSchema>;
export type DeploymentJobEnvelope = Static<typeof DeploymentJobResponseSchema>;
export type DeploymentJobListResponse = Static<typeof DeploymentJobListResponseSchema>;
