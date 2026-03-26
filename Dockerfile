# Stage 1: Build
FROM node:22-slim AS builder

WORKDIR /app

# Install build dependencies for native modules
RUN apt-get update && apt-get install -y \
    build-essential \
    python3 \
    libx11-dev \
    libxkbfile-dev \
    libsecret-1-dev \
    && rm -rf /var/lib/apt/lists/*

# Copy package files
COPY package.json package-lock.json .npmrc ./

# Install dependencies
RUN npm install --legacy-peer-deps

# Copy source code
COPY tsconfig.json tsconfig.main.json tsconfig.renderer.json ./
COPY webpack.renderer.config.mjs ./
COPY app/ app/
COPY renderer/ renderer/
COPY index.html terminal.html ./

# Build the application
RUN npm run build

# Stage 2: Production output
FROM node:22-slim AS production

WORKDIR /app

RUN apt-get update && apt-get install -y \
    libx11-6 \
    libxkbfile1 \
    libsecret-1-0 \
    && rm -rf /var/lib/apt/lists/*

# Copy package files and install production deps only
COPY package.json package-lock.json .npmrc ./
RUN npm install --legacy-peer-deps --omit=dev

# Copy built artifacts from builder
COPY --from=builder /app/app/dist app/dist/
COPY --from=builder /app/renderer/dist renderer/dist/
COPY --from=builder /app/index.html ./
COPY --from=builder /app/terminal.html ./

# Electron needs display access -- set DISPLAY for X11 forwarding
ENV DISPLAY=:0

CMD ["npx", "electron", "app/dist/main.js"]
