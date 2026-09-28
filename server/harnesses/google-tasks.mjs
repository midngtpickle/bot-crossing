/**
 * Harness adapter: Google Tasks (via Google Tasks MCP).
 *
 * Connects to the local Google Tasks MCP server (c:/Users/HP FURY/GitHub/google-tasks-mcp)
 * over stdio using @modelcontextprotocol/sdk.
 *
 * When a Google Tasks list name matches a local project folder (such as 'pingers'),
 * or when manually mapped by the user in settings, it spawns a bot in that project's hex zone.
 * - Primary bot with building representing the task list.
 * - Incomplete tasks spawn as companion errand bots wandering the plot.
 * - Dynamic statuses: 'blocked' (if overdue), 'waiting' (if tasks pending),
 *   'celebrating' (when all tasks completed), 'idle' (when empty).
 * - Clicking "Open" launches https://tasks.google.com in the default browser.
 * - 30-second TTL cache for non-blocking local scans.
 * - Configuration for manual folder mapping and hiding specific lists (persisted in data/google-tasks.json).
 */
import fsp from 'node:fs/promises'
import { existsSync } from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { fileURLToPath } from 'node:url'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { exists, listDirs } from '../lib/fsutil.mjs'

const here = path.dirname(fileURLToPath(import.meta.url))
const DATA_DIR = process.env.BOT_CROSSING_DATA || path.join(here, '..', '..', 'data')
const CONFIG_FILE = path.join(DATA_DIR, 'google-tasks.json')

const HOME = os.homedir()
const ID = (raw) => `google-tasks:${raw}`

const MCP_DIR = process.env.GOOGLE_TASKS_MCP_DIR || path.join(HOME, 'GitHub', 'google-tasks-mcp')
const MCP_SCRIPT = process.env.GOOGLE_TASKS_MCP_SCRIPT || path.join(MCP_DIR, 'index.js')
const TOKEN_FILE = process.env.GOOGLE_TASKS_TOKEN_PATH || path.join(MCP_DIR, 'token.json')

const CACHE_TTL_MS = 30 * 1000

let cachedThreads = []
let lastScanAt = 0
let activeClient = null
let activeTransport = null
let connectPromise = null

/** Check whether Google Tasks MCP is configured and authenticated. */
export async function detect() {
  try {
    return (await exists(MCP_SCRIPT)) && (await exists(TOKEN_FILE))
  } catch {
    return false
  }
}

/** Normalize strings for fuzzy project matching (strips case, spaces, dashes). */
export function normalizeName(name) {
  return String(name || '').toLowerCase().replace(/[^a-z0-9]/g, '')
}

/** Read configuration (hidden lists, manual folder mappings) from data/google-tasks.json. */
export async function loadConfig() {
  try {
    const raw = await fsp.readFile(CONFIG_FILE, 'utf8')
    const parsed = JSON.parse(raw)
    return {
      hiddenLists: Array.isArray(parsed?.hiddenLists) ? parsed.hiddenLists.map(String) : [],
      folderMappings: parsed?.folderMappings && typeof parsed.folderMappings === 'object' ? parsed.folderMappings : {},
    }
  } catch {
    return { hiddenLists: [], folderMappings: {} }
  }
}

/** Save configuration and immediately invalidate scan cache. */
export async function saveConfig(nextConfig) {
  const config = {
    hiddenLists: Array.isArray(nextConfig?.hiddenLists) ? nextConfig.hiddenLists.map(String) : [],
    folderMappings: nextConfig?.folderMappings && typeof nextConfig.folderMappings === 'object' ? nextConfig.folderMappings : {},
  }
  await fsp.mkdir(DATA_DIR, { recursive: true })
  await fsp.writeFile(CONFIG_FILE, JSON.stringify(config, null, 2))
  cachedThreads = []
  lastScanAt = 0
  return config
}

/** Get or establish an MCP Client connection over stdio. */
async function getClient() {
  if (activeClient) return activeClient
  if (connectPromise) return connectPromise

  connectPromise = (async () => {
    try {
      activeTransport = new StdioClientTransport({
        command: 'node',
        args: [MCP_SCRIPT],
        env: { ...process.env, GOOGLE_TASKS_TOKEN_PATH: TOKEN_FILE },
      })

      const client = new Client(
        { name: 'bot-crossings-adapter', version: '1.0.0' },
        { capabilities: {} }
      )

      activeTransport.onerror = (err) => {
        console.warn('bot-crossing: Google Tasks MCP transport error:', err?.message || err)
        closeClient()
      }

      await client.connect(activeTransport)
      activeClient = client
      return activeClient
    } catch (err) {
      closeClient()
      throw err
    } finally {
      connectPromise = null
    }
  })()

  return connectPromise
}

