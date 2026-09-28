import test from 'node:test'
import assert from 'node:assert/strict'
import googleTasks, {
  normalizeName,
  evaluateTaskStatus,
  openThread,
  newSession,
  detect,
  loadConfig,
  saveConfig,
} from '../server/harnesses/google-tasks.mjs'

test('google-tasks harness adheres to the harness interface contract', () => {
  assert.equal(googleTasks.id, 'google-tasks')
  assert.equal(googleTasks.name, 'Google Tasks')
  assert.equal(typeof googleTasks.detect, 'function')
  assert.equal(typeof googleTasks.scanThreads, 'function')
  assert.equal(typeof googleTasks.openThread, 'function')
  assert.equal(typeof googleTasks.newSession, 'function')
})

test('normalizeName cleans project and task list titles for matching', () => {
  assert.equal(normalizeName('pingers'), 'pingers')
  assert.equal(normalizeName('Pingers'), 'pingers')
  assert.equal(normalizeName('RE App'), 'reapp')
  assert.equal(normalizeName('OTIS - Multi-Platform'), 'otismultiplatform')
  assert.equal(normalizeName('bot-crossings'), 'botcrossings')
  assert.equal(normalizeName(''), '')
})

test('evaluateTaskStatus with empty list reports idle', () => {
  const result = evaluateTaskStatus([])
  assert.equal(result.total, 0)
  assert.equal(result.hasOverdue, false)
  assert.equal(result.isAllCompleted, false)
  assert.equal(result.pending.length, 0)
  assert.equal(result.completed.length, 0)
})

test('evaluateTaskStatus with pending non-overdue tasks', () => {
  const future = new Date(Date.now() + 86400000).toISOString()
  const tasks = [
    { id: '1', title: 'Task A', status: 'needsAction', due: future },
    { id: '2', title: 'Task B', status: 'completed' },
  ]
  const result = evaluateTaskStatus(tasks)
  assert.equal(result.total, 2)
  assert.equal(result.hasOverdue, false)
  assert.equal(result.isAllCompleted, false)
  assert.equal(result.pending.length, 1)
  assert.equal(result.completed.length, 1)
})

test('evaluateTaskStatus with overdue task triggers hasOverdue', () => {
  const past = new Date(Date.now() - 86400000).toISOString()
  const tasks = [
    { id: '1', title: 'Task Overdue', status: 'needsAction', due: past },
  ]
  const result = evaluateTaskStatus(tasks)
  assert.equal(result.hasOverdue, true)
  assert.equal(result.isAllCompleted, false)
  assert.equal(result.pending.length, 1)
})

test('evaluateTaskStatus with completed overdue task does not trigger hasOverdue', () => {
  const past = new Date(Date.now() - 86400000).toISOString()
  const tasks = [
    { id: '1', title: 'Task Done', status: 'completed', due: past },
  ]
  const result = evaluateTaskStatus(tasks)
  assert.equal(result.hasOverdue, false)
  assert.equal(result.isAllCompleted, true)
  assert.equal(result.pending.length, 0)
  assert.equal(result.completed.length, 1)
})

test('openThread returns openable web url for Google Tasks', async () => {
  const res = await openThread()
  assert.equal(res.ok, true)
  assert.equal(res.url, 'https://tasks.google.com')
})

test('newSession returns ok: false with meaningful error message', async () => {
  const res = await newSession()
  assert.equal(res.ok, false)
  assert.ok(res.error.length > 0)
})

test('saveConfig and loadConfig persist hidden lists and folder mappings', async () => {
  const testConfig = {
    hiddenLists: ['test-hidden-list', 'Life'],
    folderMappings: {
      'test-list-id': 'C:\\Users\\HP FURY\\GitHub\\pingers',
    },
  }
  await saveConfig(testConfig)
  const loaded = await loadConfig()
  assert.deepEqual(loaded.hiddenLists, ['test-hidden-list', 'Life'])
  assert.equal(loaded.folderMappings['test-list-id'], 'C:\\Users\\HP FURY\\GitHub\\pingers')

  // Clean up
  await saveConfig({ hiddenLists: [], folderMappings: {} })
  const empty = await loadConfig()
  assert.deepEqual(empty.hiddenLists, [])
  assert.deepEqual(empty.folderMappings, {})
})
