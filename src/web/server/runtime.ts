import { GitCache } from '../../git/git-cache.js';
import path from 'node:path';
import { GitRegistrationService } from '../../git/git-registration-service.js';
import { GitRepositoryAccess } from '../../git/git-repository-access.js';
import { GitRepositoryCatalog } from '../../git/git-repository-catalog.js';
import { GitConnectionService } from '../../git/git-connection-service.js';
import { GitTokenService } from '../../git/git-token-service.js';
import { GitImportRepository } from '../../storage/git-import-repository.js';
import { GitImportService } from '../../git/git-import-service.js';
import { JobAccessRepository } from '../../storage/job-access-repository.js';
import { OrgExecutionAccessRepository } from '../../storage/org-execution-access-repository.js';
import { GitConnectionRepository } from '../../storage/git-connection-repository.js';
import { TokenVault } from '../../git/token-vault.js';
import { DeploymentCoordinator } from '../../deploy/deployment-coordinator.js';
import {
  DeploymentExecutionLeaseRepository,
  deploymentExecutionLeaseMsFromEnvironment,
} from '../../deploy/deployment-execution-lease-repository.js';
import {
  DeploymentAdmissionRepository,
  deploymentAdmissionLeaseMsFromEnvironment,
} from '../../deploy/deployment-admission-repository.js';
import { DeploymentJobRepository } from '../../deploy/deployment-job-repository.js';
import { SingleJobQueue } from '../../deploy/single-job-queue.js';
import { openSqliteStore, type SqliteStore } from '../../storage/sqlite-store.js';
import { UserRepository } from '../../storage/user-repository.js';
import { AuthService } from '../../auth/auth-service.js';
import { randomBytes } from 'node:crypto';
import { ProcessSfClient, type SfClient } from '../../salesforce/sf-client.js';
import { UserSfClient } from '../../salesforce/user-sf-client.js';
import { SalesforceConnectionRepository } from '../../storage/salesforce-connection-repository.js';
import { ComparisonJobRepository } from '../../compare/comparison-job-repository.js';
import { ComparisonService } from '../../compare/comparison-service.js';
import { WorkspaceService, type WorkspaceServiceOptions } from './workspace-service.js';
import { DryRunService } from '../../deploy/dry-run-service.js';
import { DeploymentService } from '../../deploy/deployment-service.js';
import { WorkflowEventHub } from './workflow-events.js';
import { UserSettingsRepository } from '../../storage/user-settings-repository.js';
import { RuntimeRunStorage } from '../../storage/runtime-run-storage.js';
import { GitClient } from '../../git/git-client.js';
import { gitHostPolicyFromEnvironment, type GitHostPolicy } from '../../git/git-network.js';
import { GitAllowedIpRepository } from '../../storage/git-allowed-ip-repository.js';
import { GitAllowedIpService } from '../../git/git-allowed-ip-service.js';

