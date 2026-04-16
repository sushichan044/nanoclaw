# NanoClaw Agent Container
# Runs Claude Agent SDK in isolated Linux VM with browser automation

FROM node:24-slim

# Enable pnpm via corepack
ENV PNPM_HOME="/pnpm"
ENV PATH="$PNPM_HOME:$PATH"
RUN corepack enable pnpm

# Install system dependencies for Chromium
RUN apt-get update && apt-get install -y \
    chromium \
    fonts-liberation \
    fonts-noto-cjk \
    fonts-noto-color-emoji \
    libgbm1 \
    libnss3 \
    libatk-bridge2.0-0 \
    libgtk-3-0 \
    libx11-xcb1 \
    libxcomposite1 \
    libxdamage1 \
    libxrandr2 \
    libasound2 \
    libpangocairo-1.0-0 \
    libcups2 \
    libdrm2 \
    libxshmfence1 \
    curl \
    git \
    && rm -rf /var/lib/apt/lists/*

# Set Chromium path for agent-browser
ENV AGENT_BROWSER_EXECUTABLE_PATH=/usr/bin/chromium
ENV PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH=/usr/bin/chromium

# Install agent-browser, claude-code, and QMD globally
RUN --mount=type=cache,id=pnpm,target=/pnpm/store pnpm add -g agent-browser @anthropic-ai/claude-code @tobilu/qmd

# Set up pnpm workspace at /ws so @nanoclaw/agent-core resolves correctly
WORKDIR /ws

# Copy workspace root config files for package resolution
COPY pnpm-workspace.yaml ./
COPY packages/agent-core/package.json ./packages/agent-core/package.json
COPY packages/agent-core/pnpm-lock.yaml ./packages/agent-core/pnpm-lock.yaml
COPY container/agent-runner/package.json ./container/agent-runner/package.json
COPY container/agent-runner/pnpm-lock.yaml ./container/agent-runner/pnpm-lock.yaml

# Install dependencies for agent-runner (workspace-aware)
RUN --mount=type=cache,id=pnpm,target=/pnpm/store \
    pnpm --filter nanoclaw-agent-runner install --frozen-lockfile

# Install build dependencies for agent-core before compiling it
RUN --mount=type=cache,id=pnpm,target=/pnpm/store \
    pnpm --filter @nanoclaw/agent-core install --frozen-lockfile

# Build agent-core first (agent-runner depends on it at runtime)
COPY packages/agent-core/ ./packages/agent-core/
RUN pnpm --filter @nanoclaw/agent-core run build

# Copy agent-runner source and build
COPY container/agent-runner/ ./container/agent-runner/
RUN pnpm --filter nanoclaw-agent-runner run build

# /app is the conventional path used by entrypoint.sh
RUN ln -s /ws/container/agent-runner /app

# Create workspace directories
RUN mkdir -p /workspace/group /workspace/global /workspace/extra /workspace/ipc/messages /workspace/ipc/tasks /workspace/ipc/input

# Create entrypoint script
# Container input (prompt, group info) is passed via stdin JSON.
# Credentials are injected by the host's credential proxy — never passed here.
# Follow-up messages arrive via IPC files in /workspace/ipc/input/
RUN printf '#!/bin/bash\nset -e\ncd /app && npx tsc --outDir /tmp/dist 2>&1 >&2\nln -s /app/node_modules /tmp/dist/node_modules\nchmod -R a-w /tmp/dist\ncat > /tmp/input.json\nnode /tmp/dist/index.js < /tmp/input.json\n' > /app/entrypoint.sh && chmod +x /app/entrypoint.sh

# Set ownership to node user (non-root) for writable directories
RUN chown -R node:node /workspace && chmod 777 /home/node

# Switch to non-root user (required for --dangerously-skip-permissions)
USER node

# Set working directory to group workspace
WORKDIR /workspace/group

# Entry point reads JSON from stdin, outputs JSON to stdout
ENTRYPOINT ["/app/entrypoint.sh"]
