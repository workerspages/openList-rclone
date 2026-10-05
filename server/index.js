const express = require('express');
const jwt = require('jsonwebtoken');
const { execSync, exec } = require('child_process');
const fs = require('fs');
const http = require('http');
const cron = require('node-cron');
const { v4: uuidv4 } = require('uuid');
const crypto = require('crypto');
const rateLimit = require('express-rate-limit');

const app = express();
app.set('trust proxy', 1);
app.use(express.json());

const PORT = 3001;
const JWT_SECRET = process.env.JWT_SECRET || crypto.randomBytes(64).toString('hex');
const WEB_USERNAME = process.env.WEB_USERNAME || 'admin';
const WEB_PASSWORD = process.env.WEB_PASSWORD || 'admin';
const RCLONE_ADDR = process.env.RCLONE_ADDR || 'http://127.0.0.1:5572';
const BARK_URL = process.env.BARK_URL || ''; // e.g. https://api.day.app/yourkey
const IGNORE_ERRORS = process.env.IGNORE_ERRORS || 'object not found'; // Comma-separated list of errors to ignore

// Helper to check if an error should be ignored
function isErrorIgnored(errorMsg) {
  if (!errorMsg) return false;
  const ignoreList = IGNORE_ERRORS.split(',').map(s => s.trim()).filter(Boolean);
  return ignoreList.some(ignoreStr => errorMsg.includes(ignoreStr));
}

// ========================
// Auth Middleware
// ========================
function authMiddleware(req, res, next) {
  const token = req.headers.authorization?.replace('Bearer ', '');
  if (!token) return res.status(401).json({ error: 'Unauthorized' });
  try {
    req.user = jwt.verify(token, JWT_SECRET);
    next();
  } catch {
    return res.status(401).json({ error: 'Invalid token' });
  }
}

// ========================
// Rclone RC API Helper
// ========================
function rcloneRC(command, params = {}) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(params);
    const url = new URL(command, RCLONE_ADDR);
    const options = {
      hostname: url.hostname,
      port: url.port,
      path: url.pathname,
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) },
      timeout: 10000,
    };
    const req = http.request(options, (resp) => {
      let body = '';
      resp.on('data', (chunk) => (body += chunk));
      resp.on('end', () => {
        try { resolve(JSON.parse(body)); }
        catch { resolve(body); }
      });
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('Rclone RC timeout')); });
    req.write(data);
    req.end();
  });
}

// ========================
// Bark Notification Helper
// ========================
function sendBarkNotification(title, body) {
  if (!BARK_URL) return Promise.resolve();
  const url = `${BARK_URL.replace(/\/+$/, '')}/${encodeURIComponent(title)}/${encodeURIComponent(body)}?icon=https://rclone.org/img/rclone-120x120.png&group=openlist-rclone`;
  const httpModule = url.startsWith('https') ? require('https') : http;
  return new Promise((resolve) => {
    httpModule.get(url, (resp) => {
      let data = '';
      resp.on('data', (chunk) => (data += chunk));
      resp.on('end', () => {
        console.log(`[Bark] Notification sent: ${title}`);
        resolve(data);
      });
    }).on('error', (err) => {
      console.error(`[Bark] Failed to send notification: ${err.message}`);
      resolve();
    });
  });
}

