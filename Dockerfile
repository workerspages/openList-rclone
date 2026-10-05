# ========================================
# Stage 1: Build Node.js backend
# ========================================
FROM node:20-alpine AS builder

WORKDIR /build/server
COPY server/package.json server/package-lock.json* ./
RUN npm install --production
COPY server/ ./

# ========================================
# Stage 2: Final image
# ========================================
FROM alpine:3.20

LABEL maintainer="workerspages"
LABEL org.opencontainers.image.source="https://github.com/workerspages/openlist-rclone"
LABEL org.opencontainers.image.description="openList + Rclone All-in-One with Web Console"

# Target architecture (auto-set by Docker Buildx)
ARG TARGETARCH

# Versions (override with build args)
ARG OPENLIST_VERSION=latest

# Install base packages
RUN apk add --no-cache \
    nginx \
    supervisor \
    nodejs \
    npm \
    curl \
    ca-certificates \
    fuse3 \
    tzdata \
    bash \
    unzip \
    apache2-utils \
    sqlite \
    && rm -rf /var/cache/apk/*

# Download openList (use TARGETARCH from Buildx)
RUN set -ex; \
    mkdir -p /app; \
    if [ "$TARGETARCH" = "amd64" ]; then OPENLIST_ARCH="amd64"; \
    elif [ "$TARGETARCH" = "arm64" ]; then OPENLIST_ARCH="arm64"; \
    else echo "Unsupported arch: $TARGETARCH" && exit 1; fi; \
    if [ "$OPENLIST_VERSION" = "latest" ]; then \
    OPENLIST_URL="https://github.com/OpenListTeam/OpenList/releases/latest/download/openlist-linux-musl-${OPENLIST_ARCH}.tar.gz"; \
    else \
    OPENLIST_URL="https://github.com/OpenListTeam/OpenList/releases/download/${OPENLIST_VERSION}/openlist-linux-musl-${OPENLIST_ARCH}.tar.gz"; \
    fi; \
    echo "Downloading openList ($OPENLIST_ARCH) from: $OPENLIST_URL"; \
    curl -fsSL "$OPENLIST_URL" -o /tmp/openlist.tar.gz && \
    tar -xzf /tmp/openlist.tar.gz -C /tmp/ && \
    mv /tmp/openlist /app/openlist && \
    chmod +x /app/openlist && \
    rm -f /tmp/openlist.tar.gz

# Download Rclone mod (wiserain fork, use TARGETARCH from Buildx)
RUN set -ex; \
    if [ "$TARGETARCH" = "amd64" ]; then RCLONE_ARCH="amd64"; \
    elif [ "$TARGETARCH" = "arm64" ]; then RCLONE_ARCH="arm64"; \
    elif [ "$TARGETARCH" = "arm" ]; then RCLONE_ARCH="arm-v7"; \
    else echo "Unsupported arch: $TARGETARCH" && exit 1; fi; \
    EFFECTIVE_URL=$(curl -fsSL -o /dev/null -w "%{url_effective}" https://github.com/wiserain/rclone/releases/latest); \
    RCLONE_TAG=$(basename "$EFFECTIVE_URL"); \
    RCLONE_ZIP="rclone-${RCLONE_TAG}-linux-${RCLONE_ARCH}.zip"; \
    echo "Downloading Rclone mod ($RCLONE_ARCH) tag: $RCLONE_TAG"; \
    curl -fsSL "https://github.com/wiserain/rclone/releases/download/${RCLONE_TAG}/${RCLONE_ZIP}" -o /tmp/rclone.zip && \
    unzip -q /tmp/rclone.zip -d /tmp/rclone_unzip && \
    mv /tmp/rclone_unzip/*/rclone /usr/bin/rclone && \
    chmod +x /usr/bin/rclone && \
    rm -rf /tmp/rclone*

# Create directories
RUN mkdir -p /app/web /app/server /data/openlist /data/rclone /var/log/nginx /opt/host

# Copy web frontend
COPY web/ /app/web/

# Copy Node.js backend
COPY --from=builder /build/server/ /app/server/

# Copy configs
COPY nginx/nginx.conf /etc/nginx/nginx.conf
COPY supervisor/supervisord.conf /etc/supervisord.conf

# Copy entrypoint
COPY entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh

# Environment variables (non-sensitive defaults)
ENV TZ=Asia/Shanghai \
    WEB_USERNAME=admin \
    OPENLIST_ADMIN_USERNAME=admin

# Data volume
VOLUME ["/data"]

# Expose port
EXPOSE 8080

ENTRYPOINT ["/entrypoint.sh"]
