### `Databricks` 专用
[Databricks 官网](https://www.databricks.com/)

```javascript
process.env.OPENLIST_ADMIN_PASSWORD = '这里换成你想要的openList密码';
process.env.WEB_PASSWORD = '这里换成你想要的控制台密码';

const express = require('express');
const jwt = require('jsonwebtoken');
// [修复] 引入 execFileSync 防止特殊密码导致的命令注入崩溃
const { execSync, spawn, execFile, execFileSync, exec } = require('child_process');
const fs = require('fs');
const path = require('path');
const http = require('http');
const cron = require('node-cron');
const { v4: uuidv4 } = require('uuid');
const crypto = require('crypto');
const rateLimit = require('express-rate-limit');
const { createProxyMiddleware } = require('http-proxy-middleware');
const AdmZip = require('adm-zip');
const util = require('util');
const execFilePromise = util.promisify(execFile);
const execPromise = util.promisify(exec);

// ========================
// 平台环境与路径配置
// ========================
const PORT = process.env.DATABRICKS_APP_PORT || process.env.SERVER_PORT || process.env.PORT || 8080;
const HOST = process.env.DATABRICKS_APP_HOST || '0.0.0.0';
const ROOT_DIR = __dirname;
const DATA_DIR = path.join(ROOT_DIR, 'data');
const BIN_DIR = path.join(ROOT_DIR, 'bin');
const TASKS_FILE = process.env.TASKS_FILE || path.join(DATA_DIR, 'rclone', 'scheduled-tasks.json');

// [修复] 固定 JWT 密钥，防止容器隐性重启导致密钥变更、Token 突然失效
const JWT_SECRET = process.env.JWT_SECRET || 'databricks-openlist-rclone-fixed-secret-key-123456';
const WEB_USERNAME = process.env.WEB_USERNAME || 'admin';
const WEB_PASSWORD = process.env.WEB_PASSWORD || 'admin';
const RCLONE_ADDR = process.env.RCLONE_ADDR || 'http://127.0.0.1:5572';
const BARK_URL = process.env.BARK_URL || '';
const IGNORE_ERRORS = process.env.IGNORE_ERRORS || 'object not found';

// 【新增】将你的数据库信息直接填在这里 (务必填写正确，否则数据无法恢复)
process.env.STORAGE_TYPE = 'webdav';
process.env.WEBDAV_URL = 'https://dav.jianguoyun.com/dav/';
process.env.WEBDAV_USER = '请在此填入您的坚果云邮箱账号';
process.env.WEBDAV_PASS = '请在此填入生成的第三方应用密码'; // 绝对不能是网页登录密码
process.env.WEBDAV_VENDOR = 'other';
process.env.WEBDAV_PATH = 'Pterodactyl';

// 自动同步外部存储的时间间隔
process.env.SYNC_INTERVAL= '5';

// 配置后定时任务执行完成时会自动发送推送通知
// process.env.BARK_URL= 'https://api.day.app/yourkey';


// 进程引用
let openlistProcess = null;
let rcloneProcess = null;

// ========================
// 内存日志系统
// ========================
const logsMemory = { openlist: [], rclone: [], api: [] };
function appendLog(service, data) {
    if (!data) return;
    const lines = data.toString().split('\n');
    for (let l of lines) {
        if (l.trim()) {
            logsMemory[service].push(l);
            if (logsMemory[service].length > 200) logsMemory[service].shift();
        }
    }
}
const origLog = console.log;
const origErr = console.error;
console.log = function(...args) { appendLog('api', args.join(' ')); origLog.apply(console, args); };
console.error = function(...args) { appendLog('api', args.join(' ')); origErr.apply(console, args); };

// ========================
// 辅助函数
// ========================
function isErrorIgnored(errorMsg) {
    if (!errorMsg) return false;
    const ignoreList = IGNORE_ERRORS.split(',').map(s => s.trim()).filter(Boolean);
    return ignoreList.some(ignoreStr => errorMsg.includes(ignoreStr));
}

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
    const MAX_MONITOR_TIME = 24 * 60 * 60 * 1000;
    const CHECK_INTERVAL = 15000;

    const timer = setInterval(async () => {
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

                const tasks = loadTasks();
                const task = tasks.find(t => t.id === taskId);
                if (task) {
                    task.activeJobId = null;
                    if (task.history && task.history.length > 0) {
                        const record = task.history.find(h => h.jobId === jobId);
                        if (record) {
                            record.status = success ? 'success' : 'error';
                            record.message = isIgnoredError ? `任务完成 (忽略文件缺失, 耗时 ${duration} 分钟)` : (success ? `任务完成 (耗时 ${duration} 分钟)` : `任务失败: ${errorMsg}`);
                            record.completedAt = new Date().toISOString();
                            task.lastStatus = record.status;
                        }
                    }
                    saveTasks(tasks);

                    const notifyPolicy = task.notifyPolicy || (task.notifyOnComplete !== false ? 'always' : 'none');
                    if (notifyPolicy === 'always' || (notifyPolicy === 'failure_only' && !success)) {
                        const title = `任务${statusText}: ${taskName}`;
                        const body = isIgnoredError ? `耗时 ${duration} 分钟 (部分动态文件已被覆盖或删除，已忽略)` : (success ? `耗时 ${duration} 分钟` : `错误: ${errorMsg || '未知错误'}`);
                        await sendBarkNotification(title, body);
                    }
                }
            }
        } catch (err) {
            clearInterval(timer);
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
// API 服务器构建
// ========================
const app = express();
app.set('trust proxy', 1);

// 限制 express.json() 仅对 /console-api/ 生效，防止吃掉 openList 代理的 POST 请求
app.use('/console-api', express.json());

// [修复] 优化控制台鉴权中间件，优先读 Header，被代理截断则读 Cookie
function authMiddleware(req, res, next) {
    let token = req.headers.authorization?.replace('Bearer ', '');
    if (!token) {
        token = req.headers.cookie?.match(/_auth_token=([^;]+)/)?.[1];
    }
    
    if (!token) return res.status(401).json({ error: 'Unauthorized' });
    try {
        req.user = jwt.verify(token, JWT_SECRET);
        next();
    } catch {
        return res.status(401).json({ error: 'Invalid token' });
    }
}

const loginLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 5,
    message: { error: '登录尝试次数过多，请 15 分钟后再试' },
    standardHeaders: true,
    legacyHeaders: false,
});

app.post('/console-api/login', loginLimiter, (req, res) => {
    const { username, password } = req.body;
    if (!username || !password) return res.status(401).json({ error: 'Invalid credentials' });

    // [修复] 强制转换为 String，防止黑客传入非字符串对象导致 Node.js 直接抛异常崩溃退出
    const expectedUser = Buffer.from(String(WEB_USERNAME));
    const expectedPass = Buffer.from(String(WEB_PASSWORD));
    const providedUser = Buffer.from(String(username));
    const providedPass = Buffer.from(String(password));

    let userMatch = false, passMatch = false;
    if (expectedUser.length === providedUser.length) userMatch = crypto.timingSafeEqual(expectedUser, providedUser);
    if (expectedPass.length === providedPass.length) passMatch = crypto.timingSafeEqual(expectedPass, providedPass);

    if (userMatch && passMatch) {
        const token = jwt.sign({ username: WEB_USERNAME }, JWT_SECRET, { expiresIn: '24h' });
        res.cookie('_auth_token', token, { httpOnly: true, sameSite: 'lax', path: '/', maxAge: 86400000 });
        return res.json({ token, username: WEB_USERNAME });
    }
    return res.status(401).json({ error: 'Invalid credentials' });
});

app.get('/console-api/auth/check', authMiddleware, (req, res) => res.json({ valid: true, username: req.user.username }));
app.get('/console-api/auth/cookie', (req, res) => {
    const token = req.cookies?._auth_token || req.headers.cookie?.match(/_auth_token=([^;]+)/)?.[1];
    if (!token) return res.status(401).end();
    try { jwt.verify(token, JWT_SECRET); return res.status(200).end(); } catch { return res.status(401).end(); }
});

app.get('/console-api/status', authMiddleware, async (req, res) => {
    const status = { openlist: 'stopped', rclone: 'stopped', uptime: 0 };
    if (openlistProcess && !openlistProcess.killed) status.openlist = 'running';
    try {
        await rcloneRC('/rc/noop');
        status.rclone = 'running';
    } catch { status.rclone = 'stopped'; }
    try {
        const uptime = fs.readFileSync('/proc/uptime', 'utf-8').split(' ')[0];
        status.uptime = Math.floor(parseFloat(uptime));
    } catch { status.uptime = 0; }
    res.json(status);
});

app.get('/console-api/rclone/remotes', authMiddleware, async (req, res) => {
    try {
        const result = await rcloneRC('/config/listremotes');
        const remotes = result.remotes || [];
        const details = [];
        for (const name of remotes) {
            try {
                const dump = await rcloneRC('/config/get', { name });
                details.push({ name, ...dump });
            } catch { details.push({ name, type: 'unknown' }); }
        }
        res.json({ remotes: details });
    } catch (err) { res.status(500).json({ error: 'Failed to list remotes: ' + err.message }); }
});

app.post('/console-api/rclone/remote', authMiddleware, async (req, res) => {
    try {
        const { name, type, parameters } = req.body;
        if (!name || !type) return res.status(400).json({ error: 'name and type are required' });
        await rcloneRC('/config/create', { name, type, parameters: parameters || {} });
        res.json({ success: true, message: `Remote "${name}" created` });
    } catch (err) { res.status(500).json({ error: 'Failed to create remote: ' + err.message }); }
});

app.put('/console-api/rclone/remote/:name', authMiddleware, async (req, res) => {
    try {
        const { name } = req.params;
        const { parameters } = req.body;
        await rcloneRC('/config/update', { name, parameters: parameters || {} });
        res.json({ success: true, message: `Remote "${name}" updated` });
    } catch (err) { res.status(500).json({ error: 'Failed to update remote: ' + err.message }); }
});

app.delete('/console-api/rclone/remote/:name', authMiddleware, async (req, res) => {
    try {
        const { name } = req.params;
        await rcloneRC('/config/delete', { name });
        res.json({ success: true, message: `Remote "${name}" deleted` });
    } catch (err) { res.status(500).json({ error: 'Failed to delete remote: ' + err.message }); }
});

app.get('/console-api/rclone/providers', authMiddleware, async (req, res) => {
    try {
        const result = await rcloneRC('/config/providers');
        const raw = result.providers || [];
        const providers = raw.map((p) => ({
            name: p.Name || p.name || '',
            description: p.Description || p.description || '',
            prefix: p.Prefix || p.prefix || p.Name || p.name || '',
        }));
        res.json({ providers });
    } catch (err) { res.status(500).json({ error: 'Failed to get providers: ' + err.message }); }
});

app.post('/console-api/service/restart', authMiddleware, (req, res) => {
    const { service } = req.body;
    try {
        if (service === 'openlist' && openlistProcess) {
            openlistProcess.kill();
            openlistProcess = spawn(path.join(BIN_DIR, 'openlist'), ['server', '--data', path.join(DATA_DIR, 'openlist')]);
            openlistProcess.stdout.on('data', d => appendLog('openlist', d));
            openlistProcess.stderr.on('data', d => appendLog('openlist', d));
        } else if (service === 'rclone' && rcloneProcess) {
            rcloneProcess.kill();
            rcloneProcess = spawn(path.join(BIN_DIR, 'rclone'), ['rcd', '--rc-addr=127.0.0.1:5572', '--rc-no-auth', `--config=${path.join(DATA_DIR, 'rclone', 'rclone.conf')}`, `--cache-dir=${path.join(DATA_DIR, 'rclone', 'cache')}`]);
            rcloneProcess.stdout.on('data', d => appendLog('rclone', d));
            rcloneProcess.stderr.on('data', d => appendLog('rclone', d));
        }
        res.json({ success: true, message: `${service} restarted` });
    } catch (err) { res.status(500).json({ error: 'Restart failed: ' + err.message }); }
});

app.get('/console-api/logs/:service', authMiddleware, (req, res) => {
    const { service } = req.params;
    const allowed = ['openlist', 'rclone', 'nginx', 'api'];
    if (!allowed.includes(service)) return res.status(400).json({ error: 'Invalid service' });
    if (service === 'nginx') return res.json({ service, log: 'Nginx 服务在此架构下已被 Node.js 反向代理完全替代。请查阅 API 日志。' });
    res.json({ service, log: logsMemory[service].join('\n') || 'No logs available' });
});

app.post('/console-api/rclone/test', authMiddleware, async (req, res) => {
    try {
        const { remote } = req.body;
        if (!remote) return res.status(400).json({ error: 'remote is required' });
        const start = Date.now();
        const fsPath = remote + ':';
        try {
            const { stdout } = await execFilePromise(path.join(BIN_DIR, 'rclone'), ['lsf', fsPath, '--max-depth', '1', `--config=${path.join(DATA_DIR, 'rclone', 'rclone.conf')}`], { timeout: 15000 });
            const elapsed = Date.now() - start;
            const count = stdout.split('\n').filter(line => line.trim().length > 0).length;
            res.json({ ok: true, message: `连接成功！响应耗时: ${elapsed}ms, 根目录可见 ${count} 个项目。` });
        } catch (err) {
            const stderr = err.stderr || err.message || '';
            const cleanError = stderr.split('\n').filter(l => l.includes('Failed to') || l.includes('error')).join('; ') || stderr;
            throw new Error(cleanError || '未知连接错误');
        }
    } catch (err) { res.json({ ok: false, message: '连接失败: ' + err.message }); }
});

app.post('/console-api/rclone/ls', authMiddleware, async (req, res) => {
    try {
        let { fs: remotePath, remote: dirPath } = req.body;
        let fsStr = remotePath || dirPath;
        let remoteStr = dirPath || '';
        if (fsStr && fsStr.includes(':') && !remoteStr) {
            const parts = fsStr.split(':');
            fsStr = parts[0] + ':';
            remoteStr = parts.slice(1).join(':').replace(/^\/+/, '');
        }
        if (!fsStr) return res.status(400).json({ error: 'fs or remote is required' });
        const result = await rcloneRC('/operations/list', { fs: fsStr, remote: remoteStr });
        res.json(result);
    } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/console-api/rclone/mkdir', authMiddleware, async (req, res) => {
    try {
        const { fs: remotePath, remote: dirPath } = req.body;
        const result = await rcloneRC('/operations/mkdir', { fs: remotePath, remote: dirPath || '' });
        res.json({ success: true, result });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/console-api/rclone/delete', authMiddleware, async (req, res) => {
    try {
        const { fs: remotePath, remote: filePath, isDir } = req.body;
        const result = await rcloneRC(isDir ? '/operations/purge' : '/operations/deletefile', { fs: remotePath, remote: filePath || '' });
        res.json({ success: true, result });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

const transferHandler = async (req, res, endpoint) => {
    try {
        const { srcFs, dstFs, _async, _config, _filter } = req.body;
        if (!srcFs || !dstFs) return res.status(400).json({ error: 'srcFs and dstFs are required' });
        const params = { srcFs, dstFs, _async: _async !== false };
        if (_config) params._config = _config;
        if (_filter) params._filter = _filter;
        const result = await rcloneRC(endpoint, params);
        res.json(result);
    } catch (err) { res.status(500).json({ error: err.message }); }
};

app.post('/console-api/rclone/copy', authMiddleware, (req, res) => transferHandler(req, res, '/sync/copy'));
app.post('/console-api/rclone/sync', authMiddleware, (req, res) => transferHandler(req, res, '/sync/sync'));
app.post('/console-api/rclone/move', authMiddleware, (req, res) => transferHandler(req, res, '/sync/move'));
app.get('/console-api/rclone/stats', authMiddleware, async (req, res) => { try { res.json(await rcloneRC('/core/stats')); } catch (err) { res.status(500).json({ error: err.message }); } });
app.get('/console-api/rclone/jobs', authMiddleware, async (req, res) => { try { res.json(await rcloneRC('/job/list')); } catch (err) { res.status(500).json({ error: err.message }); } });
app.get('/console-api/rclone/job/:id', authMiddleware, async (req, res) => { try { res.json(await rcloneRC('/job/status', { jobid: parseInt(req.params.id) })); } catch (err) { res.status(500).json({ error: err.message }); } });
app.post('/console-api/rclone/job/stop', authMiddleware, async (req, res) => { try { res.json(await rcloneRC('/job/stop', { jobid: req.body.jobid })); } catch (err) { res.status(500).json({ error: err.message }); } });

// ========================
// 定时任务管理
// ========================
const cronJobs = new Map();
function loadTasks() { try { if (fs.existsSync(TASKS_FILE)) return JSON.parse(fs.readFileSync(TASKS_FILE, 'utf-8')); } catch (e) { console.error('[Task] Failed to load tasks:', e.message); } return []; }
function saveTasks(tasks) { try { fs.writeFileSync(TASKS_FILE, JSON.stringify(tasks, null, 2), 'utf-8'); } catch (e) { console.error('[Task] Failed to save tasks:', e.message); } }

async function executeTask(task) {
    const srcFs = task.srcRemote + ':' + (task.srcPath || '/');
    const dstFs = task.dstRemote + ':' + (task.dstPath || '/');
    const modeMap = { copy: '/sync/copy', sync: '/sync/sync', move: '/sync/move' };
    const params = { srcFs, dstFs, _async: true };
    if (task.advancedOptions) {
        if (task.advancedOptions._config && Object.keys(task.advancedOptions._config).length) {
            const config = { ...task.advancedOptions._config };
            const intFields = ['Transfers', 'Checkers', 'Retries', 'LowLevelRetries', 'MaxDepth', 'MaxBacklog', 'Tpslimit', 'TpslimitBurst', 'StatsInterval', 'MultiThreadStreams', 'MultiThreadCutoff', 'BufferSize'];
            for (const field of intFields) if (typeof config[field] === 'string' && /^\d+$/.test(config[field])) config[field] = parseInt(config[field], 10);
            params._config = config;
        }
        if (task.advancedOptions._filter) params._filter = task.advancedOptions._filter;
    }
    const startTime = new Date().toISOString();
    try {
        const result = await rcloneRC(modeMap[task.mode] || '/sync/copy', params);
        return { time: startTime, status: 'success', jobId: result.jobid || null, message: '任务已启动' };
    } catch (err) { return { time: startTime, status: 'error', message: err.message }; }
}

async function isTaskRunning(task) {
    if (!task.activeJobId) return false;
    try { const jobStatus = await rcloneRC('/job/status', { jobid: task.activeJobId }); return jobStatus && jobStatus.finished === false; } catch { return false; }
}

function scheduleTask(task) {
    unscheduleTask(task.id);
    if (!task.enabled || !task.cron) return;
    const job = cron.schedule(task.cron, async () => {
        const tasks = loadTasks();
        const t = tasks.find(x => x.id === task.id);
        if (!t || !t.enabled || await isTaskRunning(t)) return;
        const record = await executeTask(t);
        t.lastRun = record.time; t.lastStatus = record.status; t.activeJobId = record.jobId;
        if (!t.history) t.history = [];
        t.history.unshift(record);
        if (t.history.length > 50) t.history = t.history.slice(0, 50);
        saveTasks(tasks);
        if (record.jobId && t.notifyPolicy !== 'none') monitorJobCompletion(t.id, t.name, record.jobId);
        else if (record.status === 'error' && t.notifyPolicy !== 'none' && !isErrorIgnored(record.message)) sendBarkNotification(`任务❌ 失败: ${t.name}`, `启动错误: ${record.message}`);
    }, { scheduled: true, timezone: 'Asia/Shanghai' });
    cronJobs.set(task.id, job);
}

function unscheduleTask(taskId) { if (cronJobs.has(taskId)) { cronJobs.get(taskId).stop(); cronJobs.delete(taskId); } }
function initScheduler() { loadTasks().forEach(t => { if (t.enabled) scheduleTask(t); }); }

app.get('/console-api/tasks', authMiddleware, (req, res) => res.json({ tasks: loadTasks().map(t => ({ ...t, history: undefined, historyCount: (t.history || []).length })) }));
app.post('/console-api/tasks', authMiddleware, (req, res) => {
    const { name, srcRemote, srcPath, dstRemote, dstPath, mode, cron: cronExpr, enabled, notifyPolicy, advancedOptions } = req.body;
    const task = { id: uuidv4(), name, srcRemote, srcPath: srcPath || '/', dstRemote, dstPath: dstPath || '/', mode: mode || 'copy', cron: cronExpr || '', enabled: enabled !== false, notifyPolicy: notifyPolicy || 'always', advancedOptions: advancedOptions || {}, lastRun: null, lastStatus: null, activeJobId: null, history: [], createdAt: new Date().toISOString() };
    const tasks = loadTasks(); tasks.push(task); saveTasks(tasks);
    if (task.enabled && task.cron) scheduleTask(task);
    res.json({ success: true, task: { ...task, history: undefined } });
});
app.put('/console-api/tasks/:id', authMiddleware, (req, res) => {
    const tasks = loadTasks(); const idx = tasks.findIndex(t => t.id === req.params.id); if (idx === -1) return res.status(404).json({ error: '任务不存在' });
    Object.assign(tasks[idx], req.body); saveTasks(tasks); scheduleTask(tasks[idx]);
    res.json({ success: true, task: { ...tasks[idx], history: undefined } });
});
app.delete('/console-api/tasks/:id', authMiddleware, (req, res) => {
    let tasks = loadTasks(); const idx = tasks.findIndex(t => t.id === req.params.id); if (idx === -1) return res.status(404).json({ error: '任务不存在' });
    unscheduleTask(req.params.id); tasks.splice(idx, 1); saveTasks(tasks); res.json({ success: true });
});
app.post('/console-api/tasks/:id/run', authMiddleware, async (req, res) => {
    const tasks = loadTasks(); const task = tasks.find(t => t.id === req.params.id); if (!task) return res.status(404).json({ error: '任务不存在' });
    if (await isTaskRunning(task)) return res.json({ success: false, record: { status: 'error', message: '正在执行中' } });
    const record = await executeTask(task);
    task.lastRun = record.time; task.lastStatus = record.status; task.activeJobId = record.jobId;
    if (!task.history) task.history = []; task.history.unshift(record); if (task.history.length > 50) task.history = task.history.slice(0, 50); saveTasks(tasks);
    if (record.jobId && task.notifyPolicy !== 'none') monitorJobCompletion(task.id, task.name, record.jobId);
    res.json({ success: true, record });
});
app.post('/console-api/tasks/:id/toggle', authMiddleware, (req, res) => {
    const tasks = loadTasks(); const task = tasks.find(t => t.id === req.params.id); if (!task) return res.status(404).json({ error: '任务不存在' });
    task.enabled = !task.enabled; saveTasks(tasks); task.enabled ? scheduleTask(task) : unscheduleTask(task.id); res.json({ success: true, enabled: task.enabled });
});
app.post('/console-api/tasks/:id/stop', authMiddleware, async (req, res) => {
    const tasks = loadTasks(); const task = tasks.find(t => t.id === req.params.id);
    if (!task || !task.activeJobId) return res.json({ success: false, message: '无法停止' });
    try { await rcloneRC('/job/stop', { jobid: task.activeJobId }); task.activeJobId = null; saveTasks(tasks); res.json({ success: true, message: `任务已停止` }); } catch (err) { res.status(500).json({ error: err.message }); }
});
app.get('/console-api/bark/status', authMiddleware, (req, res) => res.json({ configured: !!BARK_URL, url: BARK_URL ? BARK_URL.replace(/\/[^/]+$/, '/***') : '' }));
app.get('/console-api/tasks/:id/history', authMiddleware, (req, res) => res.json({ history: loadTasks().find(t => t.id === req.params.id)?.history || [] }));

// ========================
// 静态文件与 openList 路由代理配置
// ========================
app.use('/console', express.static(path.join(ROOT_DIR, 'web')));
app.get('/console/*', (req, res) => res.sendFile(path.join(ROOT_DIR, 'web', 'index.html')));

// [终极修复增强版] 拦截 openList 的原生登录请求（包含 hash 登录），使用原生 http 模块防止 fetch 兼容性问题
app.post(['/api/auth/login', '/api/auth/login/hash'], express.json(), (req, res) => {
    const postData = JSON.stringify(req.body || {});
    const options = {
        hostname: '127.0.0.1',
        port: 5244,
        path: req.originalUrl,
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'Content-Length': Buffer.byteLength(postData)
        }
    };

    const proxyReq = http.request(options, (proxyRes) => {
        let body = '';
        proxyRes.on('data', (chunk) => { body += chunk; });
        proxyRes.on('end', () => {
            try {
                const data = JSON.parse(body);
                // 如果登录成功，颁发 Cookie 备用
                if (data.code === 200 && data.data && data.data.token) {
                    res.cookie('openlist_fallback_token', data.data.token, { path: '/' });
                }
                res.status(proxyRes.statusCode).json(data);
            } catch (e) {
                res.status(proxyRes.statusCode).send(body);
            }
        });
    });

    proxyReq.on('error', (err) => {
        res.status(500).json({ code: 500, message: 'Proxy login request failed: ' + err.message });
    });

    proxyReq.write(postData);
    proxyReq.end();
});

// openList 全局反向代理
app.use('/', createProxyMiddleware({
    target: 'http://127.0.0.1:5244',
    changeOrigin: true,
    ws: true,
    logLevel: 'error',
    onProxyReq: (proxyReq, req, res) => {
        // [防御机制] 当网关野蛮删除 Authorization 头时，从 Cookie 中急救
        if (!proxyReq.getHeader('authorization') && !proxyReq.getHeader('Authorization')) {
            const cookieHeader = req.headers.cookie;
            if (cookieHeader) {
                const match = cookieHeader.match(/openlist_fallback_token=([^;]+)/);
                if (match) {
                    proxyReq.setHeader('Authorization', match[1]); 
                }
            }
        }
    }
}));


// ========================
// 初始化与引导程序 (Bootstrap)
// ========================
async function bootstrap() {
    console.log("============================================");
    console.log("  openList-Rclone All-in-One for Node.js PaaS  ");
    console.log("============================================");

    // 1. 初始化目录和环境变量
    if (!fs.existsSync(BIN_DIR)) fs.mkdirSync(BIN_DIR, { recursive: true });
    if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
    if (!fs.existsSync(path.join(DATA_DIR, 'rclone'))) fs.mkdirSync(path.join(DATA_DIR, 'rclone', 'cache'), { recursive: true });
    process.env.PATH = `${BIN_DIR}:${process.env.PATH}`;

    const archMap = { 'x64': 'amd64', 'arm64': 'arm64', 'arm': 'arm-v7' };
    const arch = archMap[process.arch] || 'amd64';

    // [修复] 移除 -musl，下载标准版 openList 以适配 Databricks Ubuntu 容器
    const openlistPath = path.join(BIN_DIR, 'openlist');
    if (!fs.existsSync(openlistPath)) {
        console.log(`[Init] Downloading openList (${arch})...`);
        try {
            const openlistUrl = `https://github.com/openListGo/openlist/releases/latest/download/openlist-linux-${arch}.tar.gz`;
            execSync(`curl -fsSL "${openlistUrl}" -o openlist.tar.gz`, { stdio: 'inherit' });
            execSync(`tar -xzf openlist.tar.gz -C "${BIN_DIR}"`);
            execSync(`chmod +x "${openlistPath}"`);
            fs.unlinkSync('openlist.tar.gz');
        } catch (e) {
            console.error('[Init] openList download failed!', e.message);
            process.exit(1);
        }
    }

    // 3. 下载并部署 Rclone (wiserain mod)
    const rclonePath = path.join(BIN_DIR, 'rclone');
    if (!fs.existsSync(rclonePath)) {
        console.log(`[Init] Downloading Rclone Mod (${arch})...`);
        try {
            const latestUrl = execSync('curl -w "%{url_effective}" -I -L -s -S -o /dev/null https://github.com/wiserain/rclone/releases/latest', { encoding: 'utf8' }).trim();
            const tag = latestUrl.substring(latestUrl.lastIndexOf('/') + 1) || 'v1.66.0-mod1.6.2';
            const zipFile = path.join(ROOT_DIR, 'rclone.zip');
            execSync(`curl -fsSL "https://github.com/wiserain/rclone/releases/download/${tag}/rclone-${tag}-linux-${arch}.zip" -o "${zipFile}"`, { stdio: 'inherit' });
            
            const zip = new AdmZip(zipFile);
            zip.extractAllTo(BIN_DIR, true);
            const extractedDir = fs.readdirSync(BIN_DIR).find(f => f.startsWith('rclone-'));
            if (extractedDir) {
                fs.renameSync(path.join(BIN_DIR, extractedDir, 'rclone'), rclonePath);
                fs.rmSync(path.join(BIN_DIR, extractedDir), { recursive: true, force: true });
            }
            execSync(`chmod +x "${rclonePath}"`);
            fs.unlinkSync(zipFile);
        } catch (e) {
            console.error('[Init] Rclone download failed!', e.message);
            process.exit(1);
        }
    }

    // 4. 解析并建立持久化连接 (配置文件法，最稳妥)
    let SYNC_DEST = null;
    const syncConfPath = path.join(ROOT_DIR, 'sync.conf'); // 使用外部独立配置文件，防止被覆盖
    if (process.env.STORAGE_TYPE === 'webdav') {
        console.log('[Init] Setting up WebDAV via config file...');
        let pass = process.env.WEBDAV_PASS;
        try {
            pass = execFileSync('rclone', ['obscure', process.env.WEBDAV_PASS], { encoding: 'utf-8' }).trim();
        } catch(e) { 
            console.warn('[Init] Obscure failed, using plain password:', e.message); 
        }

        const confContent = `[remote]\ntype = webdav\nurl = ${process.env.WEBDAV_URL}\nvendor = ${process.env.WEBDAV_VENDOR || 'other'}\nuser = ${process.env.WEBDAV_USER}\npass = ${pass}\n`;
        fs.writeFileSync(syncConfPath, confContent);

        console.log('[Init] Attempting to pull data using permanent config file...');
        try {
            SYNC_DEST = `remote:${process.env.WEBDAV_PATH}`; 
            execSync(`rclone copy "${SYNC_DEST}" "${DATA_DIR}" --config "${syncConfPath}" -v`, { stdio: 'inherit' });
            console.log('[Init] Restore successful!');
        } catch (e) {
            console.error('[FATAL ERROR] Restore failed!', e.message);
            process.exit(1); 
        }
    }

    // 5. 初始化 openList 和配置管理员密码
    const openlistConfigDir = path.join(DATA_DIR, 'openlist');

    // 启动时强力清理历史临时文件，释放面板容器的存储空间
    try {
        console.log('[Init] Cleaning up legacy openList temporary files to free up space...');
        const temp1 = path.join(openlistConfigDir, 'temp');
        const temp2 = path.join(openlistConfigDir, 'data', 'temp');
        execSync(`rm -rf "${temp1}" "${temp2}" 2>/dev/null || true`);
        execSync(`mkdir -p "${temp1}" "${temp2}" 2>/dev/null || true`);
    } catch (e) {
        console.warn('[Init] Warning: Failed to clean temp files:', e.message);
    }

    if (!fs.existsSync(path.join(openlistConfigDir, 'config.json'))) {
        console.log('[Init] First run, creating openList configuration...');
        const initopenList = spawn(openlistPath, ['server', '--data', openlistConfigDir]);
        await new Promise(r => setTimeout(r, 3000));
        initopenList.kill();
    }
    if (process.env.OPENLIST_ADMIN_PASSWORD) {
        try { 
            execFileSync(openlistPath, ['admin', 'set', process.env.OPENLIST_ADMIN_PASSWORD, '--data', openlistConfigDir], { stdio: 'ignore' }); 
        } catch (e) {
            console.warn('[Init] Failed to set openList admin password:', e.message);
        }
    }

    // 6. 初始化 Rclone 配置和本地挂载点
    const rcloneConfPath = path.join(DATA_DIR, 'rclone', 'rclone.conf');
    if (!fs.existsSync(rcloneConfPath)) fs.writeFileSync(rcloneConfPath, '');
    
    // 确保不包含末尾斜杠，并优先尝试使用 update
    const OPENLIST_REMOTE_NAME = 'openlist';
    const aUser = process.env.OPENLIST_ADMIN_USERNAME || 'admin';
    const aPass = process.env.OPENLIST_ADMIN_PASSWORD || 'admin';
    let confContent = fs.readFileSync(rcloneConfPath, 'utf8');
    
    if (!confContent.includes(`[${OPENLIST_REMOTE_NAME}]`)) {
        console.log('[Init] Creating built-in openList remote configuration...');
        let obs = aPass;
        try {
            obs = execFileSync('rclone', ['obscure', aPass], { encoding: 'utf-8' }).trim();
        } catch (e) {
            console.warn('[Init] Failed to obscure built-in openList password:', e.message);
        }
        fs.appendFileSync(rcloneConfPath, `\n[${OPENLIST_REMOTE_NAME}]\ntype = webdav\nurl = http://127.0.0.1:5244/dav\nvendor = other\nuser = ${aUser}\npass = ${obs}\n`);
    } else {
        console.log('[Init] Updating built-in openList remote configuration...');
        try {
            await execFilePromise('rclone', ['config', 'update', OPENLIST_REMOTE_NAME, 'url', 'http://127.0.0.1:5244/dav', 'vendor', 'other', 'user', aUser, 'pass', aPass, '--config', rcloneConfPath]);
        } catch (e) {
            console.error('[Init] Failed to update built-in openList remote:', e.message);
        }
    }
    
    // 重新加载配置内容以检查 host
    confContent = fs.readFileSync(rcloneConfPath, 'utf8');
    if (!confContent.includes('[host]')) {
        const hostDir = path.join(ROOT_DIR, 'host');
        if (!fs.existsSync(hostDir)) fs.mkdirSync(hostDir);
        fs.appendFileSync(rcloneConfPath, `\n[host]\ntype = alias\nremote = ${hostDir}\n`);
    }

    // 7. 启动子进程 (openList & Rclone) 并捕获日志
    console.log('[Init] Starting openList & Rclone processes...');
    openlistProcess = spawn(openlistPath, ['server', '--data', openlistConfigDir]);
    openlistProcess.stdout.on('data', d => appendLog('openlist', d));
    openlistProcess.stderr.on('data', d => appendLog('openlist', d));

    rcloneProcess = spawn(rclonePath, ['rcd', '--rc-addr=127.0.0.1:5572', '--rc-no-auth', `--config=${rcloneConfPath}`, `--cache-dir=${path.join(DATA_DIR, 'rclone', 'cache')}`]);
    rcloneProcess.stdout.on('data', d => appendLog('rclone', d));
    rcloneProcess.stderr.on('data', d => appendLog('rclone', d));

    // 8. AutoSync 定时备份逻辑
    // [修复] 将 AutoSync 改为异步机制，防止死锁卡死容器健康检测
    const syncIntervalMin = parseInt(process.env.SYNC_INTERVAL || '5', 10);
    if (SYNC_DEST && syncIntervalMin > 0) {
        console.log(`[AutoSync] Background backup task scheduled every ${syncIntervalMin} minutes.`);
        setInterval(async () => {
            console.log(`[AutoSync] === Pushing updates to remote ===`);
            try {
                // 1. SQLite WAL Checkpoint
                await execPromise(`sqlite3 "${path.join(openlistConfigDir, 'data.db')}" "PRAGMA wal_checkpoint(TRUNCATE);" 2>/dev/null || true`);
                
                // 2. 第一阶段强制覆盖核心文件
                console.log(`[AutoSync] Force pushing critical database and config files...`);
                const safeDest = SYNC_DEST.replace(/\/$/, '');
                const criticalFiles = [
                    { src: path.join(openlistConfigDir, 'data.db'), dst: `${safeDest}/openlist` },
                    { src: path.join(openlistConfigDir, 'config.json'), dst: `${safeDest}/openlist` },
                    { src: path.join(DATA_DIR, 'rclone', 'rclone.conf'), dst: `${safeDest}/rclone` },
                    { src: path.join(DATA_DIR, 'rclone', 'scheduled-tasks.json'), dst: `${safeDest}/rclone` }
                ];

                for (const file of criticalFiles) {
                    if (fs.existsSync(file.src)) {
                        await execPromise(`rclone copy "${file.src}" "${file.dst}" --config "${syncConfPath}" --ignore-times 2>/dev/null || true`);
                    }
                }

                // 3. 第二阶段常规同步
                console.log(`[AutoSync] Syncing other incremental files...`);
                await execPromise(`rclone sync "${DATA_DIR}" "${SYNC_DEST}" --config "${syncConfPath}" --exclude "rclone/cache/**" --exclude "openlist/data/temp/**" --exclude "openlist/temp/**" --exclude "openlist/data/bleve/**" --exclude "openlist/data/log/**" -v`);
                
                console.log(`[AutoSync] Push complete.`);
            } catch (e) { console.error(`[AutoSync] Push failed:`, e.message); }
        }, syncIntervalMin * 60 * 1000);
    }

    // 9. 启动 Express Node 主服务器
    // [修复] 绑定至 HOST 以符合 Databricks 网络规范
    app.listen(PORT, HOST, () => {
        console.log(`[System] Node.js All-in-One Server is listening on ${HOST}:${PORT}`);
        initScheduler();

        // 针对容器极小磁盘优化的自动定时防爆盘清理机制（异步）
        console.log(`[System] Aggressive background temp files cleanup task scheduled.`);
        setInterval(async () => {
            try {
                const temp1 = path.join(openlistConfigDir, 'temp');
                const temp2 = path.join(openlistConfigDir, 'data', 'temp');
                await execPromise(`mkdir -p "${temp1}" "${temp2}" 2>/dev/null || true`);
                // 激进清理：查找并删除超过 10 分钟没有被写入变动的临时文件！
                await execPromise(`find "${temp1}" -type f -mmin +10 -delete 2>/dev/null || true`);
                await execPromise(`find "${temp2}" -type f -mmin +10 -delete 2>/dev/null || true`);
            } catch (e) {
                // 忽略错误，避免崩溃
            }
        }, 3 * 60 * 1000); // 频次拉高：每 3 分钟执行一次！
    });
}

// 引导启动
bootstrap();
````