function monitorJobCompletion(taskId, taskName, jobId) {
  if (!BARK_URL || !jobId) return;
  const startTime = Date.now();
  const MAX_MONITOR_TIME = 24 * 60 * 60 * 1000; // 24 hours max
  const CHECK_INTERVAL = 15000; // 15 seconds

  const timer = setInterval(async () => {
    // Safety: stop monitoring after 24 hours
    if (Date.now() - startTime > MAX_MONITOR_TIME) {
      clearInterval(timer);
      return;
    }
    try {
      const jobStatus = await rcloneRC('/job/status', { jobid: jobId });
      if (jobStatus && jobStatus.finished !== false) {
        clearInterval(timer);
        const duration = ((Date.now() - startTime) / 1000 / 60).toFixed(1);
        
        let errorMsg = jobStatus.error;
        let isIgnoredError = isErrorIgnored(errorMsg);

        const success = !errorMsg || isIgnoredError;
        const statusText = success ? '✅ 成功' : '❌ 失败';

        // Update task history with completion info
        const tasks = loadTasks();
        const task = tasks.find(t => t.id === taskId);
        if (task) {
          task.activeJobId = null;
          if (task.history && task.history.length > 0) {
            const record = task.history.find(h => h.jobId === jobId);
            if (record) {
              record.status = success ? 'success' : 'error';
              if (isIgnoredError) {
                record.message = `任务完成 (忽略文件缺失, 耗时 ${duration} 分钟)`;
              } else {
                record.message = success ? `任务完成 (耗时 ${duration} 分钟)` : `任务失败: ${errorMsg}`;
              }
              record.completedAt = new Date().toISOString();
              task.lastStatus = record.status;
            }
          }
          saveTasks(tasks);

          // Send Bark notification
          const notifyPolicy = task.notifyPolicy || (task.notifyOnComplete !== false ? 'always' : 'none');
          if (notifyPolicy === 'always' || (notifyPolicy === 'failure_only' && !success)) {
            const title = `任务${statusText}: ${taskName}`;
            const body = isIgnoredError
              ? `耗时 ${duration} 分钟 (部分动态文件已被覆盖或删除，已忽略)`
              : (success ? `耗时 ${duration} 分钟` : `错误: ${errorMsg || '未知错误'}`);
            await sendBarkNotification(title, body);
          }
        }
      }
    } catch (err) {
      // Job no longer exists (rclone restarted), stop monitoring
      clearInterval(timer);
      // Clear activeJobId
      const tasks = loadTasks();
      const task = tasks.find(t => t.id === taskId);
      if (task) {
        task.activeJobId = null;
        saveTasks(tasks);
      }
    }
  }, CHECK_INTERVAL);
}

// ========================
// Auth Routes
// ========================
// Login rate limiter: Max 5 attempts per 15 minutes
const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 5,
  message: { error: '登录尝试次数过多，请 15 分钟后再试' },
  standardHeaders: true,
  legacyHeaders: false,
});

app.post('/api/login', loginLimiter, (req, res) => {
  const { username, password } = req.body;

  if (!username || !password) {
    return res.status(401).json({ error: 'Invalid credentials' });
  }

  // Prevent timing attacks using timingSafeEqual
  const expectedUser = Buffer.from(WEB_USERNAME);
  const expectedPass = Buffer.from(WEB_PASSWORD);
  const providedUser = Buffer.from(username);
  const providedPass = Buffer.from(password);

  let userMatch = false;
  let passMatch = false;

  if (expectedUser.length === providedUser.length) {
    userMatch = crypto.timingSafeEqual(expectedUser, providedUser);
  }
  if (expectedPass.length === providedPass.length) {
    passMatch = crypto.timingSafeEqual(expectedPass, providedPass);
  }

  if (userMatch && passMatch) {
    const token = jwt.sign({ username: WEB_USERNAME }, JWT_SECRET, { expiresIn: '24h' });
    res.cookie('_auth_token', token, { httpOnly: true, sameSite: 'lax', path: '/', maxAge: 86400000 });
    return res.json({ token, username: WEB_USERNAME });
  }

  return res.status(401).json({ error: 'Invalid credentials' });
});

app.get('/api/auth/check', authMiddleware, (req, res) => {
  res.json({ valid: true, username: req.user.username });
});

// Cookie-based auth check for nginx auth_request
app.get('/api/auth/cookie', (req, res) => {
  const token = req.cookies?._auth_token || req.headers.cookie?.match(/_auth_token=([^;]+)/)?.[1];
  if (!token) return res.status(401).end();
  try {
    jwt.verify(token, JWT_SECRET);
    return res.status(200).end();
  } catch {
    return res.status(401).end();
  }
});

