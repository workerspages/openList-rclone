/* ========================================
   openList-Rclone Web Console — App Logic
   ======================================== */
const App = {
    token: null,
    currentPage: 'dashboard',
    currentLogService: 'openlist',
    statusInterval: null,
    liveStatusInterval: null,
    remotesList: [],
    editingRemoteName: null,

    // ========================
    // Init
    // ========================
    init() {
        this.token = localStorage.getItem('auth_token');
        if (this.token) {
            this.checkAuth();
        } else {
            this.showLogin();
        }
        this.bindEvents();
    },

    bindEvents() {
        // Login form
        document.getElementById('login-form').addEventListener('submit', (e) => {
            e.preventDefault();
            this.login();
        });

        // Nav items
        document.querySelectorAll('.nav-item').forEach((item) => {
            item.addEventListener('click', () => {
                this.navigate(item.dataset.page);
            });
        });

        // Logout
        document.getElementById('logout-btn').addEventListener('click', () => this.logout());

        // Mobile menu
        document.getElementById('mobile-menu-btn').addEventListener('click', () => {
            document.querySelector('.sidebar').classList.toggle('open');
        });

        // Log tabs
        document.querySelectorAll('.tab[data-service]').forEach((tab) => {
            tab.addEventListener('click', () => {
                document.querySelectorAll('.tab[data-service]').forEach((t) => t.classList.remove('active'));
                tab.classList.add('active');
                this.currentLogService = tab.dataset.service;
                this.loadLogs(tab.dataset.service);
            });
        });

        // Remote type change
        document.getElementById('remote-type').addEventListener('change', (e) => {
            this.renderRemoteParams(e.target.value);
        });

        // Close sidebar on page click (mobile)
        document.querySelector('.main-content').addEventListener('click', () => {
            document.querySelector('.sidebar').classList.remove('open');
        });
    },

    // ========================
    // Auth
    // ========================
    async checkAuth() {
        try {
            const res = await this.api('GET', '/console-api/auth/check');
            if (res.valid) {
                this.showApp(res.username);
            } else {
                this.showLogin();
            }
        } catch {
            this.showLogin();
        }
    },

    async login() {
        const username = document.getElementById('username').value;
        const password = document.getElementById('password').value;
        const errorEl = document.getElementById('login-error');
        const btn = document.getElementById('login-btn');

        btn.disabled = true;
        btn.innerHTML = '<span>登录中...</span>';
        errorEl.style.display = 'none';

        try {
            const res = await fetch('/console-api/login', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ username, password }),
            });
            const data = await res.json();
            if (res.ok && data.token) {
                this.token = data.token;
                localStorage.setItem('auth_token', data.token);
                this.showApp(data.username);
            } else {
                errorEl.textContent = data.error || '登录失败';
                errorEl.style.display = 'block';
            }
        } catch (err) {
            errorEl.textContent = '网络错误，请重试';
            errorEl.style.display = 'block';
        } finally {
            btn.disabled = false;
            btn.innerHTML = '<span>登  录</span>';
        }
    },

    logout() {
        this.token = null;
        localStorage.removeItem('auth_token');
        document.cookie = '_auth_token=; path=/; expires=Thu, 01 Jan 1970 00:00:00 GMT';
        if (this.statusInterval) clearInterval(this.statusInterval);
        if (this.liveStatusInterval) clearInterval(this.liveStatusInterval);
        this.showLogin();
    },

    showLogin() {
        document.getElementById('login-screen').classList.add('active');
        document.getElementById('app-screen').classList.remove('active');
    },

    showApp(username) {
        document.getElementById('login-screen').classList.remove('active');
        document.getElementById('app-screen').classList.add('active');
        document.getElementById('user-badge').textContent = username || 'admin';
        this.loadDashboard();
        this.statusInterval = setInterval(() => this.loadStatus(), 30000);
    },

    // ========================
    // Navigation
    // ========================
    navigate(page) {
        this.currentPage = page;
        // Update nav
        document.querySelectorAll('.nav-item').forEach((item) => {
            item.classList.toggle('active', item.dataset.page === page);
        });
        // Update pages
        document.querySelectorAll('.page').forEach((p) => p.classList.remove('active'));
        document.getElementById('page-' + page)?.classList.add('active');
        // Update title
        const titles = {
            dashboard: '仪表板',
            'rclone-config': 'Rclone 配置管理',
            transfer: '定时任务',
            openlist: 'openList 文件管理',
            'live-status': '实时状态',
            'rclone-gui': 'Rclone Web GUI',
            logs: '日志查看器',
        };
        document.getElementById('page-title').textContent = titles[page] || page;
        
        // Clean up live status interval if leaving page
        if (page !== 'live-status' && this.liveStatusInterval) {
            clearInterval(this.liveStatusInterval);
            this.liveStatusInterval = null;
        }

        // Load page data
        if (page === 'dashboard') this.loadDashboard();
        if (page === 'rclone-config') this.loadRemotes();
        if (page === 'transfer') this.loadTasksPage();
        if (page === 'openlist') this.loadopenListFrame();
        if (page === 'live-status') this.loadLiveStatus();

        if (page === 'logs') this.loadLogs(this.currentLogService);
        // Close mobile sidebar
        document.querySelector('.sidebar').classList.remove('open');
    },

    // ========================
    // API Helper
    // ========================
    async api(method, url, body) {
        const options = {
            method,
            headers: {
                'Content-Type': 'application/json',
                Authorization: 'Bearer ' + this.token,
            },
        };
        if (body) options.body = JSON.stringify(body);
        const res = await fetch(url, options);
        if (res.status === 401) {
            this.logout();
            throw new Error('Unauthorized');
        }
        return res.json();
    },

    // ========================
    // Dashboard
    // ========================
    async loadDashboard() {
        this.loadStatus();
        this.loadRemoteCount();
    },

    async loadStatus() {
        try {
            const data = await this.api('GET', '/console-api/status');
            // openList status
            const openlistStatus = document.querySelector('#stat-openlist .stat-status');
            openlistStatus.textContent = data.openlist === 'running' ? '运行中' : '已停止';
            openlistStatus.className = 'stat-status ' + (data.openlist === 'running' ? 'running' : 'stopped');
            // Rclone status
            const rcloneStatus = document.querySelector('#stat-rclone .stat-status');
            rcloneStatus.textContent = data.rclone === 'running' ? '运行中' : '已停止';
            rcloneStatus.className = 'stat-status ' + (data.rclone === 'running' ? 'running' : 'stopped');
            // Uptime
            document.getElementById('stat-uptime').textContent = this.formatUptime(data.uptime);
        } catch {
            // Silently fail
        }
    },

    async loadRemoteCount() {
        try {
            const data = await this.api('GET', '/console-api/rclone/remotes');
            document.getElementById('stat-remotes').textContent = (data.remotes?.length || 0) + ' 个';
        } catch {
            document.getElementById('stat-remotes').textContent = '-';
        }
    },

    formatUptime(seconds) {
        if (!seconds) return '-';
        const d = Math.floor(seconds / 86400);
        const h = Math.floor((seconds % 86400) / 3600);
        const m = Math.floor((seconds % 3600) / 60);
        if (d > 0) return `${d}天 ${h}时 ${m}分`;
        if (h > 0) return `${h}时 ${m}分`;
        return `${m}分`;
    },

    // ========================
    // Rclone Remotes
    // ========================
    async loadRemotes() {
        const container = document.getElementById('remotes-list');
        container.innerHTML = '<div class="loading-state"><div class="spinner"></div><p>加载中...</p></div>';
        try {
            const data = await this.api('GET', '/console-api/rclone/remotes');
            this.remotesList = data.remotes || [];
            if (!this.remotesList || this.remotesList.length === 0) {
                container.innerHTML = `
                    <div class="empty-state">
                        <svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">
                            <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/>
                        </svg>
                        <p>暂无远程存储配置</p>
                        <button class="btn btn-primary" onclick="App.showAddRemoteModal()">添加远程存储</button>
                    </div>`;
                return;
            }
            container.innerHTML = this.remotesList
                .map((r) => {
                    const params = Object.entries(r)
                        .filter(([k]) => k !== 'name' && k !== 'type')
                        .map(
                            ([k, v]) =>
                                `<div class="param-row"><span class="param-key">${this.escapeHtml(k)}</span><span class="param-value" title="${this.escapeHtml(String(v))}">${this.escapeHtml(this.maskSensitive(k, String(v)))}</span></div>`
                        )
                        .join('');
                    return `
                    <div class="remote-card">
                        <div class="remote-card-header">
                            <h4>${this.escapeHtml(r.name)} <span class="remote-type-badge">${this.escapeHtml(r.type || 'unknown')}</span></h4>
                            <div class="remote-card-actions">
                                <button class="btn-icon" onclick="App.testRemote('${this.escapeJsArgs(r.name)}')" title="测试连接">
                                    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="22 12 18 12 15 21 9 3 6 12 2 12"></polyline></svg>
                                </button>
                                <button class="btn-icon" onclick="App.openFileManager('${this.escapeJsArgs(r.name)}')" title="浏览文件">
                                    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/></svg>
                                </button>
                                <button class="btn-icon" onclick="App.editRemote('${this.escapeJsArgs(r.name)}')" title="编辑">
                                    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"></path><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"></path></svg>
                                </button>
                                <button class="btn-icon" onclick="App.deleteRemote('${this.escapeJsArgs(r.name)}')" title="删除">
                                    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg>
                                </button>
                            </div>
                        </div>
                        <div class="remote-card-body">${params || '<span style="color:var(--text-muted)">无额外参数</span>'}</div>
                    </div>`;
                })
                .join('');
        } catch (err) {
            container.innerHTML = `<div class="empty-state"><p>加载失败: ${this.escapeHtml(err.message)}</p></div>`;
        }
    },

    async testRemote(name) {
        try {
            this.toast(`正在测试连接 "${name}"...`, 'info');
            const data = await this.api('POST', '/console-api/rclone/test', { remote: name });
            if (data.ok) {
                this.toast(data.message, 'success');
            } else {
                this.toast(data.message, 'error');
            }
        } catch (err) {
            this.toast('测试请求失败: ' + err.message, 'error');
        }
    },

    maskSensitive(key, value) {
        const sensitiveKeys = ['password', 'secret', 'token', 'key', 'pass'];
        if (sensitiveKeys.some((k) => key.toLowerCase().includes(k)) && value.length > 4) {
            return value.substring(0, 2) + '***' + value.substring(value.length - 2);
        }
        return value;
    },

    // ========================
    // Remote Modal
    // ========================
    providersList: null,

    async showAddRemoteModal() {
        this.editingRemoteName = null;
        document.getElementById('modal-title').textContent = '添加远程存储';
        const nameInput = document.getElementById('remote-name');
        nameInput.value = '';
        nameInput.disabled = false;
        
        const typeSelect = document.getElementById('remote-type');
        typeSelect.disabled = false;

        document.getElementById('remote-params').innerHTML = '';
        document.getElementById('modal-overlay').classList.add('active');
        // Load providers if not cached
        if (!this.providersList || this.providersList.length === 0) {
            typeSelect.innerHTML = '<option value="">-- 加载中... --</option>';
            try {
                const data = await this.api('GET', '/console-api/rclone/providers');
                this.providersList = (data.providers || []).sort((a, b) => (a.name || '').localeCompare(b.name || ''));
                if (this.providersList.length === 0) {
                    this.toast('未获取到存储类型，Rclone 可能未就绪', 'error');
                }
            } catch (err) {
                this.providersList = null;
                this.toast('加载存储类型失败: ' + (err.message || err), 'error');
                typeSelect.innerHTML = '<option value="">-- 加载失败，请重试 --</option>';
                return;
            }
        }
        typeSelect.innerHTML = '<option value="">-- 选择类型 (' + this.providersList.length + ' 种) --</option>' +
            this.providersList.map(p => `<option value="${this.escapeHtml(p.prefix || p.name)}">${this.escapeHtml(p.prefix || p.name)} — ${this.escapeHtml(p.description || '')}</option>`).join('');
        typeSelect.value = '';
    },

    async editRemote(name) {
        const remote = (this.remotesList || []).find(r => r.name === name);
        if (!remote) {
            this.toast('找不到该配置', 'error');
            return;
        }

        this.editingRemoteName = name;
        document.getElementById('modal-title').textContent = '修改远程存储';
        
        const nameInput = document.getElementById('remote-name');
        nameInput.value = remote.name;
        nameInput.disabled = true;

        const typeSelect = document.getElementById('remote-type');
        typeSelect.disabled = true;
        
        document.getElementById('modal-overlay').classList.add('active');

        if (!this.providersList || this.providersList.length === 0) {
            typeSelect.innerHTML = '<option value="">-- 加载中... --</option>';
            try {
                const data = await this.api('GET', '/console-api/rclone/providers');
                this.providersList = (data.providers || []).sort((a, b) => (a.name || '').localeCompare(b.name || ''));
            } catch (err) {
                this.toast('加载存储类型失败', 'error');
                return;
            }
        }
        
        typeSelect.innerHTML = '<option value="">-- 选择类型 (' + this.providersList.length + ' 种) --</option>' +
            this.providersList.map(p => `<option value="${this.escapeHtml(p.prefix || p.name)}">${this.escapeHtml(p.prefix || p.name)} — ${this.escapeHtml(p.description || '')}</option>`).join('');
            
        typeSelect.value = remote.type;

        this.renderRemoteParams(remote.type);
        
        // Fill params asynchronously right after rendering logic
        setTimeout(() => {
            const params = Object.entries(remote).filter(([k]) => k !== 'name' && k !== 'type');
            params.forEach(([k, v]) => {
                const el = document.querySelector(`#remote-params [data-param="${k}"]`);
                if (el) {
                    el.value = v;
                } else if (remote.type) {
                    // It's a generic param row
                    const genericRows = document.getElementById('generic-param-rows');
                    if (genericRows) {
                        const row = document.createElement('div');
                        row.className = 'param-input-row';
                        row.innerHTML = `
                            <input type="text" data-param-key value="${this.escapeHtml(k)}" placeholder="参数名" class="param-key-input">
                            <input type="text" data-param-val value="${this.escapeHtml(v)}" placeholder="参数值" class="param-val-input">
                            <button type="button" class="btn-icon" onclick="this.closest('.param-input-row').remove()" title="删除">✕</button>`;
                        genericRows.appendChild(row);
                    }
                }
            });
            // remove empty first row if generic
            const genericRowsContainer = document.getElementById('generic-param-rows');
            if (genericRowsContainer) {
                const rows = genericRowsContainer.querySelectorAll('.param-input-row');
                if (rows.length > 1 && !rows[0].querySelector('[data-param-key]').value) {
                    rows[0].remove();
                }
            }
        }, 10);
    },

    closeModal() {
        document.getElementById('modal-overlay').classList.remove('active');
    },

    renderRemoteParams(type) {
        const container = document.getElementById('remote-params');
        const params = this.getParamsForType(type);
        if (params.length) {
            container.innerHTML = params
                .map(
                    (p) => `
            <div class="form-group">
                <label for="param-${p.name}">${this.escapeHtml(p.label)}</label>
                ${p.type === 'select'
                            ? `<select id="param-${p.name}" data-param="${p.name}">
                        ${p.options.map((o) => `<option value="${o.value}">${o.label}</option>`).join('')}
                    </select>`
                            : p.type === 'textarea'
                                ? `<textarea id="param-${p.name}" data-param="${p.name}" placeholder="${this.escapeHtml(p.placeholder || '')}"></textarea>`
                                : `<input type="${p.sensitive ? 'password' : 'text'}" id="param-${p.name}" data-param="${p.name}" placeholder="${this.escapeHtml(p.placeholder || '')}">`
                        }
            </div>`
                )
                .join('');
        } else if (type) {
            // Generic key-value params for types without presets
            container.innerHTML = `
                <div class="generic-params">
                    <div class="generic-params-note">
                        <small>💡 输入该存储类型所需的参数（键值对），参考 <a href="https://rclone.org/overview/" target="_blank" style="color:var(--accent-hover)">Rclone 文档</a></small>
                    </div>
                    <div id="generic-param-rows">
                        <div class="param-input-row">
                            <input type="text" data-param-key placeholder="参数名" class="param-key-input">
                            <input type="text" data-param-val placeholder="参数值" class="param-val-input">
                            <button type="button" class="btn-icon" onclick="this.closest('.param-input-row').remove()" title="删除">✕</button>
                        </div>
                    </div>
                    <button type="button" class="btn btn-secondary btn-sm" onclick="App.addGenericParam()" style="margin-top:8px">+ 添加参数</button>
                </div>`;
        } else {
            container.innerHTML = '';
        }
    },

    addGenericParam() {
        const row = document.createElement('div');
        row.className = 'param-input-row';
        row.innerHTML = `
            <input type="text" data-param-key placeholder="参数名" class="param-key-input">
            <input type="text" data-param-val placeholder="参数值" class="param-val-input">
            <button type="button" class="btn-icon" onclick="this.closest('.param-input-row').remove()" title="删除">✕</button>`;
        document.getElementById('generic-param-rows').appendChild(row);
    },

    getParamsForType(type) {
        const common = {
            s3: [
                {
                    name: 'provider', label: 'S3 提供商', type: 'select', options: [
                        { value: 'AWS', label: 'Amazon AWS' },
                        { value: 'Cloudflare', label: 'Cloudflare R2' },
                        { value: 'DigitalOcean', label: 'DigitalOcean Spaces' },
                        { value: 'Alibaba', label: '阿里云 OSS' },
                        { value: 'Tencent', label: '腾讯云 COS' },
                        { value: 'HuaweiOBS', label: '华为云 OBS' },
                        { value: 'Minio', label: 'MinIO' },
                        { value: 'Other', label: '其他' },
                    ]
                },
                { name: 'access_key_id', label: 'Access Key ID', placeholder: 'AKIAIOSFODNN7EXAMPLE' },
                { name: 'secret_access_key', label: 'Secret Access Key', placeholder: '密钥', sensitive: true },
                { name: 'region', label: '区域 (Region)', placeholder: 'us-east-1' },
                { name: 'endpoint', label: '服务地址 (Endpoint)', placeholder: '例如: https://s3.example.com (留空使用默认)' },
                { name: 'force_path_style', label: '强制路径样式', type: 'select', options: [{value: '', label: '默认'}, {value: 'true', label: '是 (True)'}, {value: 'false', label: '否 (False)'}] },
            ],
            drive: [
                { name: 'client_id', label: 'Client ID', placeholder: '留空使用内置' },
                { name: 'client_secret', label: 'Client Secret', placeholder: '留空使用内置', sensitive: true },
                { name: 'token', label: '刷新令牌 (Refresh Token)', type: 'textarea', placeholder: '{"access_token":"...","token_type":"Bearer",...}' },
                { name: 'root_folder_id', label: '根目录 ID', placeholder: '留空为根目录' },
                { name: 'team_drive', label: '团队盘 ID (Team Drive)', placeholder: '留空为个人盘' },
                { name: 'service_account_file', label: 'SA 文件路径', placeholder: '/data/sa.json' },
            ],
            onedrive: [
                { name: 'client_id', label: 'Client ID', placeholder: '' },
                { name: 'client_secret', label: 'Client Secret', placeholder: '', sensitive: true },
                { name: 'token', label: 'Token (JSON)', type: 'textarea', placeholder: '{"access_token":"...","token_type":"Bearer",...}' },
                { name: 'drive_id', label: '驱动器 ID (Drive ID)', placeholder: '留空使用默认' },
                { name: 'drive_type', label: '驱动器类型 (Drive Type)', type: 'select', options: [{value: '', label: '自动'}, {value: 'personal', label: '个人 (Personal)'}, {value: 'business', label: '商业版 (Business)'}, {value: 'documentLibrary', label: 'SharePoint'}] },
            ],
            webdav: [
                { name: 'url', label: '服务器 URL', placeholder: 'https://example.com/remote.php/dav/files/user/' },
                { name: 'user', label: '用户名', placeholder: '' },
                { name: 'pass', label: '密码', placeholder: '', sensitive: true },
                {
                    name: 'vendor', label: '供应商', type: 'select', options: [
                        { value: 'rclone', label: 'rclone WebDAV' },
                        { value: 'fastmail', label: 'Fastmail Files' },
                        { value: 'nextcloud', label: 'Nextcloud' },
                        { value: 'owncloud', label: 'ownCloud' },
                        { value: 'infinitescale', label: 'ownCloud Infinite Scale' },
                        { value: 'sharepoint', label: 'SharePoint Online' },
                        { value: 'sharepoint-ntlm', label: 'SharePoint NTLM' },
                        { value: 'other', label: '其他' },
                    ]
                },
            ],
            sftp: [
                { name: 'host', label: '主机地址', placeholder: 'example.com' },
                { name: 'port', label: '端口', placeholder: '22' },
                { name: 'user', label: '用户名', placeholder: 'root' },
                { name: 'pass', label: '密码', placeholder: '', sensitive: true },
                { name: 'key_file', label: '密钥文件路径', placeholder: '/data/id_rsa' },
            ],
            ftp: [
                { name: 'host', label: '主机地址', placeholder: 'ftp.example.com' },
                { name: 'port', label: '端口', placeholder: '21' },
                { name: 'user', label: '用户名', placeholder: '' },
                { name: 'pass', label: '密码', placeholder: '', sensitive: true },
            ],
            dropbox: [
                { name: 'client_id', label: 'Client ID', placeholder: '' },
                { name: 'client_secret', label: 'Client Secret', placeholder: '', sensitive: true },
                { name: 'token', label: 'Token (JSON)', type: 'textarea', placeholder: '' },
            ],
            b2: [
                { name: 'account', label: 'Account ID', placeholder: '' },
                { name: 'key', label: 'Application Key', placeholder: '', sensitive: true },
            ],
            azureblob: [
                { name: 'account', label: 'Storage Account Name', placeholder: '' },
                { name: 'key', label: 'Storage Account Key', placeholder: '', sensitive: true },
                { name: 'sas_url', label: 'SAS URL', placeholder: '可选' },
            ],
            mega: [
                { name: 'user', label: '邮箱', placeholder: '' },
                { name: 'pass', label: '密码', placeholder: '', sensitive: true },
            ],
            pcloud: [
                { name: 'username', label: '用户名 (邮箱)', placeholder: '' },
                { name: 'password', label: '密码', placeholder: '', sensitive: true },
                { name: 'hostname', label: '服务器 API', type: 'select', options: [{value: '', label: '默认'}, {value: 'api.pcloud.com', label: 'Global'}, {value: 'eapi.pcloud.com', label: 'Europe'}] },
                { name: 'token', label: 'Token (JSON)', type: 'textarea', placeholder: '如果有 Token 则无需填写账密' },
            ],
            smb: [
                { name: 'host', label: '主机地址', placeholder: '192.168.1.100' },
                { name: 'port', label: '端口', placeholder: '445' },
                { name: 'user', label: '用户名', placeholder: '' },
                { name: 'pass', label: '密码', placeholder: '', sensitive: true },
                { name: 'domain', label: '域', placeholder: 'WORKGROUP' },
            ],
            local: [
                { name: 'root', label: '根路径', placeholder: '/data/local' },
            ],
        };
        return common[type] || [];
    },

    async saveRemote() {
        const name = document.getElementById('remote-name').value.trim();
        const type = document.getElementById('remote-type').value;
        if (!name || (!type && !this.editingRemoteName)) { // Type might be disabled but readable. However just in case.
            this.toast('请填写名称和类型', 'error');
            return;
        }
        const parameters = {};
        // Collect preset params
        document.querySelectorAll('#remote-params [data-param]').forEach((el) => {
            const val = el.value.trim();
            if (val) parameters[el.dataset.param] = val;
        });
        // Collect generic key-value params
        document.querySelectorAll('#remote-params .param-input-row').forEach((row) => {
            const key = row.querySelector('[data-param-key]')?.value.trim();
            const val = row.querySelector('[data-param-val]')?.value.trim();
            if (key && val) parameters[key] = val;
        });
        try {
            if (this.editingRemoteName) {
                await this.api('PUT', '/console-api/rclone/remote/' + encodeURIComponent(this.editingRemoteName), { parameters });
                this.toast(`远程存储 "${this.editingRemoteName}" 更新成功`, 'success');
            } else {
                await this.api('POST', '/console-api/rclone/remote', { name, type, parameters });
                this.toast(`远程存储 "${name}" 创建成功`, 'success');
            }
            this.closeModal();
            this.loadRemotes();
            this.loadRemoteCount();
        } catch (err) {
            this.toast((this.editingRemoteName ? '更新' : '创建') + '失败: ' + err.message, 'error');
        }
    },

    async deleteRemote(name) {
        if (!confirm(`确定删除远程存储 "${name}" 吗？`)) return;
        try {
            await this.api('DELETE', '/console-api/rclone/remote/' + encodeURIComponent(name));
            this.toast(`远程存储 "${name}" 已删除`, 'success');
            this.loadRemotes();
            this.loadRemoteCount();
        } catch (err) {
            this.toast('删除失败: ' + err.message, 'error');
        }
    },

    // ========================
    // Service Management
    // ========================
    async restartService(service) {
        try {
            this.toast(`正在重启 ${service}...`, 'info');
            await this.api('POST', '/console-api/service/restart', { service });
            this.toast(`${service} 已重启`, 'success');
            setTimeout(() => this.loadStatus(), 2000);
        } catch (err) {
            this.toast('重启失败: ' + err.message, 'error');
        }
    },

    // ========================
    // Iframe Pages
    // ========================
    loadopenListFrame() {
        const frame = document.getElementById('openlist-frame');
        if (!frame.src || frame.src === window.location.href) {
            frame.src = '/';
        }
    },



    // ========================
    // Live Status Viewer
    // ========================
    loadLiveStatus() {
        if (this.liveStatusInterval) clearInterval(this.liveStatusInterval);
        this.refreshLiveStatus();
        this.liveStatusInterval = setInterval(() => this.refreshLiveStatus(), 1000);
    },

    async refreshLiveStatus() {
        const viewer = document.getElementById('live-terminal');
        const indicator = document.getElementById('live-indicator');
        
        try {
            // Fetch stats and last 30 lines of logs simultaneously
            const [statsRes, logsRes] = await Promise.all([
                this.api('GET', '/console-api/rclone/stats').catch(() => null),
                this.api('GET', '/console-api/logs/rclone?lines=30').catch(() => null)
            ]);
            
            indicator.textContent = '● 连接中';
            indicator.className = 'live-indicator';
            
            let output = '';
            
            // Format logs (top part)
            if (logsRes && logsRes.log) {
                const logLines = logsRes.log.split('\n').filter(l => l.trim().length > 0);
                
                output += logLines.map(line => {
                    // Simple coloring based on log level keywords
                    let lineClass = 'term-color-gray';
                    if (line.includes('ERROR :')) lineClass = 'term-color-red';
                    else if (line.includes('INFO  :')) lineClass = 'term-color-blue';
                    else if (line.includes('NOTICE:')) lineClass = 'term-color-yellow';
                    return `<span class="${lineClass}">${this.escapeHtml(line)}</span>`;
                }).join('\n');
                
                output += '\n\n';
            }
            
            // Format stats (bottom part)
            if (statsRes && !statsRes.error) {
                const s = statsRes;
                
                const formatBytes = (bytes) => {
                    if (bytes === 0) return '0 B';
                    const k = 1024;
                    const sizes = ['B', 'KiB', 'MiB', 'GiB', 'TiB'];
                    const i = Math.floor(Math.log(bytes) / Math.log(k));
                    return parseFloat((bytes / Math.pow(k, i)).toFixed(3)) + ' ' + sizes[i];
                };
                
                const formatTime = (seconds) => {
                    if (!seconds || seconds <= 0) return '0s';
                    const d = Math.floor(seconds / 86400);
                    const h = Math.floor((seconds % 86400) / 3600);
                    const m = Math.floor((seconds % 3600) / 60);
                    const sPart = Math.floor(seconds % 60);
                    let res = '';
                    if(d>0) res += d + 'w'; // Wait, in rclone d is w? Usually d=days, w=weeks. Let's stick to standard: d, h, m, s
                    if(d>0) res += d + 'd'; 
                    if(h>0) res += h + 'h';
                    if(m>0) res += m + 'm';
                    res += sPart + 's';
                    return res;
                };

                const bytesText = `<span class="term-color-green">${formatBytes(s.bytes)}</span> / <span class="term-color-green">${formatBytes(s.totalBytes)}</span>`;
                const percentText = s.totalBytes > 0 ? ((s.bytes / s.totalBytes) * 100).toFixed(0) + '%' : '0%';
                const speedText = `<span class="term-color-green">${formatBytes(s.speed)}/s</span>`;
                const etaText = s.eta ? `ETA ${formatTime(s.eta)}` : 'ETA -';
                
                output += `Transferred:   	${bytesText}, ${percentText}, ${speedText}, ${etaText}\n`;
                output += `Errors:        	${s.errors}\n`;
                output += `Checks:        	${s.checks} / ${s.checks}, 100%\n`;
                output += `Transferred:   	${s.transfers} / ${s.transfers}, 100%\n`;
                output += `Elapsed time:  	${formatTime(s.elapsedTime)}\n`;
                
                if (s.transferring && s.transferring.length > 0) {
                    output += `Transferring:\n`;
                    s.transferring.forEach(t => {
                        const name = t.name || '';
                        const p = t.percentage || 0;
                        const sz = formatBytes(t.size);
                        const spd = formatBytes(t.speed) + '/s';
                        const tet = formatTime(t.eta);
                        output += ` * ${this.escapeHtml(name)}: ${p}% /${sz}, ${spd}, ${tet}\n`;
                    });
                }
            } else {
                output += `\n<span class="term-color-red">获取状态失败，验证 Rclone 是否在运行</span>`;
            }
            
            // Keep viewer scrolled to bottom
            const isScrolledToBottom = viewer.scrollHeight - viewer.clientHeight <= viewer.scrollTop + 50;
            
            viewer.innerHTML = output || '暂无数据';
            
            if (isScrolledToBottom) {
                viewer.scrollTop = viewer.scrollHeight;
            }
            
        } catch (err) {
            indicator.textContent = '● 离线';
            indicator.className = 'live-indicator offline';
            viewer.innerHTML = '<span class="term-color-red">连接 Rclone API 失败</span>\n' + err.message;
        }
    },
    async loadLogs(service) {
        const viewer = document.getElementById('log-viewer');
        viewer.textContent = '加载中...';
        try {
            const data = await this.api('GET', `/console-api/logs/${service}?lines=200`);
            viewer.textContent = data.log || '无日志';
        } catch {
            viewer.textContent = '加载日志失败';
        }
    },

    refreshLogs() {
        this.loadLogs(this.currentLogService);
    },

    // ========================
    // Utilities
    // ========================
    toast(message, type = 'info') {
        const container = document.getElementById('toast-container');
        const toast = document.createElement('div');
        toast.className = `toast ${type}`;
        toast.textContent = message;
        container.appendChild(toast);
        setTimeout(() => {
            toast.style.opacity = '0';
            toast.style.transform = 'translateX(20px)';
            toast.style.transition = '0.3s ease';
            setTimeout(() => toast.remove(), 300);
        }, 3000);
    },

    escapeHtml(str) {
        const map = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
        return String(str).replace(/[&<>"']/g, (c) => map[c]);
    },

    escapeJsArgs(str) {
        return this.escapeHtml(String(str).replace(/\\/g, '\\\\').replace(/'/g, "\\'").replace(/"/g, '\\"'));
    },

    parseRcloneArgs(argStr) {
        if (!argStr) return {};
        const config = {};
        const filter = {};
        const order = []; // Track original parameter order
        const filterFlags = ['max-size', 'min-size', 'max-age', 'min-age', 'include', 'exclude', 'filter'];
        
        const matches = argStr.match(/(?:[^\s"]+|"[^"]*")+/g) || [];
        
        for (let i = 0; i < matches.length; i++) {
            let token = matches[i];
            if (token.startsWith('--')) {
                let flag = token.substring(2);
                let value = true;
                
                if (flag.includes('=')) {
                    const parts = flag.split('=');
                    flag = parts[0];
                    value = parts.slice(1).join('=').replace(/^"|"$/g, '');
                } else if (i + 1 < matches.length && !matches[i+1].startsWith('-')) {
                    value = matches[++i].replace(/^"|"$/g, '');
                }
                
                if (typeof value === 'string' && /^\d+(\.\d+)?$/.test(value)) {
                    if (['transfers', 'checkers', 'retries', 'low-level-retries', 'max-depth', 'max-backlog', 'tpslimit', 'tpslimit-burst', 'stats-interval', 'buffer-size', 'multi-thread-streams', 'multi-thread-cutoff', 'chunk-size', 'drive-chunk-size', 'vfs-read-chunk-size'].includes(flag)) {
                        value = parseInt(value, 10);
                    }
                }
                
                const pascalKey = flag.split('-').map(s => s.charAt(0).toUpperCase() + s.slice(1)).join('');
                
                if (filterFlags.includes(flag)) {
                    if (['include', 'exclude', 'filter'].includes(flag)) {
                        const ruleKey = pascalKey + 'Rule';
                        if (!filter[ruleKey]) filter[ruleKey] = [];
                        filter[ruleKey].push(value);
                        // Record order entry with index for array-type filter rules
                        order.push({ section: 'filter', key: ruleKey, index: filter[ruleKey].length - 1 });
                    } else {
                        filter[pascalKey] = value;
                        order.push({ section: 'filter', key: pascalKey });
                    }
                } else {
                    config[pascalKey] = value;
                    order.push({ section: 'config', key: pascalKey });
                }
            }
        }
        
        const res = {};
        if (Object.keys(config).length) res._config = config;
        if (Object.keys(filter).length) res._filter = filter;
        if (order.length) res._order = order;
        return res;
    },

    stringifyRcloneArgs(advancedOptions) {
        if (!advancedOptions) return '';
        const args = [];
        const toKebab = (str) => str.replace(/[A-Z]/g, letter => `-${letter.toLowerCase()}`).replace(/^-/, '');
        
        const cfg = advancedOptions._config || {};
        const flt = advancedOptions._filter || {};
        const order = advancedOptions._order;
        
        const formatValue = (flag, v) => {
            if (v === true) return flag;
            const valStr = String(v).includes(' ') ? `"${v}"` : String(v);
            return `${flag} ${valStr}`;
        };
        
        // If _order exists, output parameters in recorded order
        if (order && Array.isArray(order) && order.length > 0) {
            for (const entry of order) {
                if (entry.section === 'config') {
                    const v = cfg[entry.key];
                    if (v !== undefined) {
                        args.push(formatValue('--' + toKebab(entry.key), v));
                    }
                } else if (entry.section === 'filter') {
                    const v = flt[entry.key];
                    if (v === undefined) continue;
                    if (entry.key.endsWith('Rule') && Array.isArray(v)) {
                        const flagName = toKebab(entry.key.replace('Rule', ''));
                        const idx = entry.index !== undefined ? entry.index : 0;
                        if (idx < v.length) {
                            const valStr = v[idx].includes(' ') ? `"${v[idx]}"` : v[idx];
                            args.push(`--${flagName} ${valStr}`);
                        }
                    } else {
                        args.push(formatValue('--' + toKebab(entry.key), v));
                    }
                }
            }
            return args.join(' ');
        }
        
        // Fallback: no _order present (legacy data), output config first then filter
        for (const [k, v] of Object.entries(cfg)) {
            args.push(formatValue('--' + toKebab(k), v));
        }
        
        for (const [k, v] of Object.entries(flt)) {
            if (k.endsWith('Rule') && Array.isArray(v)) {
                const flagName = toKebab(k.replace('Rule', ''));
                v.forEach(rule => {
                    const valStr = rule.includes(' ') ? `"${rule}"` : rule;
                    args.push(`--${flagName} ${valStr}`);
                });
            } else {
                args.push(formatValue('--' + toKebab(k), v));
            }
        }
        
        return args.join(' ');
    },

    // ========================
    // Scheduled Tasks
    // ========================
    browseTarget: null,
    browsePath: '/',
    browseRemoteName: '',
    taskRemotesCache: null,

    async loadTasksPage() {
        const container = document.getElementById('tasks-list');
        container.innerHTML = '<div class="loading-state"><div class="spinner"></div><p>加载中...</p></div>';
        try {
            const data = await this.api('GET', '/console-api/tasks');
            const tasks = data.tasks || [];
            if (tasks.length === 0) {
                container.innerHTML = `<div class="empty-state">
                    <svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg>
                    <p>暂无定时任务</p>
                    <button class="btn btn-primary" onclick="App.showTaskModal()">创建第一个任务</button>
                </div>`;
                return;
            }
            container.innerHTML = tasks.map(t => this.renderTaskCard(t)).join('');
        } catch (err) {
            container.innerHTML = `<div class="empty-state"><p>加载失败: ${this.escapeHtml(err.message)}</p></div>`;
        }
    },

    renderTaskCard(t) {
        const modeNames = { copy: '复制', sync: '同步', move: '移动' };
        const modeName = modeNames[t.mode] || t.mode;
        const statusIcon = t.lastStatus === 'success' ? '✅' : t.lastStatus === 'error' ? '❌' : '⏳';
        const lastRunText = t.lastRun ? this.formatTime(t.lastRun) : '从未执行';
        const cronText = t.cron || '仅手动';
        const enabledClass = t.enabled ? 'enabled' : 'disabled';
        return `<div class="task-card ${enabledClass}">
            <div class="task-card-header">
                <div class="task-card-title">
                    <h4>${this.escapeHtml(t.name)}</h4>
                    <span class="task-mode-badge mode-${t.mode}">${modeName}</span>
                </div>
                <div class="task-card-toggle">
                    <label class="toggle-switch" title="${t.enabled ? '已启用' : '已禁用'}">
                        <input type="checkbox" ${t.enabled ? 'checked' : ''} onchange="App.toggleTask('${t.id}')">
                        <span class="toggle-slider"></span>
                    </label>
                </div>
            </div>
            <div class="task-card-body">
                <div class="task-route">
                    <span class="task-endpoint"><b>${this.escapeHtml(t.srcRemote)}</b>:${this.escapeHtml(t.srcPath || '/')}</span>
                    <span class="task-arrow">→</span>
                    <span class="task-endpoint"><b>${this.escapeHtml(t.dstRemote)}</b>:${this.escapeHtml(t.dstPath || '/')}</span>
                </div>
                <div class="task-meta">
                    <span class="task-cron" title="Cron 表达式">⏰ ${this.escapeHtml(cronText)}</span>
                    <span class="task-last-run">${statusIcon} ${lastRunText}</span>
                </div>
            </div>
            <div class="task-card-actions">
                <button class="btn btn-primary btn-sm" onclick="App.runTask('${t.id}')" title="立即执行">▶ 执行</button>
                <button class="btn btn-warning btn-sm" onclick="App.stopTask('${t.id}')" title="停止任务">⏹ 停止</button>
                <button class="btn btn-secondary btn-sm" onclick="App.showTaskModal('${t.id}')" title="编辑">✏️ 编辑</button>
                <button class="btn btn-secondary btn-sm" onclick="App.viewTaskHistory('${t.id}')" title="历史">
                    📋 历史${t.historyCount > 0 ? ' (' + t.historyCount + ')' : ''}
                </button>
                <button class="btn btn-danger btn-sm" onclick="App.deleteTask('${t.id}')" title="删除">🗑️</button>
            </div>
        </div>`;
    },

    formatTime(isoStr) {
        try {
            const d = new Date(isoStr);
            return d.toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' });
        } catch { return isoStr; }
    },

    async loadTaskRemotes() {
        if (this.taskRemotesCache) return this.taskRemotesCache;
        try {
            const data = await this.api('GET', '/console-api/rclone/remotes');
            this.taskRemotesCache = data.remotes || [];
            return this.taskRemotesCache;
        } catch { return []; }
    },

    async showTaskModal(editId) {
        const remotes = await this.loadTaskRemotes();
        const options = '<option value="">-- 选择远程存储 --</option>' +
            remotes.map(r => `<option value="${this.escapeHtml(r.name)}">${this.escapeHtml(r.name)} (${this.escapeHtml(r.type || '')})</option>`).join('');
        document.getElementById('task-src-remote').innerHTML = options;
        document.getElementById('task-dst-remote').innerHTML = options;

        // Reset form
        document.getElementById('task-name').value = '';
        document.getElementById('task-src-path').value = '/';
        document.getElementById('task-dst-path').value = '/';
        document.getElementById('task-mode').value = 'copy';
        document.getElementById('task-cron').value = '';
        document.getElementById('task-cron-preset').value = '';
        document.getElementById('task-edit-id').value = '';
        // Reset advanced
        document.getElementById('task-opt-custom').value = '';
        // Reset notification toggle
        document.getElementById('task-notify-policy').value = 'always';

        if (editId) {
            document.getElementById('task-modal-title').textContent = '编辑任务';
            document.getElementById('task-edit-id').value = editId;
            try {
                const data = await this.api('GET', '/console-api/tasks');
                const task = (data.tasks || []).find(t => t.id === editId);
                if (task) {
                    document.getElementById('task-name').value = task.name || '';
                    document.getElementById('task-src-remote').value = task.srcRemote || '';
                    document.getElementById('task-src-path').value = task.srcPath || '/';
                    document.getElementById('task-dst-remote').value = task.dstRemote || '';
                    document.getElementById('task-dst-path').value = task.dstPath || '/';
                    document.getElementById('task-mode').value = task.mode || 'copy';
                    document.getElementById('task-cron').value = task.cron || '';
                    // Set preset if matches
                    const presetSelect = document.getElementById('task-cron-preset');
                    const presetOpts = Array.from(presetSelect.options).map(o => o.value);
                    presetSelect.value = presetOpts.includes(task.cron) ? task.cron : '';
                    // Advanced options
                    if (task.advancedOptions) {
                        document.getElementById('task-opt-custom').value = App.stringifyRcloneArgs(task.advancedOptions);
                    }
                    // Notification toggle
                    const policy = task.notifyPolicy || (task.notifyOnComplete !== false ? 'always' : 'none');
                    document.getElementById('task-notify-policy').value = policy;
                }
            } catch (err) {
                this.toast('加载任务详情失败', 'error');
            }
        } else {
            document.getElementById('task-modal-title').textContent = '添加任务';
        }
        document.getElementById('task-modal').classList.add('active');
    },

    closeTaskModal() {
        document.getElementById('task-modal').classList.remove('active');
    },

    onCronPresetChange() {
        const val = document.getElementById('task-cron-preset').value;
        if (val) document.getElementById('task-cron').value = val;
    },

    async saveTask() {
        const name = document.getElementById('task-name').value.trim();
        const srcRemote = document.getElementById('task-src-remote').value;
        const srcPath = document.getElementById('task-src-path').value || '/';
        const dstRemote = document.getElementById('task-dst-remote').value;
        const dstPath = document.getElementById('task-dst-path').value || '/';
        const mode = document.getElementById('task-mode').value;
        const cronExpr = document.getElementById('task-cron').value.trim();
        const editId = document.getElementById('task-edit-id').value;

        if (!name) { this.toast('请输入任务名称', 'error'); return; }
        if (!srcRemote || !dstRemote) { this.toast('请选择源和目标存储', 'error'); return; }

        // Collect advanced options
        const customArgsStr = document.getElementById('task-opt-custom').value.trim();
        const advancedOptions = App.parseRcloneArgs(customArgsStr);

        const notifyPolicy = document.getElementById('task-notify-policy').value;
        const body = { name, srcRemote, srcPath, dstRemote, dstPath, mode, cron: cronExpr, notifyPolicy, notifyOnComplete: notifyPolicy !== 'none', advancedOptions };

        try {
            if (editId) {
                await this.api('PUT', '/console-api/tasks/' + editId, body);
                this.toast('任务已更新', 'success');
            } else {
                await this.api('POST', '/console-api/tasks', body);
                this.toast('任务已创建', 'success');
            }
            this.closeTaskModal();
            this.loadTasksPage();
        } catch (err) {
            this.toast('保存失败: ' + err.message, 'error');
        }
    },

    async deleteTask(id) {
        if (!confirm('确定删除此任务吗？')) return;
        try {
            await this.api('DELETE', '/console-api/tasks/' + id);
            this.toast('任务已删除', 'success');
            this.loadTasksPage();
        } catch (err) {
            this.toast('删除失败: ' + err.message, 'error');
        }
    },

    async toggleTask(id) {
        try {
            const data = await this.api('POST', '/console-api/tasks/' + id + '/toggle');
            this.toast(data.enabled ? '任务已启用' : '任务已禁用', 'success');
            this.loadTasksPage();
        } catch (err) {
            this.toast('操作失败: ' + err.message, 'error');
        }
    },

    async runTask(id) {
        try {
            this.toast('正在执行任务...', 'info');
            const data = await this.api('POST', '/console-api/tasks/' + id + '/run');
            if (data.record?.status === 'success') {
                this.toast('任务已启动', 'success');
            } else {
                this.toast('任务执行失败: ' + (data.record?.message || '未知错误'), 'error');
            }
            this.loadTasksPage();
        } catch (err) {
            this.toast('执行失败: ' + err.message, 'error');
        }
    },

    async stopTask(id) {
        try {
            this.toast('正在停止任务...', 'info');
            const data = await this.api('POST', '/console-api/tasks/' + id + '/stop');
            if (data.success) {
                this.toast(data.message || '任务已停止', 'success');
            } else {
                this.toast(data.message || '停止失败', 'error');
            }
            this.loadTasksPage();
        } catch (err) {
            this.toast('停止失败: ' + err.message, 'error');
        }
    },

    async viewTaskHistory(id) {
        const list = document.getElementById('history-list');
        list.innerHTML = '<div class="loading-state"><div class="spinner"></div><p>加载中...</p></div>';
        document.getElementById('history-modal').classList.add('active');
        try {
            const data = await this.api('GET', '/console-api/tasks/' + id + '/history');
            const history = data.history || [];
            if (history.length === 0) {
                list.innerHTML = '<div class="empty-state"><p>暂无执行记录</p></div>';
                return;
            }
            list.innerHTML = history.map(h => {
                const statusCls = h.status === 'success' ? 'history-success' : h.status === 'stopped' ? 'history-stopped' : 'history-error';
                const statusText = h.status === 'success' ? '✅ 成功' : h.status === 'stopped' ? '⏹ 已停止' : '❌ 失败';
                return `<div class="history-item ${statusCls}">
                    <span class="history-time">${this.formatTime(h.time)}</span>
                    <span class="history-status">${statusText}</span>
                    <span class="history-msg">${this.escapeHtml(h.message || '')}</span>
                </div>`;
            }).join('');
        } catch (err) {
            list.innerHTML = `<div class="empty-state"><p>加载失败: ${this.escapeHtml(err.message)}</p></div>`;
        }
    },

    closeHistoryModal() {
        document.getElementById('history-modal').classList.remove('active');
    },

    // ========================
    // File Browser (shared)
    // ========================
    async browseRemote(target) {
        const remote = document.getElementById(`${target}-remote`).value;
        if (!remote) { this.toast('请先选择远程存储', 'error'); return; }
        this.browseTarget = target;
        this.browseRemoteName = remote;
        this.browsePath = document.getElementById(`${target}-path`).value || '/';
        document.getElementById('browse-modal-title').textContent = '浏览: ' + remote;
        document.getElementById('browse-modal').classList.add('active');
        this.loadBrowseDir();
    },

    async loadBrowseDir() {
        const list = document.getElementById('browse-file-list');
        const pathEl = document.getElementById('browse-current-path');
        pathEl.textContent = this.browseRemoteName + ':' + this.browsePath;
        list.innerHTML = '<div class="loading-state"><div class="spinner"></div><p>加载中...</p></div>';
        try {
            const fs = this.browseRemoteName + ':' + this.browsePath;
            const data = await this.api('POST', '/console-api/rclone/ls', { fs });
            const items = data.list || [];
            if (items.length === 0) {
                list.innerHTML = '<div class="empty-state"><p>空目录</p></div>';
                return;
            }
            const dirs = items.filter(i => i.IsDir).sort((a, b) => a.Name.localeCompare(b.Name));
            const files = items.filter(i => !i.IsDir).sort((a, b) => a.Name.localeCompare(b.Name));
            list.innerHTML = [...dirs, ...files].map(item => {
                const icon = item.IsDir ? '📁' : '📄';
                const size = item.IsDir ? '' : this.formatSize(item.Size);
                const cls = item.IsDir ? 'file-item dir' : 'file-item';
                const onclick = item.IsDir ? `App.browseTo('${this.escapeJsArgs(item.Path)}')` : '';
                return `<div class="${cls}" ${onclick ? 'onclick="' + onclick + '"' : ''}>
                    <span class="file-icon">${icon}</span>
                    <span class="file-name">${this.escapeHtml(item.Name)}</span>
                    <span class="file-size">${size}</span>
                </div>`;
            }).join('');
        } catch (err) {
            list.innerHTML = `<div class="empty-state"><p>加载失败: ${this.escapeHtml(err.message)}</p></div>`;
        }
    },

    browseTo(path) {
        this.browsePath = '/' + path;
        this.loadBrowseDir();
    },

    browseUp() {
        const parts = this.browsePath.replace(/\/$/, '').split('/');
        parts.pop();
        this.browsePath = parts.join('/') || '/';
        this.loadBrowseDir();
    },

    selectBrowsePath() {
        document.getElementById(`${this.browseTarget}-path`).value = this.browsePath;
        this.closeBrowseModal();
    },

    closeBrowseModal() {
        document.getElementById('browse-modal').classList.remove('active');
    },

    formatSize(bytes) {
        if (!bytes || bytes === 0) return '0 B';
        const k = 1024;
        const sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
        const i = Math.floor(Math.log(bytes) / Math.log(k));
        return parseFloat((bytes / Math.pow(k, i)).toFixed(1)) + ' ' + sizes[i];
    },

    // ========================
    // File Manager (Remote Storage Browser)
    // ========================
    fmRemoteName: '',
    fmCurrentPath: '/',

    openFileManager(remoteName) {
        this.fmRemoteName = remoteName;
        this.fmCurrentPath = '/';
        document.getElementById('fm-modal-title').textContent = '文件管理器 — ' + remoteName;
        document.getElementById('fm-modal').classList.add('active');
        this.loadFmDir();
    },

    closeFmModal() {
        document.getElementById('fm-modal').classList.remove('active');
    },

    fmBuildBreadcrumb() {
        const container = document.getElementById('fm-breadcrumb');
        const parts = this.fmCurrentPath.replace(/^\/+/, '').replace(/\/+$/, '').split('/').filter(Boolean);
        let html = `<span class="fm-crumb-item fm-crumb-link" onclick="App.fmNavigateTo('/')">${this.escapeHtml(this.fmRemoteName)}:</span>`;
        let accumulated = '';
        parts.forEach((part, idx) => {
            accumulated += '/' + part;
            const path = accumulated;
            html += `<span class="fm-crumb-sep">/</span>`;
            if (idx === parts.length - 1) {
                html += `<span class="fm-crumb-item fm-crumb-current">${this.escapeHtml(part)}</span>`;
            } else {
                html += `<span class="fm-crumb-item fm-crumb-link" onclick="App.fmNavigateTo('${this.escapeJsArgs(path)}')">${this.escapeHtml(part)}</span>`;
            }
        });
        container.innerHTML = html;
    },

    async loadFmDir() {
        const list = document.getElementById('fm-file-list');
        list.innerHTML = '<div class="loading-state"><div class="spinner"></div><p>加载中...</p></div>';
        this.fmBuildBreadcrumb();
        try {
            const fsStr = this.fmRemoteName + ':';
            const remotePath = this.fmCurrentPath.replace(/^\/+/, '');
            const data = await this.api('POST', '/console-api/rclone/ls', { fs: fsStr, path: remotePath });
            const items = data.list || [];
            if (items.length === 0) {
                list.innerHTML = '<div class="empty-state"><p>📂 空目录</p></div>';
                return;
            }
            const dirs = items.filter(i => i.IsDir).sort((a, b) => a.Name.localeCompare(b.Name));
            const files = items.filter(i => !i.IsDir).sort((a, b) => a.Name.localeCompare(b.Name));
            list.innerHTML = [...dirs, ...files].map(item => {
                const icon = item.IsDir ? '📁' : '📄';
                const size = item.IsDir ? '-' : this.formatSize(item.Size);
                const modTime = item.ModTime ? this.fmFormatTime(item.ModTime) : '-';
                const itemPath = item.Path || item.Name;
                const dirOnClick = item.IsDir ? `onclick="App.fmNavigateTo('/${this.escapeJsArgs(itemPath)}')"` : '';
                const cls = item.IsDir ? 'fm-file-row fm-dir' : 'fm-file-row';
                let openBtn = '';
                if (!item.IsDir) {
                    const isVideo = /\.(mp4|mkv|avi|mov|webm|flv)$/i.test(item.Name);
                    const btnTitle = isVideo ? '播放视频' : '打开文件';
                    const svg = isVideo 
                        ? `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polygon points="5 3 19 12 5 21 5 3"></polygon></svg>` 
                        : `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"></path><polyline points="15 3 21 3 21 9"></polyline><line x1="10" y1="14" x2="21" y2="3"></line></svg>`;
                    openBtn = `
                        <button class="btn-icon fm-open-btn" onclick="event.stopPropagation(); App.fmOpenFile('${this.escapeJsArgs(itemPath)}', ${isVideo})" title="${btnTitle}" style="margin-right: 8px;">
                            ${svg}
                        </button>`;
                }
                return `<div class="${cls}" ${dirOnClick}>
                    <span class="fm-file-icon">${icon}</span>
                    <span class="fm-file-name" title="${this.escapeHtml(item.Name)}">${this.escapeHtml(item.Name)}</span>
                    <span class="fm-file-size">${size}</span>
                    <span class="fm-file-time">${modTime}</span>
                    <span class="fm-file-actions">
                        ${openBtn}
                        <button class="btn-icon fm-delete-btn" onclick="event.stopPropagation(); App.fmDeleteItem('${this.escapeJsArgs(itemPath)}', '${this.escapeJsArgs(item.Name)}', ${item.IsDir})" title="删除">
                            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg>
                        </button>
                    </span>
                </div>`;
            }).join('');
        } catch (err) {
            list.innerHTML = `<div class="empty-state"><p>加载失败: ${this.escapeHtml(err.message)}</p></div>`;
        }
    },

    fmFormatTime(isoStr) {
        try {
            const d = new Date(isoStr);
            return d.toLocaleString('zh-CN', { year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' });
        } catch { return isoStr; }
    },

    fmNavigateTo(path) {
        this.fmCurrentPath = path || '/';
        this.loadFmDir();
    },

    fmGoUp() {
        const parts = this.fmCurrentPath.replace(/\/+$/, '').split('/');
        parts.pop();
        this.fmCurrentPath = parts.join('/') || '/';
        this.loadFmDir();
    },

    fmRefresh() {
        this.loadFmDir();
    },

    fmOpenFile(filePath, isVideo) {
        const fsStr = this.fmRemoteName + ':';
        const url = '/console-api/rclone/serve?fs=' + encodeURIComponent(fsStr) + '&path=' + encodeURIComponent(filePath) + '&token=' + localStorage.getItem('auth_token');
        if (isVideo) {
            const win = window.open('', '_blank');
            if (win) {
                win.document.write(`<html><head><title>播放 - ${this.escapeHtml(filePath)}</title><style>body{margin:0;background:#000;display:flex;justify-content:center;align-items:center;height:100vh;} video{max-width:100%;max-height:100%;outline:none;}</style></head><body><video controls autoplay name="media"><source src="${url}"></video></body></html>`);
                win.document.close();
            } else {
                this.toast('请允许弹出窗口以播放视频', 'error');
            }
        } else {
            window.open(url, '_blank');
        }
    },

    async fmCreateDir() {
        const name = prompt('请输入新目录名称:');
        if (!name || !name.trim()) return;
        const dirName = name.trim();
        // Validate directory name
        if (/[\\/:*?"<>|]/.test(dirName)) {
            this.toast('目录名包含无效字符', 'error');
            return;
        }
        try {
            const fsStr = this.fmRemoteName + ':';
            const remotePath = (this.fmCurrentPath.replace(/^\/+/, '').replace(/\/+$/, '') + '/' + dirName).replace(/^\/+/, '');
            await this.api('POST', '/console-api/rclone/mkdir', { fs: fsStr, remote: remotePath });
            this.toast(`目录 "${dirName}" 创建成功`, 'success');
            this.loadFmDir();
        } catch (err) {
            this.toast('创建目录失败: ' + err.message, 'error');
        }
    },

    async fmDeleteItem(path, name, isDir) {
        const typeText = isDir ? '目录' : '文件';
        if (!confirm(`确定删除${typeText} "${name}" 吗？${isDir ? '\n⚠️ 这将删除该目录及其所有内容！' : ''}`)) return;
        try {
            const fsStr = this.fmRemoteName + ':';
            await this.api('POST', '/console-api/rclone/delete', { fs: fsStr, remote: path, isDir });
            this.toast(`${typeText} "${name}" 已删除`, 'success');
            this.loadFmDir();
        } catch (err) {
            this.toast('删除失败: ' + err.message, 'error');
        }
    },
};

// Boot
document.addEventListener('DOMContentLoaded', () => App.init());
