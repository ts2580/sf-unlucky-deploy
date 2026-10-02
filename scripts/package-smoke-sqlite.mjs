import { createRequire } from 'node:module';
import path from 'node:path';

const [packageRoot, filename, operation, sql] = process.argv.slice(2);
if (!packageRoot || !filename || !['get', 'exec'].includes(operation) || !sql) {
  throw new Error('사용법: package-smoke-sqlite.mjs <package-root> <database> <get|exec> <sql>');
}
const sqlite3 = createRequire(path.join(packageRoot, 'package.json'))('sqlite3');
const result = await new Promise((resolve, reject) => {
  const db = new sqlite3.Database(filename, (openError) => {
    if (openError) { reject(openError); return; }
    db[operation](sql, (error, row) => db.close((closeError) => {
      if (error ?? closeError) reject(error ?? closeError);
      else resolve(row ?? null);
    }));
  });
});
process.stdout.write(JSON.stringify(result));