// ========================
// Status Routes
// ========================
app.get('/api/status', authMiddleware, async (req, res) => {
  const status = { openlist: 'stopped', rclone: 'stopped' };

  // Check openList
  try {
    const result = execSync('supervisorctl status openlist 2>/dev/null', { encoding: 'utf-8', timeout: 5000 });
    status.openlist = result.includes('RUNNING') ? 'running' : 'stopped';
  } catch { status.openlist = 'stopped'; }

  // Check Rclone
  try {
    await rcloneRC('/rc/noop');
    status.rclone = 'running';
  } catch { status.rclone = 'stopped'; }

  // System info
  try {
    const uptime = fs.readFileSync('/proc/uptime', 'utf-8').split(' ')[0];
    status.uptime = Math.floor(parseFloat(uptime));
  } catch { status.uptime = 0; }

  res.json(status);
});

// ========================
// Rclone Remote Management
// ========================
app.get('/api/rclone/remotes', authMiddleware, async (req, res) => {
  try {
    const result = await rcloneRC('/config/listremotes');
    const remotes = result.remotes || [];
    const details = [];
    for (const name of remotes) {
      try {
        const dump = await rcloneRC('/config/get', { name });
        details.push({ name, ...dump });
      } catch {
        details.push({ name, type: 'unknown' });
      }
    }
    res.json({ remotes: details });
  } catch (err) {
    res.status(500).json({ error: 'Failed to list remotes: ' + err.message });
  }
});

app.post('/api/rclone/remote', authMiddleware, async (req, res) => {
  try {
    const { name, type, parameters } = req.body;
    if (!name || !type) return res.status(400).json({ error: 'name and type are required' });
    await rcloneRC('/config/create', { name, type, parameters: parameters || {} });
    res.json({ success: true, message: `Remote "${name}" created` });
  } catch (err) {
    res.status(500).json({ error: 'Failed to create remote: ' + err.message });
  }
});

app.put('/api/rclone/remote/:name', authMiddleware, async (req, res) => {
  try {
    const { name } = req.params;
    const { parameters } = req.body;
    await rcloneRC('/config/update', { name, parameters: parameters || {} });
    res.json({ success: true, message: `Remote "${name}" updated` });
  } catch (err) {
    res.status(500).json({ error: 'Failed to update remote: ' + err.message });
  }
});

app.delete('/api/rclone/remote/:name', authMiddleware, async (req, res) => {
  try {
    const { name } = req.params;
    await rcloneRC('/config/delete', { name });
    res.json({ success: true, message: `Remote "${name}" deleted` });
  } catch (err) {
    res.status(500).json({ error: 'Failed to delete remote: ' + err.message });
  }
});

app.get('/api/rclone/providers', authMiddleware, async (req, res) => {
  try {
    const result = await rcloneRC('/config/providers');
    // Rclone RC returns providers with varying field names, normalize them
    const raw = result.providers || [];
    const providers = raw.map((p) => ({
      name: p.Name || p.name || '',
      description: p.Description || p.description || '',
      prefix: p.Prefix || p.prefix || p.Name || p.name || '',
    }));
    res.json({ providers });
  } catch (err) {
    res.status(500).json({ error: 'Failed to get providers: ' + err.message });
  }
});

// ========================
// Service Management
// ========================
app.post('/api/service/restart', authMiddleware, (req, res) => {
  const { service } = req.body;
  const allowed = ['openlist', 'rclone', 'nginx'];
  if (!allowed.includes(service)) return res.status(400).json({ error: 'Invalid service' });
  try {
    execSync(`supervisorctl restart ${service}`, { encoding: 'utf-8', timeout: 15000 });
    res.json({ success: true, message: `${service} restarted` });
  } catch (err) {
    res.status(500).json({ error: 'Restart failed: ' + err.message });
  }
});

app.get('/api/logs/:service', authMiddleware, (req, res) => {
  const { service } = req.params;
  const allowed = ['openlist', 'rclone', 'nginx', 'api'];
  if (!allowed.includes(service)) return res.status(400).json({ error: 'Invalid service' });
  const logMap = {
    openlist: '/var/log/openlist.log',
    rclone: '/var/log/rclone.log',
    nginx: '/var/log/nginx/error.log',
    api: '/var/log/api.log',
  };
  try {
    const lines = parseInt(req.query.lines, 10) || 100;
    const log = execSync(`tail -n ${lines} ${logMap[service]} 2>/dev/null || echo "No logs available"`, {
      encoding: 'utf-8',
      timeout: 5000,
    });
    res.json({ service, log });
  } catch {
    res.json({ service, log: 'No logs available' });
  }
});

