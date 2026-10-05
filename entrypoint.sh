#!/bin/bash
set -e

echo "============================================"
echo "  openList-Rclone All-in-One Container"
echo "============================================"

# ---- Setup Swap Memory ----
if [ -n "$SWAP_SIZE_MB" ] && [ "$SWAP_SIZE_MB" -gt 0 ] 2>/dev/null; then
    echo "[Init] Setting up swap space of ${SWAP_SIZE_MB}MB..."
    swapoff /swapfile 2>/dev/null || true
    if [ ! -f /swapfile ] || [ "$(stat -c %s /swapfile 2>/dev/null || echo 0)" -ne "$((SWAP_SIZE_MB * 1024 * 1024))" ]; then
        dd if=/dev/zero of=/swapfile bs=1M count="$SWAP_SIZE_MB" 2>/dev/null
        chmod 600 /swapfile
        mkswap /swapfile
    fi
    swapon /swapfile || echo "[Warning] Failed to enable swap."
fi

# ---- Timezone ----
if [ -n "$TZ" ]; then
    ln -snf /usr/share/zoneinfo/$TZ /etc/localtime
    echo "$TZ" > /etc/timezone
fi

# ---- Structured Storage Configuration ----
if [ -n "$STORAGE_TYPE" ]; then
    if [ "$STORAGE_TYPE" = "s3" ]; then
        if [ -z "$S3_ENDPOINT" ] || [ -z "$S3_ACCESS_KEY" ] || [ -z "$S3_SECRET_KEY" ] || [ -z "$S3_BUCKET" ]; then
            echo "[Init] Error: STORAGE_TYPE is 's3' but required S3_* variables are missing!"
            exit 1
        fi
        S3_PROVIDER="Other"
        if [[ "$S3_ENDPOINT" == *"cloudflarestorage"* ]]; then
            S3_PROVIDER="Cloudflare"
            S3_REGION="${S3_REGION:-auto}"
        else
            S3_REGION="${S3_REGION:-us-east-1}"
        fi
        
        if [[ ! "$S3_ENDPOINT" =~ ^https?:// ]]; then
            S3_ENDPOINT="https://$S3_ENDPOINT"
        fi
        
        S3_PATH_STR=""
        if [ -n "$S3_PATH" ]; then
            S3_PATH_STR="${S3_PATH#/}"
            S3_PATH_STR="${S3_PATH_STR%/}"
            if [ -n "$S3_PATH_STR" ]; then
                S3_PATH_STR="/$S3_PATH_STR"
            fi
        fi
        
        echo "[Init] Generated Rclone connection string from S3 structured variables."
        export SYNC_DEST=":s3,provider=\"$S3_PROVIDER\",region=\"$S3_REGION\",endpoint=\"$S3_ENDPOINT\",access_key_id=\"$S3_ACCESS_KEY\",secret_access_key=\"$S3_SECRET_KEY\":$S3_BUCKET$S3_PATH_STR"
        
    elif [ "$STORAGE_TYPE" = "webdav" ]; then
        if [ -z "$WEBDAV_URL" ] || [ -z "$WEBDAV_USER" ] || [ -z "$WEBDAV_PASS" ]; then
            echo "[Init] Error: STORAGE_TYPE is 'webdav' but required WEBDAV_* variables are missing!"
            exit 1
        fi
        WEBDAV_VENDOR="${WEBDAV_VENDOR:-other}"
        
        if [[ ! "$WEBDAV_URL" =~ ^https?:// ]]; then
            WEBDAV_URL="https://$WEBDAV_URL"
        fi
        
        WEBDAV_PATH_STR=""
        if [ -n "$WEBDAV_PATH" ]; then
            WEBDAV_PATH_STR="${WEBDAV_PATH#/}"
            WEBDAV_PATH_STR="${WEBDAV_PATH_STR%/}"
            if [ -n "$WEBDAV_PATH_STR" ]; then
                WEBDAV_PATH_STR="/$WEBDAV_PATH_STR"
            fi
        fi
        
        OBSCURED_PASS=$(/usr/bin/rclone obscure "$WEBDAV_PASS")
        
        echo "[Init] Generated Rclone connection string from WebDAV structured variables."
        export SYNC_DEST=":webdav,vendor=\"$WEBDAV_VENDOR\",url=\"$WEBDAV_URL\",user=\"$WEBDAV_USER\",pass=\"$OBSCURED_PASS\":$WEBDAV_PATH_STR"
    else
        echo "[Init] Error: Unsupported STORAGE_TYPE: $STORAGE_TYPE"
        exit 1
    fi
fi

# ---- Parse SYNC_DEST URL formats ----
if [ -n "$SYNC_DEST" ]; then
    if [[ "$SYNC_DEST" =~ ^s3://([^:]+):([^@]+)@([^/]+)/(.*)$ ]]; then
        S3_AK="${BASH_REMATCH[1]}"
        S3_SK="${BASH_REMATCH[2]}"
        S3_ENDPOINT="${BASH_REMATCH[3]}"
        S3_BUCKET="${BASH_REMATCH[4]}"
        S3_PROVIDER="Other"
        if [[ "$S3_ENDPOINT" == *"cloudflarestorage"* ]]; then
            S3_PROVIDER="Cloudflare"
        fi
        if [[ ! "$S3_ENDPOINT" =~ ^https?:// ]]; then
            S3_ENDPOINT="https://$S3_ENDPOINT"
        fi
        echo "[Init] Converted s3:// URL to Rclone connection string."
        export SYNC_DEST=":s3,provider=\"$S3_PROVIDER\",endpoint=\"$S3_ENDPOINT\",access_key_id=\"$S3_AK\",secret_access_key=\"$S3_SK\":$S3_BUCKET"
    elif [[ "$SYNC_DEST" =~ ^(webdav|dav)://([^:]+):([^@]+)@(.*)$ ]]; then
        DAV_USER="${BASH_REMATCH[2]}"
        DAV_PASS="${BASH_REMATCH[3]}"
        DAV_PATH="${BASH_REMATCH[4]}"
        if [[ ! "$DAV_PATH" =~ ^https?:// ]]; then
            DAV_ENDPOINT="https://$DAV_PATH"
        else
            DAV_ENDPOINT="$DAV_PATH"
        fi
        OBSCURED_PASS=$(/usr/bin/rclone obscure "$DAV_PASS")
        echo "[Init] Converted webdav:// URL to Rclone connection string."
        export SYNC_DEST=":webdav,vendor=\"other\",url=\"$DAV_ENDPOINT\",user=\"$DAV_USER\",pass=\"$OBSCURED_PASS\":"
    fi
fi

# ---- Print Environment Settings ----
echo "[Init] Current AutoSync Settings:"
if [ -n "$SYNC_DEST" ]; then
    # Protect sensitive credentials in the URL and rclone connection strings
    MASKED_DEST=$(echo "$SYNC_DEST" | sed -E -e 's/(:\/\/[^:]+:)[^@]+@/\1***@/g' -e 's/(secret_access_key|access_key_id|password|pass|token|client_secret)=("[^"]*"|'\''[^'\'']*'\''|[^,:]+)/\1="***"/g')
    echo "  - SYNC_DEST: $MASKED_DEST"
else
    MASKED_DEST="(Not Set)"
    echo "  - SYNC_DEST: (Not Set)"
fi
echo "  - SYNC_INTERVAL: ${SYNC_INTERVAL:-5} minutes"

# ---- External Storage Restore (S3/WebDAV) ----
if [ -n "$SYNC_DEST" ]; then
    echo "[Init] SYNC_DEST is set. Attempting to restore /data from external storage..."
    mkdir -p /data
    RESTORE_OK=false
    
    # 增加重试机制：PaaS容器启动时网络可能存在延迟，最多重试6次（等待30秒）
    for i in 1 2 3 4 5 6; do
        echo "=> [Attempt $i/6] Pulling data from $MASKED_DEST..."
        if /usr/bin/rclone copy "$SYNC_DEST" /data --checksum -v; then
            RESTORE_OK=true
            echo "[Init] Restore successful (or remote is empty)!"
            break
        fi
        echo "=> [Warning] Pull failed. Network may not be ready. Retrying in 5 seconds..."
        sleep 5
    done

    # 致命错误保护（熔断机制）：如果30秒后依然无法拉取，强制停止容器！
    if [ "$RESTORE_OK" != true ]; then
        echo "=========================================================================="
        echo "[FATAL ERROR] Failed to restore data from SYNC_DEST after 30 seconds!"
        echo "Container startup is HALTED to prevent wiping your remote backup."
        echo "Please check your SYNC_DEST credentials or provider API status."
        echo "=========================================================================="
        exit 1
    fi
fi

# ---- Clean Scheduled Tasks History ----
echo "[Init] Cleaning up scheduled tasks history..."
if [ -f /data/rclone/scheduled-tasks.json ]; then
    node -e "
    const fs = require('fs');
    const file = '/data/rclone/scheduled-tasks.json';
    try {
        const data = JSON.parse(fs.readFileSync(file, 'utf-8'));
        let modified = false;
        data.forEach(t => {
            if (t.history && t.history.length > 0) {
                t.history = [];
                modified = true;
            }
            if (t.activeJobId) {
                t.activeJobId = null;
                modified = true;
            }
        });
        if (modified) {
            fs.writeFileSync(file, JSON.stringify(data, null, 2), 'utf-8');
            console.log('[Init] Successfully cleared task history.');
        }
    } catch(e) {
        console.error('[Init] Failed to clean tasks history:', e.message);
    }
    "
fi

# ---- Initialize openList ----
echo "[Init] Initializing openList..."

if [ -d /data/openlist ]; then
    # 1. 强力清理可能从 S3 带来的 SQLite 临时锁文件
    echo "[Init] Cleaning up residual SQLite WAL files to prevent database locks..."
    rm -f /data/openlist/*.db-wal /data/openlist/*.db-shm

    # 2. 检查数据库完整性（安抚与排错诊断）
    if [ -f /data/openlist/data.db ]; then
        echo "[Init] Checking SQLite database integrity..."
        CHECK_RESULT=$(sqlite3 /data/openlist/data.db "PRAGMA integrity_check;" 2>&1 || echo "failed")
        if [[ "$CHECK_RESULT" == *"ok"* ]]; then
            echo "[Init] Success: Database integrity is OK."
        else
            echo "[Init] WARNING: Database might be corrupted. Output: $CHECK_RESULT"
            echo "[Init] WARNING: If openList fails to start, consider deleting /data/openlist/data.db from your S3 bucket."
        fi
    fi

    # 3. 强制修复 config.json，剔除不兼容的 HTTPS 证书路径和绑定限制
    if [ -f /data/openlist/config.json ]; then
        echo "[Init] Patching openList config.json for PaaS compatibility..."
        node -e "
        const fs = require('fs');
        try {
            const file = '/data/openlist/config.json';
            let cfg = JSON.parse(fs.readFileSync(file, 'utf-8'));
            if (cfg.scheme) {
                cfg.scheme.address = '0.0.0.0';
                cfg.scheme.http_port = 5244;
                cfg.scheme.force_https = false;
                cfg.scheme.cert_file = '';
                cfg.scheme.key_file = '';
            }
            fs.writeFileSync(file, JSON.stringify(cfg, null, 2), 'utf-8');
            console.log('[Init] Successfully patched config.json.');
        } catch(e) {
            console.error('[Init] Failed to patch config.json:', e.message);
        }
        "
    fi
fi

if [ ! -f /data/openlist/config.json ]; then
    echo "[Init] First run, creating openList config (sqlite3)..."
    mkdir -p /data/openlist
    cd /data/openlist
    /app/openlist server --data /data/openlist &
    OPENLIST_PID=$!
    sleep 3
    kill $OPENLIST_PID 2>/dev/null || true
    wait $OPENLIST_PID 2>/dev/null || true
fi

if [ -n "$OPENLIST_ADMIN_PASSWORD" ]; then
    /app/openlist admin set "$OPENLIST_ADMIN_PASSWORD" --data /data/openlist 2>/dev/null || true
fi

# ---- Initialize Rclone ----
echo "[Init] Initializing Rclone..."
mkdir -p /data/rclone/cache
if [ ! -f /data/rclone/rclone.conf ]; then
    touch /data/rclone/rclone.conf
fi

OPENLIST_REMOTE_NAME="openlist"
OPENLIST_USER="${OPENLIST_ADMIN_USERNAME:-admin}"
OPENLIST_PASS="${OPENLIST_ADMIN_PASSWORD:-admin}"

echo "[Init] Updating built-in openList remote configuration..."
if ! grep -q "\[$OPENLIST_REMOTE_NAME\]" /data/rclone/rclone.conf; then
    OBSCURED_PASS=$(/usr/bin/rclone obscure "$OPENLIST_PASS")
    cat >> /data/rclone/rclone.conf <<EOF

[$OPENLIST_REMOTE_NAME]
type = webdav
url = http://127.0.0.1:5244/dav
vendor = other
user = $OPENLIST_USER
pass = $OBSCURED_PASS
EOF
else
    /usr/bin/rclone config update "$OPENLIST_REMOTE_NAME" url "http://127.0.0.1:5244/dav" vendor "other" user "$OPENLIST_USER" pass "$OPENLIST_PASS" --config /data/rclone/rclone.conf >/dev/null 2>&1 || true
fi

HOST_REMOTE_NAME="host"
if ! grep -q "\[$HOST_REMOTE_NAME\]" /data/rclone/rclone.conf; then
    mkdir -p /opt/host
    cat >> /data/rclone/rclone.conf <<EOF

[$HOST_REMOTE_NAME]
type = alias
remote = /opt/host
EOF
fi

export WEB_USERNAME="${WEB_USERNAME:-admin}"
export WEB_PASSWORD="${WEB_PASSWORD:-admin}"
htpasswd -cb /etc/nginx/.htpasswd "$WEB_USERNAME" "$WEB_PASSWORD"
touch /var/log/openlist.log /var/log/rclone.log /var/log/api.log

echo "[Init] Starting services via supervisord..."
exec /usr/bin/supervisord -c /etc/supervisord.conf
