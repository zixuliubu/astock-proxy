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

test('session workflow waits in-run and continues after individual node failures', () => {
  const workflow = fs.readFileSync(
    path.join(__dirname, '..', '.github', 'workflows', 'capture-sessions.yml'),
    'utf8',
  );
  assert.match(workflow, /cron: '30 23 \* \* 0-4'/);
  assert.match(workflow, /cron: '30 3 \* \* 1-5'/);
  assert.match(workflow, /NODES=\(09:15 09:20 09:25/);
  assert.match(workflow, /NODES=\(13:05 13:15 13:25/);
  assert.match(workflow, /sleep "\$WAIT_SECONDS"/);
  assert.match(workflow, /continue/);
  assert.match(workflow, /MAX_ACCEPTABLE_LAG_SECONDS=540/);
  assert.match(workflow, /date=\$CHINA_DATE/);
});
