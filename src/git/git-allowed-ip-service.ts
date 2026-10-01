import { MutableGitHostPolicy, type GitHostPolicy } from './git-network.js';
import type { GitAllowedIp, GitAllowedIpRepository } from '../storage/git-allowed-ip-repository.js';

/** Merges immutable startup entries with administrator-managed SQLite entries. */
export class GitAllowedIpService {
  public readonly policy = new MutableGitHostPolicy();
  public constructor(private readonly repository: GitAllowedIpRepository, private readonly startupPolicy: GitHostPolicy) {}

  public async initialize(): Promise<void> { await this.refreshPolicy(); }
  public async list(): Promise<GitAllowedIp[]> { return await this.repository.list(); }
  public async add(actorUserId: string, address: string): Promise<GitAllowedIp[]> {
    await this.repository.add(actorUserId, address);
    return await this.refreshPolicy();
  }
  public async remove(actorUserId: string, address: string): Promise<GitAllowedIp[]> {
    await this.repository.remove(actorUserId, address);
    return await this.refreshPolicy();
  }

  private async refreshPolicy(): Promise<GitAllowedIp[]> {
    const entries = await this.repository.list();
    this.policy.replaceAddresses([...this.startupPolicy.allowedAddresses, ...entries.map((entry) => entry.address)]);
    return entries;
  }
}