export function closeClient() {
  if (activeClient) {
    try { activeClient.close() } catch {}
    activeClient = null
  }
  if (activeTransport) {
    try { activeTransport.close() } catch {}
    activeTransport = null
  }
}

/** Find all candidate project directories across common developer workspace paths. */
export async function findCandidateProjectDirs() {
  const dirs = []
  const roots = [
    path.join(HOME, 'GitHub'),
    path.join(HOME, 'Projects'),
    path.join(HOME, 'workspaces'),
  ]

  for (const root of roots) {
    if (await exists(root)) {
      try {
        const subs = await listDirs(root)
        dirs.push(...subs)
      } catch {}
    }
  }
  return dirs
}

/**
 * Determine the thread and astronaut status based on tasks in the list.
 * - blocked: any uncompleted task has due date < now.
 * - waiting: uncompleted tasks exist (holds '?' badge).
 * - celebrating: at least one task exists and all are completed ('✓' badge).
 * - idle: no tasks in the list.
 */
export function evaluateTaskStatus(tasks, now = Date.now()) {
  const pending = tasks.filter((t) => t.status !== 'completed')
  const completed = tasks.filter((t) => t.status === 'completed')

  let hasOverdue = false
  for (const t of pending) {
    if (t.due) {
      const dueMs = Date.parse(t.due)
      if (!Number.isNaN(dueMs) && dueMs < now) {
        hasOverdue = true
        break
      }
    }
  }

  return {
    hasOverdue,
    pending,
    completed,
    total: tasks.length,
    isAllCompleted: tasks.length > 0 && pending.length === 0,
  }
}

/**
 * Overview for settings UI: lists all task lists with their auto-detected folder,
 * custom folder override, hidden state, and all candidate project folders.
 */
export async function getOverview() {
  const config = await loadConfig()
  const isDetected = await detect()
  if (!isDetected) {
    return { detected: false, lists: [], candidateFolders: [], config }
  }

  let lists = []
  try {
    const client = await getClient()
    const listsResult = await client.callTool({
      name: 'list_task_lists',
      arguments: { maxResults: 100 },
    })
    const rawListsText = listsResult?.content?.[0]?.text || '[]'
    lists = JSON.parse(rawListsText)
    if (!Array.isArray(lists)) lists = []
  } catch (err) {
    console.warn('bot-crossing: Google Tasks failed fetching lists for overview:', err?.message || err)
  } finally {
    closeClient()
  }

  const candidateDirs = await findCandidateProjectDirs()
  const dirMap = new Map()
  for (const d of candidateDirs) {
    const norm = normalizeName(path.basename(d))
    if (norm && !dirMap.has(norm)) dirMap.set(norm, d)
  }

  const hiddenSet = new Set(config.hiddenLists.map((h) => normalizeName(h)))
  for (const h of config.hiddenLists) hiddenSet.add(h)

  const detailedLists = lists.map((l) => {
    const listNorm = normalizeName(l.title)
    const autoFolder = dirMap.get(listNorm) || ''
    const manualFolder =
      config.folderMappings[l.id] ||
      config.folderMappings[listNorm] ||
      config.folderMappings[l.title] ||
      ''
    const isHidden = hiddenSet.has(l.id) || hiddenSet.has(listNorm) || hiddenSet.has(l.title)

    return {
      id: l.id,
      title: l.title,
      autoFolder,
      manualFolder,
      activeFolder: manualFolder || autoFolder,
      hidden: isHidden,
      updated: l.updated,
    }
  })

  return {
    detected: true,
    lists: detailedLists,
    candidateFolders: candidateDirs,
    config,
  }
}