export interface WebRuntime {
  localMode: boolean;
  localPasswordRequired: boolean;
  sfConnections: SalesforceConnectionRepository;
  sfTokenStorageStatus: 'ready' | 'not_configured' | 'invalid_key';
  sfClient: SfClient;
  sfConnectionClient: UserSfClient;
  store: SqliteStore;
  jobAccess: JobAccessRepository;
  orgExecutionAccess: OrgExecutionAccessRepository;
  gitConnections: GitConnectionRepository;
  gitConnectionService: GitConnectionService;
  gitImports: GitImportService;
  gitRegistrations: GitRegistrationService;
  gitCatalog: GitRepositoryCatalog;
  gitTokens: GitTokenService;
  gitAllowedIps: GitAllowedIpService;
  gitEnabled: boolean;
  gitTokenStorageStatus: 'ready' | 'not_configured' | 'invalid_key';
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

export interface WebRuntimeOptions {
  localMode?: boolean;
  accessPassword?: string;
  quickDeployEnabled?: boolean;
  gitHostPolicy?: GitHostPolicy;
}

export async function createWebRuntime(
  databasePath: string,
  bootstrapToken?: string,
  projectPaths: string[] = [],
  cwd = process.cwd(),
  sfClient?: SfClient,
  workspaceOptions: WorkspaceServiceOptions = {},
  runtimeOptions: WebRuntimeOptions = {},
): Promise<WebRuntime> {
  const gitCache = await GitCache.create(databasePath);
  let store: SqliteStore;
  try { store = await openSqliteStore({ databasePath }); }
  catch (error) { await gitCache.close(); throw error; }
  try {
    const localMode = runtimeOptions.localMode === true;
    await store.database.transaction(async (transaction) => {
      const existing = await transaction.get<{ mode: string }>('SELECT mode FROM runtime_mode WHERE id = 1');
      const expected = localMode ? 'local' : 'multiuser';
      if (existing === undefined) {
        const users = await transaction.get<{ count: number }>('SELECT COUNT(*) count FROM users');
        if (localMode && (users?.count ?? 0) > 0) {
          throw new Error('기존 사용자 DB를 LOCAL=true로 전환할 수 없습니다. 별도 데이터 디렉터리를 사용하세요.');
        }
        await transaction.run('INSERT INTO runtime_mode (id, mode) VALUES (1, ?)', expected);
      } else if (existing.mode !== expected) {
        throw new Error('기존 DB의 local 모드와 시작 설정이 다릅니다. 별도 데이터 디렉터리를 사용하세요.');
      }
    });
    let vault: TokenVault | undefined;
    let gitTokenStorageStatus: WebRuntime['gitTokenStorageStatus'] = 'not_configured';
    const sharedTokenSecret = process.env.SFUD_TOKEN_SECRET;
    const tokenSecret = sharedTokenSecret ?? process.env.SFUD_GIT_TOKEN_SECRET;
    if (tokenSecret !== undefined || process.env.SFUD_GIT_TOKEN_KEY_FILE !== undefined) {
      try {
        const version = Number(process.env.SFUD_GIT_TOKEN_KEY_VERSION ?? '1');
        if (tokenSecret !== undefined) {
          // Persist only the public KDF salt. Concurrent starts must use the same salt.
          await store.database.run('INSERT INTO git_token_key_parameters (id, salt) VALUES (1, ?) ON CONFLICT(id) DO NOTHING',
            randomBytes(32).toString('base64url'));
          const parameters = await store.database.get<{ salt: string }>('SELECT salt FROM git_token_key_parameters WHERE id = 1');
          const salt = Buffer.from(parameters!.salt, 'base64url');
          if (salt.toString('base64url') !== parameters!.salt) throw new Error('Invalid Git token KDF parameters');
          vault = await TokenVault.fromSecret(tokenSecret, salt, version);
        } else {
          vault = await TokenVault.fromKeyFile(process.env.SFUD_GIT_TOKEN_KEY_FILE!, version);
        }
        gitTokenStorageStatus = 'ready';
      } catch { gitTokenStorageStatus = 'invalid_key'; }
    }
    let sfVault: TokenVault | undefined;
    let sfTokenStorageStatus: WebRuntime['sfTokenStorageStatus'] = 'not_configured';
    const sfTokenSecret = sharedTokenSecret ?? process.env.SFUD_SF_TOKEN_SECRET;
    if (sfTokenSecret !== undefined) {
      try {
        await store.database.run('INSERT INTO salesforce_token_key_parameters (id, salt) VALUES (1, ?) ON CONFLICT(id) DO NOTHING',
          randomBytes(32).toString('base64url'));
        const parameters = await store.database.get<{ salt: string }>('SELECT salt FROM salesforce_token_key_parameters WHERE id = 1');
        const salt = Buffer.from(parameters!.salt, 'base64url');
        if (salt.toString('base64url') !== parameters!.salt) throw new Error('Invalid Salesforce token KDF parameters');
        sfVault = await TokenVault.fromSecret(sfTokenSecret, salt);
        sfTokenStorageStatus = 'ready';
      } catch { sfTokenStorageStatus = 'invalid_key'; }
    }
    const sfConnections = new SalesforceConnectionRepository(store.database, sfVault);
    const sfConnectionClient = new UserSfClient(sfConnections, sfClient ?? new ProcessSfClient());
    const activeSfClient: SfClient = sfClient ?? (localMode ? new ProcessSfClient() : sfConnectionClient);
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
    const recoveredJobCount = await deploymentJobs.recoverInterruptedJobs()
      + await deploymentJobs.expireValidatedPendingExecutions();
    const deploymentQueue = new SingleJobQueue();
    const deploymentAdmissions = new DeploymentAdmissionRepository(store.database, {
      leaseMs: deploymentAdmissionLeaseMsFromEnvironment(),
    });
    const deploymentExecutionLeases = new DeploymentExecutionLeaseRepository(store.database, {
      leaseMs: deploymentExecutionLeaseMsFromEnvironment(),
    });
    const orgExecutionAccess = new OrgExecutionAccessRepository(store.database, undefined, localMode);
    const userCount = await store.database.get<{ count: number }>('SELECT COUNT(*) count FROM users');
    const auth = new AuthService(
      store.database,
      userCount?.count === 0
        ? bootstrapToken ?? process.env.SFUD_BOOTSTRAP_TOKEN ?? randomBytes(18).toString('base64url')
        : undefined,
    );
    if (localMode) {
      await auth.ensureLocalOperator();
      await auth.configureLocalAccess(runtimeOptions.accessPassword);
    }
    const workspace = await WorkspaceService.create(activeSfClient, cwd, projectPaths, workspaceOptions,
      !localMode && sfClient === undefined ? sfConnections : undefined);
    const gitConnections = new GitConnectionRepository(store.database, vault);
    const gitEnabled = process.env.SFUD_GIT_ENABLED !== 'false';
    const gitAllowedIps = new GitAllowedIpService(new GitAllowedIpRepository(store.database),
      runtimeOptions.gitHostPolicy ?? gitHostPolicyFromEnvironment());
    await gitAllowedIps.initialize();
    const diagnosticsFile = databasePath === ':memory:' ? undefined : path.join(path.dirname(path.resolve(databasePath)), 'logs', 'git-diagnostics.jsonl');
    const gitClient = new GitClient(gitAllowedIps.policy, diagnosticsFile);
    const gitTokens = new GitTokenService(gitConnections, undefined, gitEnabled && vault !== undefined, process.env, gitClient);
    const gitConnectionService = new GitConnectionService(gitConnections, (owner, id) => gitImports.cancelConnection(owner, id));
    const gitImportHistory = new GitImportRepository(store.database);
    await gitImportHistory.recover();
    const gitImports = new GitImportService(gitImportHistory, workspace.managedProjects,
      { cache: gitCache, enabled: gitEnabled, client: gitClient,
        ...(diagnosticsFile === undefined ? {} : { diagnosticsFile }),
        access: new GitRepositoryAccess(gitConnections, gitConnectionService, gitEnabled, gitClient) });
    const gitCatalog = new GitRepositoryCatalog(gitConnections, gitConnectionService, gitEnabled);
    workspace.gitImports = gitImports;
    const gitRegistrations = new GitRegistrationService(store.database, gitImports, diagnosticsFile);
    await store.database.run("UPDATE git_registrations SET status = 'FAILED', error_message = '서버 재시작으로 동기화가 중단되었습니다. 다시 동기화하세요.' WHERE status IN ('PENDING', 'SYNCING')");
    workspace.gitRegistrations = gitRegistrations;
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
    const comparisonQueue = new SingleJobQueue(2);
    let runStorage: RuntimeRunStorage;
    try {
      runStorage = await RuntimeRunStorage.create(
        databasePath,
        store.database,
        async () => { await deploymentJobs.expireValidatedPendingExecutions(); },
      );
    } catch (error) {
      await workspace.close();
      await store.close();
      await gitCache.close();
      throw error;
    }
    const runsDirectory = runStorage.directory;
    const deploymentCoordinator = new DeploymentCoordinator(deploymentJobs, deploymentQueue, deploymentExecutionLeases);
    let shutdownRequest: Promise<void> | undefined;
    const runtime: WebRuntime = {
      localMode,
      localPasswordRequired: localMode && runtimeOptions.accessPassword !== undefined,
      sfConnections,
      sfTokenStorageStatus,
      sfClient: activeSfClient,
      sfConnectionClient,
      store,
      jobAccess: new JobAccessRepository(store.database),
      orgExecutionAccess,
      gitConnections,
      gitConnectionService,
      gitTokens,
      gitAllowedIps,
      gitEnabled,
      gitImports,
      gitRegistrations,
      gitCatalog,
      gitTokenStorageStatus,
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
        activeSfClient,
        runsDirectory,
        new UserSettingsRepository(store.database),
      ),
      dryRuns: new DryRunService(
        deploymentJobs,
        deploymentCoordinator,
        workspace,
        activeSfClient,
        runsDirectory,
        new UserSettingsRepository(store.database),
        deploymentAdmissions,
        orgExecutionAccess,
        async () => { await runStorage.assertCanAcceptNewRun(); },
      ),
      deployments: new DeploymentService(
        deploymentJobs,
        deploymentCoordinator,
        workspace,
        activeSfClient,
        { quickDeployEnabled: runtimeOptions.quickDeployEnabled ?? process.env.SFUD_QUICK_DEPLOY_ENABLED !== 'false' },
        orgExecutionAccess,
      ),
      workflowEvents,
      recoveredJobCount,
      recoveredComparisonCount,
      shutdown(graceMs = 10_000): Promise<void> {
        if (shutdownRequest !== undefined) return shutdownRequest;
        deploymentQueue.stopAccepting();
        comparisonQueue.stopAccepting();
        shutdownRequest = (async () => {
          const registrationsClosed = gitRegistrations.close();
          await gitImports.close();
          await registrationsClosed;
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
          await deploymentCoordinator.flushCompletions();
          await deploymentJobs.recoverInterruptedJobs();
          await comparisonJobs.recoverInterrupted();
          await workspace.close();
          await runStorage.close();
          await store.close();
          await gitCache.close();
        })().catch((error: unknown) => {
          shutdownRequest = undefined;
          throw error;
        });
        return shutdownRequest;
      },
    };
    runStorage.start();
    return runtime;
  } catch (error) {
    await store.close().catch(() => undefined);
    await gitCache.close().catch(() => undefined);
    throw error;
  }
}