// Test remote connection
app.post('/api/rclone/test', authMiddleware, async (req, res) => {
  try {
    const { remote } = req.body;
    if (!remote) return res.status(400).json({ error: 'remote is required' });
    const start = Date.now();
    const fsPath = remote + ':';

    // Rclone RC API often returns 200 OK and empty list for invalid webdav/http configs
    // Therefore, using CLI commands directly is the most reliable way to catch connection errors.
    const util = require('util');
    const { execFile } = require('child_process');
    const execFilePromise = util.promisify(execFile);

    try {
      // Use lsf to list the first level of items. It will throw an error if connection fails.
      const { stdout } = await execFilePromise('rclone', ['lsf', fsPath, '--max-depth', '1', '--config=/data/rclone/rclone.conf'], { timeout: 15000 });
      const elapsed = Date.now() - start;
      const count = stdout.split('\n').filter(line => line.trim().length > 0).length;
      res.json({ ok: true, message: `连接成功！响应耗时: ${elapsed}ms, 根目录可见 ${count} 个项目。` });
    } catch (err) {
      // Extract the actual error message from stderr
      const stderr = err.stderr || err.message || '';
      // Clean up the error message, usually rclone outputs "Failed to XXX: error body"
      const cleanError = stderr.split('\n').filter(l => l.includes('Failed to') || l.includes('error')).join('; ') || stderr;
      throw new Error(cleanError || '未知连接错误');
    }
  } catch (err) {
    res.json({ ok: false, message: '连接失败: ' + err.message });
  }
});

