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

export interface WebRuntime {
  store: SqliteStore;
  users: UserRepository;
  deploymentJobs: DeploymentJobRepository;
  deploymentQueue: SingleJobQueue;
  deploymentCoordinator: DeploymentCoordinator;
  auth: AuthService;
  workspace: WorkspaceService;
  comparisonJobs: ComparisonJobRepository;
  comparisonQueue: SingleJobQueue;
  comparisons: ComparisonService;
  dryRuns: DryRunService;
  recoveredJobCount: number;
  recoveredComparisonCount: number;
}

export async function createWebRuntime(
  databasePath: string,
  bootstrapToken?: string,
  projectPaths: string[] = [],
  cwd = process.cwd(),
  sfClient: SfClient = new ProcessSfClient(),
): Promise<WebRuntime> {
  const store = await openSqliteStore({ databasePath });
  const deploymentJobs = new DeploymentJobRepository(store.database);
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
  const comparisonJobs = new ComparisonJobRepository(store.database);
  const recoveredComparisonCount = await comparisonJobs.recoverInterrupted();
  const comparisonQueue = new SingleJobQueue();
  const runsDirectory = path.join(
    path.dirname(databasePath === ':memory:' ? path.join(cwd, '.sfud', 'sfud.db') : databasePath),
    'runs',
  );
  const deploymentCoordinator = new DeploymentCoordinator(deploymentJobs, deploymentQueue);
  return {
    store,
    users: new UserRepository(store.database),
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
    recoveredJobCount,
    recoveredComparisonCount,
  };
}
