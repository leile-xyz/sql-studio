import assert from 'node:assert/strict';
import { workflowSqlContext } from '../src/lib/workflow-sql-autocomplete.mjs';

const elements = new Map([
  ['workflowInstance', { value: '2', dataset: { items: JSON.stringify([
    { id: 1, instance_name: 'mysql-main', db_type: 'mysql' },
    { id: 2, instance_name: 'pg-report', db_type: 'pgsql' },
  ]) } }],
  ['workflowDatabase', { value: 'analytics' }],
  ['workflowSchemaField', { hidden: false }],
  ['workflowSchema', { value: 'reporting' }],
]);

const context = workflowSqlContext({
  get: id => elements.get(id),
  getAppState: () => ({ origin: 'https://archery.example.com' }),
});

assert.deepEqual(context, {
  type: 'workflow',
  origin: 'https://archery.example.com',
  instance: 'pg-report',
  db: 'analytics',
  schema: 'reporting',
  dbType: 'pgsql',
});
assert.ok(Object.isFrozen(context));
console.log('PASS  workflow autocomplete: selected data source context');
