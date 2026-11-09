import assert from 'node:assert/strict';
import { aggregateBackgroundJobHealth } from '../src/services/background_jobs_health.service';

assert.equal(aggregateBackgroundJobHealth([]), 'starting');
assert.equal(aggregateBackgroundJobHealth(['not_configured', 'healthy']), 'starting');
assert.equal(aggregateBackgroundJobHealth(['starting', 'healthy']), 'starting');
assert.equal(aggregateBackgroundJobHealth(['healthy', 'healthy']), 'healthy');
assert.equal(aggregateBackgroundJobHealth(['healthy', 'degraded']), 'degraded');
assert.equal(aggregateBackgroundJobHealth(['starting', 'degraded']), 'degraded');

console.log('Background-job health aggregation checks passed.');
