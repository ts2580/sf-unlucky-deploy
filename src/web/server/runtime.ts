import { DeploymentCoordinator } from '../../deploy/deployment-coordinator.js';
import { DeploymentJobRepository } from '../../deploy/deployment-job-repository.js';
import { SingleJobQueue } from '../../deploy/single-job-queue.js';
import { openSqliteStore, type SqliteStore } from '../../storage/sqlite-store.js';
import { UserRepository } from '../../storage/user-repository.js';
import { AuthService } from '../../auth/auth-service.js';
import { randomBytes } from 'node:crypto';
import path from 'node:path';
import { ProcessSfClient, type SfClient } from '../../salesforce/sf-client.js';
import { ComparisonJobRepository } from '../../compare/comparison-job-repository.js';
import { ComparisonService } from '../../compare/comparison-service.js';
import { WorkspaceService } from './workspace-service.js';
import { DryRunService } from '../../deploy/dry-run-service.js';
import { DeploymentService } from '../../deploy/deployment-service.js';
import { WorkflowEventHub } from './workflow-events.js';
import { UserSettingsRepository } from '../../storage/user-settings-repository.js';
import { prepareRunStorage } from '../../storage/run-storage.js';

export interface WebRuntime {
  store: SqliteStore;
  users: UserRepository;
  settings: UserSettingsRepository;
  deploymentJobs: DeploymentJobRepository;
  deploymentQueue: SingleJobQueue;
  deploymentCoordinator: DeploymentCoordinator;
  auth: AuthService;
  workspace: WorkspaceService;
  comparisonJobs: ComparisonJobRepository;
  comparisonQueue: SingleJobQueue;
  comparisons: ComparisonService;
  dryRuns: DryRunService;
  deployments: DeploymentService;
  workflowEvents: WorkflowEventHub;
  recoveredJobCount: number;
  recoveredComparisonCount: number;
  shutdown(graceMs?: number): Promise<void>;
}

export async function createWebRuntime(
  databasePath: string,
  bootstrapToken?: string,
  projectPaths: string[] = [],
  cwd = process.cwd(),
  sfClient: SfClient = new ProcessSfClient(),
): Promise<WebRuntime> {
  const store = await openSqliteStore({ databasePath });
  const workflowEvents = new WorkflowEventHub();
  const deploymentJobs = new DeploymentJobRepository(
    store.database,
    undefined,
    undefined,
    (job) => workflowEvents.publish({
      resource: 'deployment',
      jobId: job.id,
      kind: job.kind,
      status: job.status,
      updatedAt: job.updatedAt,
    }),
  );
  const recoveredJobCount = await deploymentJobs.recoverInterruptedJobs();
  const deploymentQueue = new SingleJobQueue();
  const userCount = await store.database.get<{ count: number }>('SELECT COUNT(*) count FROM users');
  const auth = new AuthService(
    store.database,
    userCount?.count === 0
      ? bootstrapToken ?? process.env.SFUD_BOOTSTRAP_TOKEN ?? randomBytes(18).toString('base64url')
      : undefined,
  );
  const workspace = await WorkspaceService.create(sfClient, cwd, projectPaths);
  const comparisonJobs = new ComparisonJobRepository(
    store.database,
    undefined,
    undefined,
    (job) => workflowEvents.publish({
      resource: 'comparison',
      jobId: job.id,
      kind: 'COMPARE',
      status: job.status,
      updatedAt: job.updatedAt,
    }),
  );
  const recoveredComparisonCount = await comparisonJobs.recoverInterrupted();
  const comparisonQueue = new SingleJobQueue();
  const runsDirectory = path.join(
    path.dirname(databasePath === ':memory:' ? path.join(cwd, '.sfud', 'sfud.db') : databasePath),
    'runs',
  );
  await prepareRunStorage(runsDirectory);
  const deploymentCoordinator = new DeploymentCoordinator(deploymentJobs, deploymentQueue);
  let shutdownRequest: Promise<void> | undefined;
  const runtime: WebRuntime = {
    store,
    users: new UserRepository(store.database),
    settings: new UserSettingsRepository(store.database),
    deploymentJobs,
    deploymentQueue,
    deploymentCoordinator,
    auth,
    workspace,
    comparisonJobs,
    comparisonQueue,
    comparisons: new ComparisonService(
      comparisonJobs,
      comparisonQueue,
      workspace,
      sfClient,
      runsDirectory,
    ),
    dryRuns: new DryRunService(
      deploymentJobs,
      deploymentCoordinator,
      workspace,
      sfClient,
      runsDirectory,
    ),
    deployments: new DeploymentService(
      deploymentJobs,
      deploymentCoordinator,
      workspace,
      sfClient,
    ),
    workflowEvents,
    recoveredJobCount,
    recoveredComparisonCount,
    shutdown(graceMs = 10_000): Promise<void> {
      if (shutdownRequest !== undefined) return shutdownRequest;
      deploymentQueue.stopAccepting();
      comparisonQueue.stopAccepting();
      shutdownRequest = (async () => {
        const drained = await Promise.all([
          deploymentQueue.waitForIdle(graceMs),
          comparisonQueue.waitForIdle(graceMs),
        ]);
        if (drained.some((value) => !value)) {
          deploymentQueue.abort();
          comparisonQueue.abort();
          const aborted = await Promise.all([
            deploymentQueue.waitForIdle(5_000),
            comparisonQueue.waitForIdle(5_000),
          ]);
          if (aborted.some((value) => !value)) {
            throw new Error('실행 중인 작업이 종료 제한시간 안에 중단되지 않았습니다. 저장소를 닫지 않습니다.');
          }
        }
        await deploymentJobs.recoverInterruptedJobs();
        await comparisonJobs.recoverInterrupted();
        await workspace.close();
        await store.close();
      })();
      return shutdownRequest;
    },
  };
  return runtime;
}
