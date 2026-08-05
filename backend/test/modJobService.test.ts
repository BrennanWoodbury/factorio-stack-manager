import test from 'node:test';
import assert from 'node:assert/strict';
import { ModJobService, serverKey } from '../src/services/modJobService.js';

/**
 * The point of a mod job is that the request returns before the download does, so
 * these tests all check what a caller can observe *while* the work is still in
 * flight — not just the final result.
 */
function deferred<T>() {
  let resolve!: (v: T) => void;
  let reject!: (e: Error) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

const empty = { downloaded: [], errors: [] };

test('start returns a running job before the work finishes', async () => {
  const jobs = new ModJobService();
  const gate = deferred<typeof empty>();

  const job = jobs.start({ kind: 'save', key: serverKey('s1'), serverId: 's1' }, () => gate.promise);
  assert.equal(job.state, 'running');
  assert.equal(jobs.get(job.id).state, 'running');

  gate.resolve({ downloaded: [{ name: 'flib', version: '1.0.0' }], errors: [] });
  await gate.promise;
  await new Promise((r) => setImmediate(r));

  const done = jobs.get(job.id);
  assert.equal(done.state, 'done');
  assert.deepEqual(done.downloaded, [{ name: 'flib', version: '1.0.0' }]);
  assert.ok(done.finishedAt);
});

test('progress reported by the work shows up on the job', async () => {
  const jobs = new ModJobService();
  const gate = deferred<typeof empty>();
  let report!: (p: { current: string | null; completed: number; total: number }) => void;

  const job = jobs.start({ kind: 'apply', key: serverKey('s1'), serverId: 's1' }, (progress) => {
    report = progress;
    return gate.promise;
  });

  report({ current: 'space-exploration', completed: 3, total: 12 });
  assert.equal(jobs.get(job.id).current, 'space-exploration');
  assert.equal(jobs.get(job.id).completed, 3);
  assert.equal(jobs.get(job.id).total, 12);

  gate.resolve(empty);
  await gate.promise;
  await new Promise((r) => setImmediate(r));
  // Finishing clears "currently downloading" and squares the count with the total.
  assert.equal(jobs.get(job.id).current, null);
  assert.equal(jobs.get(job.id).completed, jobs.get(job.id).total);
});

test('a second job for the same server is refused while one is running', async () => {
  const jobs = new ModJobService();
  const gate = deferred<typeof empty>();
  jobs.start({ kind: 'save', key: serverKey('s1'), serverId: 's1' }, () => gate.promise);

  assert.throws(
    () => jobs.start({ kind: 'apply', key: serverKey('s1'), serverId: 's1' }, async () => empty),
    /already running/,
  );
  // A different server is unaffected — one busy download must not lock the app.
  const other = jobs.start({ kind: 'save', key: serverKey('s2'), serverId: 's2' }, async () => empty);
  assert.equal(other.state, 'running');

  gate.resolve(empty);
  await gate.promise;
  await new Promise((r) => setImmediate(r));
  assert.equal(
    jobs.start({ kind: 'apply', key: serverKey('s1'), serverId: 's1' }, async () => empty).state,
    'running',
  );
});

test('work that throws leaves a readable failed job rather than an unhandled rejection', async () => {
  const jobs = new ModJobService();
  const job = jobs.start({ kind: 'save', key: serverKey('s1'), serverId: 's1' }, async () => {
    throw new Error('mod portal rejected credentials');
  });
  await new Promise((r) => setImmediate(r));

  const failed = jobs.get(job.id);
  assert.equal(failed.state, 'error');
  assert.equal(failed.error, 'mod portal rejected credentials');
});

test('a finished job is pollable for a while, then pruned', async () => {
  const jobs = new ModJobService(0);
  const job = jobs.start({ kind: 'save', key: serverKey('s1'), serverId: 's1' }, async () => empty);
  await new Promise((r) => setImmediate(r));
  assert.equal(jobs.get(job.id).state, 'done');

  // The next start prunes; with a zero retention the finished one goes with it.
  await new Promise((r) => setTimeout(r, 2));
  jobs.start({ kind: 'save', key: serverKey('s2'), serverId: 's2' }, async () => empty);
  assert.throws(() => jobs.get(job.id), /not found/i);
});

test('active jobs can be found by key, so a reloaded page rejoins one in flight', async () => {
  const jobs = new ModJobService();
  const gate = deferred<typeof empty>();
  const job = jobs.start({ kind: 'apply', key: serverKey('s1'), serverId: 's1' }, () => gate.promise);

  assert.equal(jobs.activeFor(serverKey('s1'))?.id, job.id);
  assert.equal(jobs.activeFor(serverKey('s2')), undefined);
  assert.deepEqual(
    jobs.list().map((j) => j.id),
    [job.id],
  );

  gate.resolve(empty);
  await gate.promise;
  await new Promise((r) => setImmediate(r));
  assert.equal(jobs.activeFor(serverKey('s1')), undefined);
});
