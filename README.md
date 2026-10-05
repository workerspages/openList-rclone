
# openList-Rclone All-in-One

将 [openList](https://github.com/openListGo/openlist) 和 [Rclone](https://github.com/wiserain/rclone)（mod 版本）集成到一个 Docker 镜像中，提供统一的 Web 控制台管理界面。

专为 **PaaS 平台与 VPS** 设计 — 无需终端，所有操作通过 Web 界面完成。

## ✨ 功能特性

- 🗂️ **openList 文件管理** — 支持多种云存储的在线文件管理
- ☁️ **Rclone 云同步** — 强大的云存储挂载和同步工具（wiserain mod 版本）
- 🎛️ **统一 Web 控制台** — 在浏览器中管理所有配置和操作
- 🔄 **高级文件传输** — 支持在不同云盘间直接互拷，支持并发、过滤等高级传输参数
- ⚙️ **配置编辑功能** — 支持在图形界面上直接修改现有的 Rclone 远程存储配置参数
- 🔔 **Bark 推送通知** — 定时任务执行完成后自动发送 Bark 推送通知（支持自建服务器）
- ⏹ **任务停止功能** — 支持随时停止正在执行的传输任务，无需重启容器
- 🔐 **安全登录** — 用户名密码认证保护
- 📊 **状态监控与日志** — 实时查看服务运行状态及各组件日志
- ☁️ **无状态环境支持** — 专为 PaaS 设计，支持通过 `SYNC_DEST` 自动同步全站状态到 S3/WebDAV，彻底解决容器重启数据丢失问题
- 🏗️ **多架构支持** — 同时支持 `amd64` 和 `arm64`

---

## 🚀 快速部署

### 方式一：Docker Run (适合常规 VPS)

```bash
docker run -d \
  --name openlist-rclone \
  -p 8080:8080 \
  -v $(pwd)/data:/data \
  -v $(pwd)/host:/opt/host:ro \
  -e WEB_USERNAME=admin \
  -e WEB_PASSWORD=your_password \
  -e OPENLIST_ADMIN_PASSWORD=your_openlist_password \
  -e TZ=Asia/Shanghai \
  -e SYNC_DEST="你的SYNC_DEST_可选" \
  -e SYNC_INTERVAL="5" \
  ghcr.io/workerspages/openlist-rclone:latest

```

> 💡 `-v $(pwd)/host:/opt/host` 用于将宿主机目录挂载到容器中。容器会自动在 Rclone 配置中添加一个名为 `host` 的本地驱动，方便你在网页上将网盘文件与宿主机直接互拷。

### 方式二：Docker Compose（推荐）

创建 `docker-compose.yml` 文件：

```yaml
services:
  openlist-rclone:
    image: ghcr.io/workerspages/openlist-rclone:latest
    container_name: openlist-rclone
    restart: unless-stopped
    ports:
      - "8080:8080"
    volumes:
      - ./data:/data
      - ./host:/opt/host:ro # 映射宿主机目录至容器内，用于本地与网盘间的文件传输
    environment:
      - TZ=Asia/Shanghai
      - SWAP_SIZE_MB=512
      
      # Web 控制台登录凭据
      - WEB_USERNAME=admin
      - WEB_PASSWORD=admin
      
      # openList 管理员凭据
      - OPENLIST_ADMIN_USERNAME=admin
      - OPENLIST_ADMIN_PASSWORD=admin
      
      # 高级变量 (PaaS 无状态环境自动备份配置)
      # 方式一：结构化配置（推荐）
      # - STORAGE_TYPE=s3
      # - S3_ENDPOINT=https://xxx.r2.cloudflarestorage.com
      # - S3_ACCESS_KEY=your_ak
      # - S3_SECRET_KEY=your_sk
      # - S3_BUCKET=your_bucket
      # - S3_REGION=auto
      # - S3_PATH=openlist-rclone
      
      # 方式二：标准网址格式或底层语法（与方式一二选一即可）
      # - SYNC_DEST=s3://AK:SK@xxx.r2.cloudflarestorage.com/bucket
      
      # 自动同步外部存储的时间间隔
      - SYNC_INTERVAL=5
      
      # 配置后定时任务执行完成时会自动发送推送通知
      - BARK_URL=https://api.day.app/yourkey
```

启动：

```bash
docker compose up -d

```

### 方式三：Pterodactyl（翼龙游戏机面板）Node.js 环境中部署 (无持久化存储环境)
针对像 KataBump 这样基于面板管理（通常底层是 Pterodactyl 翼龙面板或类似容器架构）的免费托管平台，由于平台原生提供了 **NodeJs** 环境，可以完美适配 Node.js 单体化版本。

平台通常会为你分配一个特定的运行端口（环境变量通常为 `SERVER_PORT` 或 `PORT`）。

以下是完整的部署步骤和最终代码：

#### 步骤 1：在面板创建服务器

根据你截图的界面：

1. **Name**：填写你喜欢的名字（例如 `openlist-rclone`）。
2. **Type**：选择 **NodeJs**。
3. **Resources**：选择免费套餐。
4. 勾选验证码和协议，点击 **Create server**。

#### 步骤 2：整理项目文件

创建服务器后，进入该服务器的 **管理面板 (Dashboard)** -> **文件管理 (File Manager)**。你需要确保服务器根目录（通常是 `/home/container`）下有以下文件结构：

```text
/ (根目录)
├── package.json      # 配置文件 (见下方)
├── index.js          # 核心启动文件 (见下方)
└── web/              # 文件夹 (把你之前项目里的 web 文件夹整个传上来)
    ├── index.html
    ├── styles.css
    ├── app.js
    └── update-version.sh

```

#### 步骤 3：上传配置文件和代码

请在面板的文件管理器中新建或覆盖以下两个文件（以下为修改后的最终完整版本，没有任何删减）：

- 文件一：`package.json`

确保包含 `http-proxy-middleware` 和 `adm-zip` 等依赖。平台在启动时通常会自动执行 `npm install`。
[package.json](/package.json)

- 文件二：`index.js`
[package.json](/index.js)

- 文件三：`web目录内所有文件`
[web目录内所有文件](/web)



### 方式四：PaaS 平台部署 (无持久化存储环境)

大多数 PaaS 平台（如 Railway、Render、Zeabur、Koyeb 等）支持直接使用 Docker 镜像部署：

1. **镜像地址**：`ghcr.io/workerspages/openlist-rclone:latest`
2. **端口**：设置为 `8080`
3. **环境变量**：按下方表格配置
4. **持久化存储**：如果平台无持久化本地存储，请务必参考下方的 `SYNC_DEST` 无状态持久化方案。

---

## 📋 环境变量

| 变量 | 默认值 | 必填 | 说明 |
| --- | --- | --- | --- |
| `WEB_USERNAME` | `admin` | ✅ | Web 控制台登录用户名 |
| `WEB_PASSWORD` | `admin` | ⚠️ | Web 控制台登录密码，**强烈建议修改** |
| `OPENLIST_ADMIN_USERNAME` | `admin` | ✅ | openList 管理员用户名 |
| `OPENLIST_ADMIN_PASSWORD` | `admin` | ⚠️ | openList 管理员密码，**强烈建议修改** |
| `TZ` | `Asia/Shanghai` | ✅ | 容器时区 |
| `SYNC_DEST` | - | ❌ | **[无状态 PaaS 专用]** 外部配置备份地址（如 S3 或 WebDAV）。配置后每次启动自动拉取，并依 `SYNC_INTERVAL` 自动备份 `/data` 目录 |
| `SYNC_INTERVAL` | `5` | ❌ | **[无状态 PaaS 专用]** 自动同步外部存储的时间间隔（分钟）。默认为 `5`。**设为 `0` 即可开启只读从节点模式** |
| `CUSTOM_CA_CERT_PATH` | - | ❌ | 自定义 CA 证书的容器内路径（可为文件或目录），用于信任私有/自签证书 |
| `SWAP_SIZE_MB` | - | ❌ | 交换内存（虚拟内存）大小，单位为MB。例如 `512`表示分配512MB。开启此功能可能需要开启容器特权模式 |
| `BARK_URL` | - | ❌ | Bark 推送通知服务器地址（如 `https://api.day.app/yourkey`）。配置后定时任务执行完成时会自动发送推送通知 |
| `IGNORE_ERRORS` | `object not found` | ❌ | 自定义需要静默忽略的错误关键字（多个用英文逗号分隔），包含这些关键字的错误将被当做成功，不发失败报警 |

> ⚠️ **安全提示**：首次部署时请务必修改 `WEB_PASSWORD` 和 `OPENLIST_ADMIN_PASSWORD`，不要使用默认值。

---

## ☁️ 无状态 PaaS 平台终极持久化方案 (SYNC_DEST)

在 Koyeb、Render 等没有本地持久化存储（Volume）的 PaaS 平台上，容器重启会导致所有应用数据和配置丢失。

为了解决此问题，您只需配置 `SYNC_DEST` 环境变量，容器就会在启动时**自动从外部存储拉取完整环境**，并在运行期间**按 `SYNC_INTERVAL` 设定的分钟数（默认 5）自动将最新状态备份回外部存储**（自动排除不必要的缓存和临时文件）。此方案将同时备份 openList 数据库与 Rclone 配置。

> 💡 **高级进阶：多节点主从部署 (Primary-Secondary)**
> 如果您在多个平台部署了该容器，且它们共享同一个 `SYNC_DEST`，**定时同步和关机保护机制会导致不同平台的数据互相覆盖**。
> 
> **完美解决方案：**
> * 👑 **主节点（Primary）**：保留一个平台用于后台管理（修改密码、挂载网盘）。配置 `SYNC_INTERVAL=5`（或其他大于 0 的数），正常向 S3 推送变更。
> * 🛡️ **从节点（Secondary）**：其他只用于下载和前台展示的平台，配置 **`SYNC_INTERVAL=0`**。
> 
> 当 `SYNC_INTERVAL=0` 时，节点进入**原生只读模式**：**启动时拉取主节点最新数据，但在运行和关机时永远不会向 S3 推送任何数据**，彻底根除覆盖风险！当主节点修改了配置后，只需重启从节点容器即可同步最新状态。

### 1. 结构化配置：备份到 S3（推荐，以 Cloudflare R2 为例）

添加以下环境变量即可完成配置（无需担心任何复杂的转义和拼写问题）：

```text
STORAGE_TYPE=s3
S3_ENDPOINT=https://xxx.r2.cloudflarestorage.com
S3_ACCESS_KEY=你的AK
S3_SECRET_KEY=你的SK
S3_BUCKET=你的存储桶名称
```

*高级选项（可选）：*
* `S3_REGION`: 默认为 `us-east-1`，如果您使用 Cloudflare R2，系统会自动检测并使用 `auto`。
* `S3_PATH`: 桶内子路径，例如 `openlist-backup/`。

### 2. 结构化配置：备份到 WebDAV（以坚果云为例）

添加以下环境变量：

```text
STORAGE_TYPE=webdav
WEBDAV_URL=https://dav.jianguoyun.com/dav/
WEBDAV_USER=你的账号
WEBDAV_PASS=你的应用密码
```

*(注意：容器会在启动时自动为您调用 `rclone obscure` 对 `WEBDAV_PASS` 进行加密混淆，您**直接填入真实明文密码**即可，系统绝不会在日志中泄露)*

*高级选项（可选）：*
* `WEBDAV_VENDOR`: 默认为 `other`（适配坚果云等），如果您使用 Nextcloud，可设为 `nextcloud`。
* `WEBDAV_PATH`: 远端子路径，例如 `openlist-backup/`。

### 3. 单行网址或原生语法配置（向后兼容/备选方案）

除了上述结构化配置，您仍然可以使用单个 `SYNC_DEST` 变量：

**标准网址格式**：
* `SYNC_DEST="s3://<你的AK>:<你的SK>@<你的Endpoint地址>/<存储桶名称>"`
* `SYNC_DEST="webdav://<你的账号>:<应用密码>@<WebDAV地址>"`

**高级原生连接字符串**（适合老用户）：
* `SYNC_DEST=":s3,provider=...:"` 

> **注意**：如果您使用的是常规 VPS 或支持本地硬盘挂载的环境，完全可以忽略无状态备份配置，系统默认依靠本地 `/data` 目录持久化保存数据。

---

## 🌐 访问说明

部署完成后：

* **openList 文件管理**：访问 `http://你的IP:端口/` 即可打开 openList
* **Web 管理控制台**：访问 `http://你的IP:端口/console/` 管理 Rclone 配置、文件传输、查看日志等

### 路由说明

| 路径 | 服务 | 说明 |
| --- | --- | --- |
| `/` | openList 文件管理 | openList 原生界面（根路径直接访问） |
| `/console/` | Web 管理控制台 | 统一管理界面，需登录 |
| `/console-api/` | 后端 API | 控制台后端接口 |

### Web 控制台功能

1. **仪表板** — 查看 openList 和 Rclone 运行状态、运行时间、远程存储数量
2. **Rclone 配置** — 添加/修改/测试/删除远程存储，包括强大的实时 **连通性探测功能**
3. **定时任务** — 支持在多个 Rclone 配置间进行定时和手动文件复制、移动和同步操作。包含高级参数、任务停止功能和 Bark 完成通知
4. **openList 文件管理** — 内嵌 openList 管理主打界面，一站式管理所有文件
5. **日志** — 在线查看 openList、Rclone、Nginx、API 的运行日志

### 🔌 后端 API 使用指南

如果您希望通过脚本自动化调用控制器功能（如触发定时任务等），可以直接调用 `/console-api/` 接口：

**1. 获取 Token (登录)**

```http
POST /console-api/login
Content-Type: application/json

{"username": "admin", "password": "your_password"}

```

响应中将返回 `token`。

**2. 调用接口**
在后续其他请求中放入 Header 即可通信：
`Authorization: Bearer <获取到的 Token>`

**常用端点示例**：

* `GET /console-api/status` : 获取容器各服务运行状态
* `GET /console-api/rclone/remotes` : 枚举所有网盘配置
* `POST /console-api/tasks/{task_id}/run` : 立即触发执行某个转移任务
* `POST /console-api/tasks/{task_id}/stop` : 停止正在执行的任务
* `POST /console-api/service/restart` : 重启 openList/Rclone 服务 (`{"service": "openlist"}`)
* `GET /console-api/bark/status` : 查询 Bark 通知配置状态
*(如果需要更详尽的接口，请查阅容器内的 `server/index.js` 路由定义)*

---

## 📁 数据持久化

对于有本地硬盘的环境（VPS/NAS），所有数据默认保存在 `/data` 目录下：

```
/data
├── openlist/          # openList 配置和本地 SQLite 数据库
│   ├── config.json # openList 配置文件
│   └── data.db     # openList 数据库
└── rclone/         # Rclone 配置和缓存
    ├── rclone.conf # Rclone 配置文件
    ├── scheduled-tasks.json # 定时任务配置文件
    └── cache/      # Rclone 缓存目录

```

> 💡 请务必挂载 `/data` 目录以持久化数据，否则容器重启后配置会丢失。

---

## 🔧 使用示例

### 添加和修改 Rclone 远程存储

1. 登录 Web 控制台
2. 进入「Rclone 配置」页面
3. **添加**：点击「添加远程存储」，选择存储类型，填写参数，点击保存
4. **修改**：点击现有存储卡片上的「编辑」按钮，修改密码及令牌等参数，保存更新

### 在 openList 中使用 Rclone 存储

Rclone 配置好远程存储后，可以在 openList 中添加存储驱动时选择「本地存储」，挂载路径指向 Rclone 挂载的目录。

### 直接使用 openList

访问 `/openlist/` 路径，使用 `OPENLIST_ADMIN_USERNAME` / `OPENLIST_ADMIN_PASSWORD` 登录后即可管理存储。

---

## 🏗️ 镜像地址

| 仓库 | 地址 |
| --- | --- |
| GitHub Container Registry | `ghcr.io/workerspages/openlist-rclone:main` |
| Docker Hub | `workerspages/openlist-rclone:main` |

---

## ⬆️ 关于版本更新

本项目内置的 `openList` 和被修改过的 `Rclone` （wiserain版本）都配置为在构建时自动拉取最新的 Release 标签。要将您的环境更新至这两者的最新版本，您只需重新构建或拉取最新的 Docker 镜像。

* **如果您使用 GitHub 仓库 (推荐)**：在 GitHub 上的 `Actions` 页面手动运行一次 `Build and Push Docker Image`，构建出最新镜像后，用 `docker compose pull && docker compose up -d` 重新部署即可。
* **如果您手动管理版本**：修改代码提交 `git push` 到仓库即可触发自动构建动作。也可直接在服务器执行强制构建：`docker compose build --no-cache && docker compose up -d`。

---

## 🔨 本地构建

```bash
git clone [https://github.com/workerspages/openlist-rclone.git](https://github.com/workerspages/openlist-rclone.git)
cd openlist-rclone
docker build -t openlist-rclone .
docker run -d -p 5000:8080 -v $(pwd)/data:/data openlist-rclone

```

## 📄 License

MIT


