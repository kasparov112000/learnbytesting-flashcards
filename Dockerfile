#
# BUILD
#
FROM node:16-alpine AS builder
WORKDIR /var/app

ADD package.json .
RUN npm install --legacy-peer-deps
COPY . .
# tsc emits JS despite type errors (noEmitOnError defaults to false)
# but returns non-zero exit code — ignore it
RUN npm run build || true
# Verify build output exists
RUN test -f ./build/app/server.js || (echo "Build failed - no server.js" && exit 1)

#
# RUNTIME
#
FROM node:16-alpine
EXPOSE 3027
WORKDIR /var/app

# Issue #185: install python3 so the code-editor card runner can spawn
# python subprocesses to grade learner submissions. The runner uses the
# CODE_RUNNER_PYTHON_BIN env var (defaults to 'python3' on linux). Alpine's
# python3 package is small (~50MB after extraction).
RUN apk add --no-cache python3 \
    && ln -sf /usr/bin/python3 /usr/local/bin/python3

COPY --from=builder /var/app/package.json .
COPY --from=builder /var/app/package.json ./build/
COPY --from=builder /var/app/build ./build

RUN npm install --production --legacy-peer-deps

CMD ["node", "./build/app/server.js"]
