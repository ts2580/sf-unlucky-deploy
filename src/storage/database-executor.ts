import type { Database, ISqlite } from 'sqlite';

export interface DatabaseHandle {
  run(sql: ISqlite.SqlType, ...params: any[]): ReturnType<Database['run']>;
  get<T = any>(sql: ISqlite.SqlType, ...params: any[]): Promise<T | undefined>;
  all<T = any[]>(sql: ISqlite.SqlType, ...params: any[]): Promise<T>;
  exec(sql: ISqlite.SqlType): Promise<void>;
}

export class DatabaseExecutor implements DatabaseHandle {
  private tail: Promise<void> = Promise.resolve();
  private accepting = true;
  private closeRequest: Promise<void> | undefined;

  public constructor(private readonly database: Database) {}

  public run(sql: ISqlite.SqlType, ...params: any[]): ReturnType<Database['run']> {
    return this.enqueue((database) => database.run(sql, ...params));
  }

  public get<T = any>(sql: ISqlite.SqlType, ...params: any[]): Promise<T | undefined> {
    return this.enqueue((database) => database.get<T>(sql, ...params));
  }

  public all<T = any[]>(sql: ISqlite.SqlType, ...params: any[]): Promise<T> {
    return this.enqueue((database) => database.all<T>(sql, ...params));
  }

  public exec(sql: ISqlite.SqlType): Promise<void> {
    return this.enqueue((database) => database.exec(sql));
  }

  public transaction<T>(operation: (transaction: DatabaseHandle) => Promise<T>): Promise<T> {
    return this.enqueue(async (database) => {
      await database.exec('BEGIN IMMEDIATE');
      try {
        const value = await operation(database);
        await database.exec('COMMIT');
        return value;
      } catch (error) {
        await database.exec('ROLLBACK');
        throw error;
      }
    });
  }

  public close(): Promise<void> {
    if (this.closeRequest !== undefined) return this.closeRequest;
    this.accepting = false;
    this.closeRequest = this.tail.then(async () => { await this.database.close(); });
    this.tail = this.closeRequest.then(() => undefined, () => undefined);
    return this.closeRequest;
  }

  private enqueue<T>(operation: (database: Database) => Promise<T>): Promise<T> {
    if (!this.accepting) return Promise.reject(new Error('SQLite executor가 종료 중입니다.'));
    const result = this.tail.then(async () => await operation(this.database));
    this.tail = result.then(() => undefined, () => undefined);
    return result;
  }
}
