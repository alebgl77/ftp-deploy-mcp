# Minimal image for running ftp-deploy-mcp (stdio MCP server).
# Mount or bake your ftp-servers.json and point FTP_MCP_CONFIG at it, e.g.:
#   docker run -i -v $(pwd)/ftp-servers.json:/config/ftp-servers.json \
#     -e FTP_MCP_CONFIG=/config/ftp-servers.json ftp-deploy-mcp
FROM node:22-alpine
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY src ./src
ENTRYPOINT ["node", "src/index.js"]
