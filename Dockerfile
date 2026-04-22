FROM node:20-alpine

# Install build tools for native dependencies (better-sqlite3)
RUN apk add --no-cache python3 make g++

WORKDIR /app

# Enable corepack so the correct Yarn version is used
RUN corepack enable

# Copy dependency files first for better layer caching
COPY package.json yarn.lock .yarnrc.yml ./
RUN yarn install --frozen-lockfile

# Copy source and build
COPY . .
RUN yarn build

# Ensure the SQLite data directory exists
RUN mkdir -p /app/data

EXPOSE 3000

CMD ["yarn", "start"]
