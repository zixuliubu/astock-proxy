const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

test('capture workflow starts before nodes and preserves scheduled target metadata', () => {
  const workflow = fs.readFileSync(
    path.join(__dirname, '..', '.github', 'workflows', 'capture-nodes.yml'),
    'utf8',
  );
  assert.match(workflow, /cron: '10 1 \* \* 1-5'/);
  assert.match(workflow, /"10 1 \* \* 1-5"\) TARGET_NODE="09:15"/);
  assert.match(workflow, /scheduledNode=\$SCHEDULED_NODE/);
  assert.match(workflow, /MAX_ACCEPTABLE_LAG_SECONDS=540/);
  assert.doesNotMatch(workflow, /NODE="\$UTC_HM"/);
});