/** Scan Google Tasks and return a Thread for each list matching a project folder. */
export async function scanThreads() {
  const now = Date.now()
  if (cachedThreads.length > 0 && now - lastScanAt < CACHE_TTL_MS) {
    return cachedThreads
  }

  if (!(await detect())) return []

  try {
    const config = await loadConfig()
    const hiddenSet = new Set(config.hiddenLists.map((h) => normalizeName(h)))
    for (const h of config.hiddenLists) hiddenSet.add(h)

    const client = await getClient()

    // 1. Fetch task lists
    const listsResult = await client.callTool({
      name: 'list_task_lists',
      arguments: { maxResults: 100 },
    })

    const rawListsText = listsResult?.content?.[0]?.text || '[]'
    const lists = JSON.parse(rawListsText)
    if (!Array.isArray(lists) || lists.length === 0) return []

    // 2. Discover local project candidates
    const candidateDirs = await findCandidateProjectDirs()
    const dirMap = new Map()
    for (const d of candidateDirs) {
      const norm = normalizeName(path.basename(d))
      if (norm && !dirMap.has(norm)) dirMap.set(norm, d)
    }

    const threads = []

    // 3. For each non-hidden list matching a folder, fetch tasks and build a Thread
    for (const list of lists) {
      const listNorm = normalizeName(list.title)

      // Check if user hid this list
      if (hiddenSet.has(list.id) || hiddenSet.has(listNorm) || hiddenSet.has(list.title)) {
        continue
      }

      // Check for manual folder mapping first
      const manualFolder =
        config.folderMappings[list.id] ||
        config.folderMappings[listNorm] ||
        config.folderMappings[list.title]

      let matchedDir = null
      if (manualFolder && (await exists(manualFolder))) {
        matchedDir = manualFolder
      } else {
        // Fall back to auto-detection by project name
        matchedDir = dirMap.get(listNorm) || null
      }

      if (!matchedDir) continue

      let tasks = []
      try {
        const tasksResult = await client.callTool({
          name: 'list_tasks',
          arguments: {
            taskListId: list.id,
            showCompleted: true,
            maxResults: 100,
          },
        })
        const rawTasksText = tasksResult?.content?.[0]?.text || '[]'
        tasks = JSON.parse(rawTasksText)
        if (!Array.isArray(tasks)) tasks = []
      } catch (err) {
        console.warn(`bot-crossing: Google Tasks failed fetching tasks for list "${list.title}":`, err?.message || err)
      }

      const { hasOverdue, pending, completed, isAllCompleted } = evaluateTaskStatus(tasks, now)
      const projectName = path.basename(matchedDir)

      // Latest activity timestamp
      let latestActivity = list.updated ? Date.parse(list.updated) : now
      for (const t of tasks) {
        if (t.updated) {
          const tTime = Date.parse(t.updated)
          if (!Number.isNaN(tTime) && tTime > latestActivity) latestActivity = tTime
        }
      }

      // Preview text
      const previewParts = []
      if (pending.length > 0) previewParts.push(`${pending.length} pending`)
      if (completed.length > 0) previewParts.push(`${completed.length} completed`)
      const preview = previewParts.join(', ') || 'No tasks'

      // Subagents: active incomplete tasks appear as companion errand bots
      const subagents = pending.map((t) => ({
        id: t.id,
        task: t.title || 'Task',
        lastActivityAt: t.updated ? Date.parse(t.updated) : latestActivity,
      }))

      threads.push({
        id: ID(list.id),
        title: `Tasks: ${list.title}`,
        preview,
        project: projectName,
        projectPath: matchedDir,
        worktree: '',
        cwd: matchedDir,
        gitBranch: '',
        model: 'Google Tasks',
        effort: '',
        createdAt: list.updated ? Date.parse(list.updated) : latestActivity,
        lastActivityAt: latestActivity,
        lastFocusedAt: 0,
        unread: pending.length > 0,
        running: false,
        hasError: hasOverdue,
        starred: false,
        routine: '',
        prState: isAllCompleted ? 'MERGED' : '',
        archived: false,
        sizeBytes: Math.max(1024, (tasks.length + 1) * 8192),
        source: 'mcp',
        canOpen: true,
        subagents,
        ref: { listId: list.id, title: list.title },
      })
    }

    cachedThreads = threads
    lastScanAt = now
    return threads
  } catch (err) {
    console.warn('bot-crossing: Google Tasks scan failed:', err?.message || err)
    return cachedThreads
  } finally {
    closeClient()
  }
}

/** Open Google Tasks in the default browser. */
export async function openThread() {
  return { ok: true, url: 'https://tasks.google.com' }
}

export async function newSession() {
  return { ok: false, error: 'Google Tasks sessions cannot be created from a directory' }
}

export default {
  id: 'google-tasks',
  name: 'Google Tasks',
  detect,
  scanThreads,
  openThread,
  newSession,
  loadConfig,
  saveConfig,
  getOverview,
  paths: { MCP_DIR, MCP_SCRIPT, TOKEN_FILE, CONFIG_FILE },
}