// ========================
// File Operations
// ========================
// List files in a remote path
app.post('/api/rclone/ls', authMiddleware, async (req, res) => {
  try {
    const { fs: remotePath, remote, path: dirPath } = req.body;
    // Rclone operations/list works best with "fs" as the remote root (e.g. "openlist:") 
    // and "remote" as the subpath (e.g. "/path/to/folder")

    // Support two types of calls:
    // 1. fs="openlist:/path", remote is unused
    // 2. fs="openlist:", remote="/path"

    let fsStr = remotePath || remote;
    let remoteStr = dirPath || '';

    // If fs contains the full path (e.g., from frontend browse), split it
    if (fsStr && fsStr.includes(':') && !remoteStr) {
      const parts = fsStr.split(':');
      fsStr = parts[0] + ':';
      remoteStr = parts.slice(1).join(':').replace(/^\/+/, ''); // Remove leading slashes
    }

    if (!fsStr) return res.status(400).json({ error: 'fs or remote is required' });
    const result = await rcloneRC('/operations/list', { fs: fsStr, remote: remoteStr });
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Create directory in a remote
app.post('/api/rclone/mkdir', authMiddleware, async (req, res) => {
  try {
    const { fs: remotePath, remote: dirPath } = req.body;
    if (!remotePath) return res.status(400).json({ error: 'fs is required' });
    const result = await rcloneRC('/operations/mkdir', { fs: remotePath, remote: dirPath || '' });
    res.json({ success: true, result });
  } catch (err) {
    res.status(500).json({ error: 'Failed to create directory: ' + err.message });
  }
});

// Delete file or directory in a remote
app.post('/api/rclone/delete', authMiddleware, async (req, res) => {
  try {
    const { fs: remotePath, remote: filePath, isDir } = req.body;
    if (!remotePath) return res.status(400).json({ error: 'fs is required' });
    if (isDir) {
      // Purge removes the directory and all its contents
      const result = await rcloneRC('/operations/purge', { fs: remotePath, remote: filePath || '' });
      res.json({ success: true, result });
    } else {
      const result = await rcloneRC('/operations/deletefile', { fs: remotePath, remote: filePath || '' });
      res.json({ success: true, result });
    }
  } catch (err) {
    res.status(500).json({ error: 'Failed to delete: ' + err.message });
  }
});

app.get('/api/rclone/serve', (req, res) => {
  const token = req.query.token;
  if (!token) return res.status(401).send('Unauthorized');
  try { jwt.verify(token, JWT_SECRET); } catch { return res.status(401).send('Unauthorized'); }

  const fsStr = req.query.fs;
  const remotePath = req.query.path || '';
  if (!fsStr) return res.status(400).send('fs is required');

  const fsName = fsStr.replace(/:$/, '');
  const encodedPath = remotePath.split('/').map(encodeURIComponent).join('/');
  const targetPath = `/[${fsName}:]/${encodedPath}`;

  const options = {
    hostname: '127.0.0.1',
    port: 5572,
    path: targetPath,
    method: req.method,
    headers: { ...req.headers }
  };
  options.headers['host'] = '127.0.0.1:5572';
  delete options.headers['connection'];

  const proxyReq = http.request(options, (proxyRes) => {
    res.writeHead(proxyRes.statusCode, proxyRes.headers);
    proxyRes.pipe(res, { end: true });
  });

  proxyReq.on('error', (err) => {
    if (!res.headersSent) res.status(500).send('Proxy error: ' + err.message);
  });

  req.pipe(proxyReq, { end: true });
});

// Copy files between remotes
app.post('/api/rclone/copy', authMiddleware, async (req, res) => {
  try {
    const { srcFs, dstFs, _async, _config, _filter } = req.body;
    if (!srcFs || !dstFs) return res.status(400).json({ error: 'srcFs and dstFs are required' });
    const params = { srcFs, dstFs, _async: _async !== false };
    if (_config) params._config = _config;
    if (_filter) params._filter = _filter;
    const result = await rcloneRC('/sync/copy', params);
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Sync files between remotes
app.post('/api/rclone/sync', authMiddleware, async (req, res) => {
  try {
    const { srcFs, dstFs, _async, _config, _filter } = req.body;
    if (!srcFs || !dstFs) return res.status(400).json({ error: 'srcFs and dstFs are required' });
    const params = { srcFs, dstFs, _async: _async !== false };
    if (_config) params._config = _config;
    if (_filter) params._filter = _filter;
    const result = await rcloneRC('/sync/sync', params);
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Move files between remotes
app.post('/api/rclone/move', authMiddleware, async (req, res) => {
  try {
    const { srcFs, dstFs, _async, _config, _filter } = req.body;
    if (!srcFs || !dstFs) return res.status(400).json({ error: 'srcFs and dstFs are required' });
    const params = { srcFs, dstFs, _async: _async !== false };
    if (_config) params._config = _config;
    if (_filter) params._filter = _filter;
    const result = await rcloneRC('/sync/move', params);
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Get transfer stats
app.get('/api/rclone/stats', authMiddleware, async (req, res) => {
  try {
    const result = await rcloneRC('/core/stats');
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// List running jobs
app.get('/api/rclone/jobs', authMiddleware, async (req, res) => {
  try {
    const result = await rcloneRC('/job/list');
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Get job status
app.get('/api/rclone/job/:id', authMiddleware, async (req, res) => {
  try {
    const result = await rcloneRC('/job/status', { jobid: parseInt(req.params.id) });
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Stop a job
app.post('/api/rclone/job/stop', authMiddleware, async (req, res) => {
  try {
    const { jobid } = req.body;
    const result = await rcloneRC('/job/stop', { jobid });
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ========================
// Scheduled Tasks
// ========================
const TASKS_FILE = process.env.TASKS_FILE || '/data/rclone/scheduled-tasks.json';
const cronJobs = new Map(); // taskId -> cron.ScheduledTask

function loadTasks() {
  try {
    if (fs.existsSync(TASKS_FILE)) {
      return JSON.parse(fs.readFileSync(TASKS_FILE, 'utf-8'));
    }
  } catch (err) {
    console.error('Failed to load tasks:', err.message);
  }
  return [];
}

function saveTasks(tasks) {
  try {
    const dir = require('path').dirname(TASKS_FILE);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(TASKS_FILE, JSON.stringify(tasks, null, 2), 'utf-8');
  } catch (err) {
    console.error('Failed to save tasks:', err.message);
  }
}

async function executeTask(task) {
  const srcFs = task.srcRemote + ':' + (task.srcPath || '/');
  const dstFs = task.dstRemote + ':' + (task.dstPath || '/');
  const mode = task.mode || 'copy';
  const modeMap = { copy: '/sync/copy', sync: '/sync/sync', move: '/sync/move' };
  const endpoint = modeMap[mode] || '/sync/copy';

  const params = { srcFs, dstFs, _async: true };
  if (task.advancedOptions) {
    if (task.advancedOptions._config && Object.keys(task.advancedOptions._config).length) {
      const config = { ...task.advancedOptions._config };
      const intFields = ['Transfers', 'Checkers', 'Retries', 'LowLevelRetries', 'MaxDepth', 'MaxBacklog', 'Tpslimit', 'TpslimitBurst', 'StatsInterval', 'MultiThreadStreams', 'MultiThreadCutoff', 'BufferSize'];
      for (const field of intFields) {
        if (typeof config[field] === 'string' && /^\d+$/.test(config[field])) {
          config[field] = parseInt(config[field], 10);
        }
      }
      params._config = config;
    }
    if (task.advancedOptions._filter && Object.keys(task.advancedOptions._filter).length) {
      params._filter = task.advancedOptions._filter;
    }
  }

  const startTime = new Date().toISOString();
  try {
    const result = await rcloneRC(endpoint, params);
    return { time: startTime, status: 'success', jobId: result.jobid || null, message: '任务已启动' };
  } catch (err) {
    return { time: startTime, status: 'error', message: err.message };
  }
}

// 检查任务是否正在运行
async function isTaskRunning(task) {
  if (!task.activeJobId) return false;
  try {
    const jobStatus = await rcloneRC('/job/status', { jobid: task.activeJobId });
    // 如果查询成功且 finished 字段为 false，说明该 job 仍在运行中
    if (jobStatus && jobStatus.finished === false) {
      return true;
    }
  } catch (err) {
    // 报错说明 job 已经不存在（例如 rclone 重启过），认为没有在运行
  }
  return false;
}

function scheduleTask(task) {
  unscheduleTask(task.id);
  if (!task.enabled || !task.cron) return;
  if (!cron.validate(task.cron)) {
    console.error(`Invalid cron expression for task ${task.id}: ${task.cron}`);
    return;
  }
  const job = cron.schedule(task.cron, async () => {
    console.log(`[Scheduler] Running task: ${task.name} (${task.id})`);
    const tasks = loadTasks();
    const t = tasks.find(x => x.id === task.id);
    if (!t || !t.enabled) return;

    // 定时任务防重复执行锁
    if (await isTaskRunning(t)) {
      console.log(`[Scheduler] Task ${t.name} is already running, skipping this scheduled run.`);
      return;
    }

    const record = await executeTask(t);
    t.lastRun = record.time;
    t.lastStatus = record.status;
    t.activeJobId = record.jobId; // 保存启动的 jobId 以供下次判断
    
    if (!t.history) t.history = [];
    t.history.unshift(record);
    if (t.history.length > 50) t.history = t.history.slice(0, 50);
    saveTasks(tasks);

    const notifyPolicy = t.notifyPolicy || (t.notifyOnComplete !== false ? 'always' : 'none');
    const isIgnored = isErrorIgnored(record.message);
    
    // Monitor job completion for Bark notification
    if (record.jobId && notifyPolicy !== 'none') {
      monitorJobCompletion(t.id, t.name, record.jobId);
    } else if (record.status === 'error' && notifyPolicy !== 'none' && !isIgnored) {
      sendBarkNotification(`任务❌ 失败: ${t.name}`, `启动错误: ${record.message}`);
    }
  }, { scheduled: true, timezone: 'Asia/Shanghai' });
  cronJobs.set(task.id, job);
}

function unscheduleTask(taskId) {
  const existing = cronJobs.get(taskId);
  if (existing) {
    existing.stop();
    cronJobs.delete(taskId);
  }
}

function initScheduler() {
  const tasks = loadTasks();
  tasks.forEach(t => { if (t.enabled) scheduleTask(t); });
  console.log(`[Scheduler] Initialized ${tasks.filter(t => t.enabled).length}/${tasks.length} tasks`);
}

// --- Task CRUD API ---
app.get('/api/tasks', authMiddleware, (req, res) => {
  const tasks = loadTasks();
  // Return tasks without full history for list view
  const list = tasks.map(t => ({
    ...t,
    history: undefined,
    historyCount: (t.history || []).length,
  }));
  res.json({ tasks: list });
});

app.post('/api/tasks', authMiddleware, (req, res) => {
  const { name, srcRemote, srcPath, dstRemote, dstPath, mode, cron: cronExpr, enabled, notifyPolicy, notifyOnComplete, advancedOptions } = req.body;
  if (!name || !srcRemote || !dstRemote) {
    return res.status(400).json({ error: '任务名称、源存储和目标存储为必填项' });
  }
  if (cronExpr && !cron.validate(cronExpr)) {
    return res.status(400).json({ error: 'Cron 表达式格式无效' });
  }
  const task = {
    id: uuidv4(),
    name,
    srcRemote,
    srcPath: srcPath || '/',
    dstRemote,
    dstPath: dstPath || '/',
    mode: mode || 'copy',
    cron: cronExpr || '',
    enabled: enabled !== false,
    notifyPolicy: notifyPolicy || (notifyOnComplete !== false ? 'always' : 'none'),
    notifyOnComplete: notifyPolicy !== 'none' && notifyOnComplete !== false, // Backward compatibility
    advancedOptions: advancedOptions || {},
    lastRun: null,
    lastStatus: null,
    activeJobId: null,
    history: [],
    createdAt: new Date().toISOString(),
  };
  const tasks = loadTasks();
  tasks.push(task);
  saveTasks(tasks);
  if (task.enabled && task.cron) scheduleTask(task);
  res.json({ success: true, task: { ...task, history: undefined } });
});

app.put('/api/tasks/:id', authMiddleware, (req, res) => {
  const tasks = loadTasks();
  const idx = tasks.findIndex(t => t.id === req.params.id);
  if (idx === -1) return res.status(404).json({ error: '任务不存在' });

  const { name, srcRemote, srcPath, dstRemote, dstPath, mode, cron: cronExpr, enabled, notifyPolicy, notifyOnComplete, advancedOptions } = req.body;
  if (cronExpr && !cron.validate(cronExpr)) {
    return res.status(400).json({ error: 'Cron 表达式格式无效' });
  }

  const task = tasks[idx];
  if (name !== undefined) task.name = name;
  if (srcRemote !== undefined) task.srcRemote = srcRemote;
  if (srcPath !== undefined) task.srcPath = srcPath;
  if (dstRemote !== undefined) task.dstRemote = dstRemote;
  if (dstPath !== undefined) task.dstPath = dstPath;
  if (mode !== undefined) task.mode = mode;
  if (cronExpr !== undefined) task.cron = cronExpr;
  if (enabled !== undefined) task.enabled = enabled;
  if (advancedOptions !== undefined) task.advancedOptions = advancedOptions;
  if (notifyPolicy !== undefined) {
    task.notifyPolicy = notifyPolicy;
    task.notifyOnComplete = notifyPolicy !== 'none';
  } else if (notifyOnComplete !== undefined) {
    task.notifyOnComplete = notifyOnComplete;
    task.notifyPolicy = notifyOnComplete ? 'always' : 'none';
  }

  saveTasks(tasks);
  scheduleTask(task);
  res.json({ success: true, task: { ...task, history: undefined } });
});

app.delete('/api/tasks/:id', authMiddleware, (req, res) => {
  let tasks = loadTasks();
  const idx = tasks.findIndex(t => t.id === req.params.id);
  if (idx === -1) return res.status(404).json({ error: '任务不存在' });
  unscheduleTask(req.params.id);
  tasks.splice(idx, 1);
  saveTasks(tasks);
  res.json({ success: true });
});

app.post('/api/tasks/:id/run', authMiddleware, async (req, res) => {
  const tasks = loadTasks();
  const task = tasks.find(t => t.id === req.params.id);
  if (!task) return res.status(404).json({ error: '任务不存在' });

  // 手动触发任务防重复执行锁，适配前端 UI 解析结构
  if (await isTaskRunning(task)) {
    return res.json({ 
      success: false, 
      record: { status: 'error', message: '当前任务正在执行中，请勿重复触发' } 
    });
  }

  const record = await executeTask(task);
  task.lastRun = record.time;
  task.lastStatus = record.status;
  task.activeJobId = record.jobId; // 保存启动的 jobId 以供下次判断
  
  if (!task.history) task.history = [];
  task.history.unshift(record);
  if (task.history.length > 50) task.history = task.history.slice(0, 50);
  saveTasks(tasks);

  const notifyPolicy = task.notifyPolicy || (task.notifyOnComplete !== false ? 'always' : 'none');
  const isIgnored = isErrorIgnored(record.message);
  
  // Monitor job completion for Bark notification
  if (record.jobId && notifyPolicy !== 'none') {
    monitorJobCompletion(task.id, task.name, record.jobId);
  } else if (record.status === 'error' && notifyPolicy !== 'none' && !isIgnored) {
    sendBarkNotification(`任务❌ 失败: ${task.name}`, `启动错误: ${record.message}`);
  }
  res.json({ success: true, record });
});

app.post('/api/tasks/:id/toggle', authMiddleware, (req, res) => {
  const tasks = loadTasks();
  const task = tasks.find(t => t.id === req.params.id);
  if (!task) return res.status(404).json({ error: '任务不存在' });

  task.enabled = !task.enabled;
  saveTasks(tasks);
  if (task.enabled) scheduleTask(task);
  else unscheduleTask(task.id);
  res.json({ success: true, enabled: task.enabled });
});

// Stop a running task
app.post('/api/tasks/:id/stop', authMiddleware, async (req, res) => {
  const tasks = loadTasks();
  const task = tasks.find(t => t.id === req.params.id);
  if (!task) return res.status(404).json({ error: '任务不存在' });

  if (!task.activeJobId) {
    return res.json({ success: false, message: '该任务当前没有正在执行的作业' });
  }

  try {
    // Check if job is actually running
    const jobStatus = await rcloneRC('/job/status', { jobid: task.activeJobId });
    if (jobStatus && jobStatus.finished !== false) {
      task.activeJobId = null;
      saveTasks(tasks);
      return res.json({ success: false, message: '该任务已经执行完毕' });
    }
  } catch (err) {
    // Job doesn't exist anymore
    task.activeJobId = null;
    saveTasks(tasks);
    return res.json({ success: false, message: '该任务的作业已不存在（可能已完成或 Rclone 已重启）' });
  }

  try {
    await rcloneRC('/job/stop', { jobid: task.activeJobId });
    const stoppedJobId = task.activeJobId;
    task.activeJobId = null;

    // Add a history record
    if (!task.history) task.history = [];
    task.history.unshift({
      time: new Date().toISOString(),
      status: 'stopped',
      jobId: stoppedJobId,
      message: '任务被手动停止',
    });
    if (task.history.length > 50) task.history = task.history.slice(0, 50);
    saveTasks(tasks);

    res.json({ success: true, message: `任务已停止 (Job ID: ${stoppedJobId})` });
  } catch (err) {
    res.status(500).json({ error: '停止任务失败: ' + err.message });
  }
});

// Bark notification status
app.get('/api/bark/status', authMiddleware, (req, res) => {
  res.json({ configured: !!BARK_URL, url: BARK_URL ? BARK_URL.replace(/\/[^/]+$/, '/***') : '' });
});

app.get('/api/tasks/:id/history', authMiddleware, (req, res) => {
  const tasks = loadTasks();
  const task = tasks.find(t => t.id === req.params.id);
  if (!task) return res.status(404).json({ error: '任务不存在' });
  res.json({ history: task.history || [] });
});

// ========================
// Start Server
// ========================
app.listen(PORT, '127.0.0.1', () => {
  console.log(`API server running on http://127.0.0.1:${PORT}`);
  initScheduler();
});
