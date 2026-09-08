import { Store } from '../../src/store.js';
import { IntegrationEngine } from '../../src/integration-engine.js';

const [database, source, id, boundary, ordinalText] = process.argv.slice(2);
if (!database || !source || !id || !boundary) throw new Error('Missing crash fixture arguments');
const store = new Store(database);
const update = store.integrations.update.bind(store.integrations);
let count = 0;
store.integrations.update = (job, revision, type, body) => {
  if (type === boundary && ++count === Number(ordinalText ?? 1)) process.exit(77);
  return update(job, revision, type, body);
};
const result = await new IntegrationEngine(store, source).execute(id, new AbortController().signal);
store.close();
process.exit(result.phase === 'succeeded' ? 0 : 2);
